import { createHash } from "node:crypto"
import { emulate } from "../lib/emulate.mjs"
import { chatError, FollowupRejected } from "../lib/errors.mjs"
import { fetchWithTimeout, sleep } from "../lib/http.mjs"
import { canonical, sessionOf, SESSION_HEADER } from "../lib/sessions.mjs"

const ID = "codex-agents"
const NAME = "Codex Agents API"
const CHAT = "@ai-sdk/openai-compatible"
const BASE = "https://codex-agents.cloud-agents.invalid/v1"
const MODELS = { "gpt-6-astra": { name: "GPT-6 Astra", tool_call: false, reasoning: false } }
const METHODS = [{ type: "api", label: "OpenAI API key", placeholder: "sk-… (platform.openai.com → API keys)" }]
const hash = value => createHash("sha256").update(canonical(value)).digest("hex")
const inputOf = texts => texts.map(text => ({ role: "user", content: [{ type: "input_text", text }] }))
const credentialOf = auth => auth?.type === "api" && typeof auth.key === "string" && auth.key.trim() ? { type: "api", key: auth.key } : null
const rowsOf = value => Array.isArray(value) ? value : value?.data ?? value?.items ?? value?.turns ?? []

function textLeaves(value, selected = false) {
  if (typeof value === "string") return selected ? [value] : []
  if (Array.isArray(value)) return value.flatMap(item => textLeaves(item, selected))
  if (!value || typeof value !== "object") return []
  return Object.entries(value).flatMap(([key, child]) => textLeaves(child, /^(text|content|output_text)$/.test(key) || (selected && key === "value")))
}
function lastText(payload) {
  const rows = rowsOf(payload)
  if (!Array.isArray(rows)) return ""
  return rows.filter(item => /message|assistant/i.test(`${item?.type ?? ""} ${item?.role ?? ""}`) && item?.role !== "user")
    .map(item => textLeaves(item).filter(text => text.trim()).join("\n")).findLast(Boolean) ?? ""
}
function turnStatus(value) {
  if (!value || typeof value !== "object") return ""
  for (const [key, child] of Object.entries(value)) {
    if (/status/i.test(key) && typeof child === "string" && /complete|fail|cancel|expir/i.test(child)) return child
    if (child && typeof child === "object") { const status = turnStatus(child); if (status) return status }
  }
  return ""
}

function makeDriver(options) {
  const origin = (options.apiBase?.[ID] ?? "https://api.openai.com").replace(/\/$/, "")
  const api = origin.endsWith("/v1") ? origin : origin + "/v1"
  async function request(cred, path, { signal, body, key, stream = false } = {}) {
    try {
      return await fetchWithTimeout(api + path, {
        method: body ? "POST" : "GET", signal,
        headers: { Authorization: `Bearer ${cred.key}`, "OpenAI-Beta": "agents=v1", ...(body ? { "Content-Type": "application/json" } : {}), ...(key ? { "Idempotency-Key": key } : {}), ...(stream ? { Accept: "text/event-stream" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      if (error.status === 403) {
        let code
        try { const data = JSON.parse(error.message); code = data.error?.code ?? data.error?.type } catch {}
        if (/^(invalid_api_key|authentication_error|invalid_authentication|unauthorized)$/.test(code ?? "")) throw chatError(401, error.message, "expired")
        throw chatError(403, error.message + " — the Agents API may be plan-gated", "kept")
      }
      if (error.status === 429) error.message += ` — rate limited — try again${error.retryAfter != null ? " after " + error.retryAfter : " later"}`
      if (!error.status) error.message = `can't reach ${new URL(api).host}: ${error.message}`
      throw error
    }
  }
  const pathOf = run => `/agents/sessions/${encodeURIComponent(run.ref)}`
  async function outcome(cred, run, status, signal, detail) {
    if (/action_required/.test(status)) return { state: "failed", progress: `the agent needs an action this plugin can't perform (${detail?.required_action?.type ?? detail?.data?.required_action?.type ?? "unknown required_action"}) — open ${run.ref}` }
    if (/expir/i.test(status)) return { state: "expired" }
    if (/fail|cancel/i.test(status)) return { state: "failed", progress: `${status}${detail?.error ? ": " + JSON.stringify(detail.error) : ""}` }
    if (!/complete/i.test(status)) return { state: "running" }
    const items = await (await request(cred, pathOf(run) + "/items?order=asc&limit=100", { signal })).json()
    return { state: "succeeded", text: lastText(items) || `${NAME} turn ${status} without a message-shaped reply — session ${run.ref}` }
  }
  return {
    id: ID, name: NAME, staticModels: MODELS, methods: METHODS,
    async liveModels(cred, signal) {
      try {
        const payload = await (await request(cred, "/models", { signal })).json()
        const rows = rowsOf(payload)
        if (!Array.isArray(rows)) return null
        const entries = rows.filter(model => typeof model?.id === "string" && /astra|sol|terra/i.test(model.id)).map(model => [model.id, { id: model.id, name: model.name ?? MODELS[model.id]?.name ?? model.id, tool_call: false, reasoning: false, capabilities: { toolcall: false, reasoning: false, attachment: false, input: { text: true }, output: { text: true } } }])
        return entries.length ? Object.fromEntries(entries) : null
      } catch (error) { if (error.status === 401 || error.signIn === "expired") throw error; return null }
    },
    async create(cred, { model, prompt, identity }, signal) {
      const key = hash([hash(cred.key), identity.sessionKey, identity.turnIndex, identity.textsHash])
      const session = await (await request(cred, "/agents/sessions", { signal, key, body: { agent: { model }, input: inputOf([prompt]), ...(options.codexAgents?.environment ? { environment: options.codexAgents.environment } : {}) } })).json()
      if (typeof session?.id !== "string" || !session.id) throw chatError(502, "Agents API returned no session id")
      return { ref: session.id, identity, submissionKey: key }
    },
    async followUp(cred, run, texts, signal) {
      // The core exposes only the prior run and suffix here, not the new transcript identity.
      const key = hash([hash(cred.key), run.ref, run.submissionKey, texts])
      try {
        await request(cred, pathOf(run) + "/events", { signal, key, body: { events: [{ type: "agent.session.input.message", input: inputOf(texts) }] } })
      } catch (error) { if (error.status === 404) throw new FollowupRejected(); throw error }
      return { ...run, submissionKey: key, pollAfter: 0 }
    },
    async stream(cred, run, emit, signal) {
      for (let attempt = 0; attempt < 4; attempt++) {
        let reader
        try {
          const response = await request(cred, pathOf(run) + "/events", { signal, stream: true })
          reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ""
          for (;;) {
            const { value, done } = await reader.read()
            buffer += decoder.decode(value, { stream: !done })
            buffer = buffer.replace(/\r\n/g, "\n")
            let boundary
            while ((boundary = buffer.indexOf("\n\n")) !== -1) {
              const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
              const lines = frame.split("\n")
              const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim()
              const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")
              let payload
              try { payload = data ? JSON.parse(data) : {} } catch { continue }
              const type = payload.type ?? event
              if (["agent.session.turn.completed", "agent.session.turn.failed", "agent.session.turn.cancelled", "agent.session.failed", "agent.session.action_required"].includes(type)) return await outcome(cred, run, type, signal, payload)
              if (type) emit(type)
            }
            if (done) break
          }
        } catch (error) {
          if (signal?.aborted || error.status) throw error
        } finally { if (reader) await reader.cancel().catch(() => {}) }
      }
      return null
    },
    async poll(cred, run, signal) {
      if (run.pollAfter) await sleep(Math.max(0, run.pollAfter - Date.now()), signal)
      const payload = await (await request(cred, pathOf(run) + "/turns", { signal })).json()
      run.pollAfter = Date.now() + 10000
      const rows = Array.isArray(payload) ? payload : payload?.data ?? payload?.turns ?? payload
      const latest = Array.isArray(rows) ? rows.at(-1) : rows
      return outcome(cred, run, turnStatus(latest), signal, latest)
    },
    async cancel(cred, run) {
      await request(cred, pathOf(run) + "/events", { signal: AbortSignal.timeout(5000), key: hash([run.submissionKey, "cancel"]), body: { events: [{ type: "agent.session.input.cancel" }] } })
    },
  }
}

export function makeCodexAgents(options = {}) {
  const driver = makeDriver(options)
  return {
    auth: {
      provider: ID, maxConcurrency: 4, methods: METHODS,
      async loader(getAuth) {
        if (!credentialOf(await getAuth())) return {}
        return { baseURL: BASE, fetch: emulate(driver, async () => credentialOf(await getAuth()), options) }
      },
    },
    async config(config) {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      config.provider[ID] = { name: NAME, npm: CHAT, api: BASE, ...was, models: { ...MODELS, ...(was.models ?? {}) } }
    },
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        const cred = credentialOf(auth)
        return (cred && await driver.liveModels(cred)) || provider.models || MODELS
      },
    },
    async "chat.headers"(input, output) {
      if (input?.model?.providerID !== ID && input?.provider?.info?.id !== ID) return
      const session = sessionOf(input)
      if (session) output.headers[SESSION_HEADER] = session
    },
  }
}

export const _internal = { makeDriver }
