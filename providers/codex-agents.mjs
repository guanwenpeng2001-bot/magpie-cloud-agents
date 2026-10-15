import { createHash } from "node:crypto"
import { emulate } from "../lib/emulate.mjs"
import { chatError, FollowupRejected } from "../lib/errors.mjs"
import { fetchWithTimeout } from "../lib/http.mjs"
import { chatHeaders } from "../lib/chat-headers.mjs"
import { canonical } from "../lib/sessions.mjs"

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
const SUCCESS = new Set(["completed", "complete", "succeeded", "finished"])
const FAILURE = new Set(["failed", "failure", "error", "cancelled", "canceled", "timed_out"])
const EXPIRED = new Set(["expired"])
const ACTION = new Set(["action_required", "requires_action"])
function answerText(item) {
  if (item?.type !== "message" || item.role !== "assistant") return ""
  if (typeof item.content === "string") return item.content.trim()
  if (!Array.isArray(item.content)) return ""
  return item.content.filter(part => (part?.type === undefined || part.type === "output_text" || part.type === "text") && typeof part?.text === "string").map(part => part.text.trim()).filter(Boolean).join("\n")
}
function lastText(payload) {
  return rowsOf(payload).map(answerText).findLast(Boolean) ?? ""
}
function turnStatus(value) {
  const status = typeof value?.status === "string" ? value.status.trim() : ""
  return new Set([...SUCCESS, ...FAILURE, ...EXPIRED, ...ACTION]).has(status) ? status : ""
}
// The vendor nests a turn's cause at turn.error on agent.session.turn.failed and at error on the standalone error event; turn rows from the poll path carry it at error.
const failureCause = payload => payload?.turn?.error ?? payload?.error
const failureReason = cause => {
  if (typeof cause?.message === "string" && cause.message) return `${typeof cause.code === "string" && cause.code ? cause.code + ": " : ""}${cause.message}`
  return cause ? JSON.stringify(cause) : ""
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
  async function readItems(cred, run, turnId, signal) {
    const pages = []
    const turn = encodeURIComponent(turnId)
    let after = ""
    for (let page = 0; page < 20; page++) {
      const path = `${pathOf(run)}/turns/${turn}/items` + `?order=asc&limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`
      const payload = await (await request(cred, path, { signal })).json()
      pages.push(...rowsOf(payload))
      if (!payload?.has_more) return pages
      if (!payload.last_id || payload.last_id === after) throw chatError(502, "Agents API item pagination did not advance")
      after = payload.last_id
    }
    throw chatError(502, "Agents API item pagination exceeded 20 pages")
  }
  async function outcome(cred, run, status, signal, detail, turnId) {
    const normalized = String(status ?? "").trim()
    if (ACTION.has(normalized)) {
      const action = detail?.required_action?.type ?? detail?.data?.required_action?.type ?? detail?.required_actions?.[0]?.type ?? detail?.data?.required_actions?.[0]?.type ?? "unknown required_action"
      return { state: "failed", progress: `the agent needs an action this plugin can't perform (${action}) — open ${run.ref}` }
    }
    if (EXPIRED.has(normalized)) return { state: "expired" }
    if (FAILURE.has(normalized)) {
      const reason = failureReason(failureCause(detail))
      return { state: "failed", progress: `${detail?.type ?? normalized}${reason ? " — " + reason : ""}` }
    }
    if (!SUCCESS.has(normalized)) return { state: "running" }
    if (typeof turnId !== "string" || !turnId) return { state: "failed", progress: "completed without a turn id — session " + run.ref }
    const text = lastText(await readItems(cred, run, turnId, signal))
    if (!text) return { state: "failed", progress: "turn " + normalized + " without a message-shaped reply — session " + run.ref }
    return { state: "succeeded", text }
  }
  return {
    id: ID, name: NAME, staticModels: MODELS, methods: METHODS,
    async liveModels(cred, signal) {
      try {
        const payload = await (await request(cred, "/models", { signal })).json()
        const rows = rowsOf(payload)
        if (!Array.isArray(rows)) return null
        const entries = rows.filter(model => typeof model?.id === "string" && /(?:^|[-_/])(?:astra|sol|terra)(?:[-_/]|$)/i.test(model.id)).map(model => [model.id, { id: model.id, name: model.name ?? MODELS[model.id]?.name ?? model.id, tool_call: false, reasoning: false, capabilities: { toolcall: false, reasoning: false, attachment: false, input: { text: true }, output: { text: true } } }])
        const live = Object.fromEntries(entries)
        return { ...MODELS, ...live }
      } catch (error) { if (error.status === 401 || error.signIn === "expired") throw error; return null }
    },
    async create(cred, { model, prompt, identity }, signal) {
      const key = hash([hash(cred.key), identity.sessionKey, identity.turnIndex, identity.textsHash])
      const session = await (await request(cred, "/agents/sessions", { signal, key, body: { agent: { model }, input: inputOf([prompt]), environment: options.codexAgents?.environment ?? { type: "openai_hosted" } } })).json()
      if (typeof session?.id !== "string" || !session.id) throw chatError(502, "Agents API returned no session id")
      return { ref: session.id, identity, submissionKey: key }
    },
    async followUp(cred, run, texts, signal) {
      // The core exposes only the prior run and suffix here, not the new transcript identity.
      const key = hash([hash(cred.key), run.ref, run.submissionKey, texts])
      try {
        await request(cred, pathOf(run) + "/events", { signal, key, body: { events: [{ type: "agent.session.input.message", input: inputOf(texts) }] } })
      } catch (error) { if (error.status === 404) throw new FollowupRejected(); throw error }
      return { ref: run.ref, identity: run.identity, submissionKey: key }
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
              const status = { "agent.session.turn.completed": "completed", "agent.session.turn.failed": "failed", "agent.session.failed": "failed", "agent.session.turn.cancelled": "cancelled", "agent.session.action_required": "action_required" }[type]
              if (status) return await outcome(cred, run, status, signal, payload, payload.turn_id ?? payload.data?.turn_id)
              if (type) {
                // Keep the event name on the progress channel and additively surface what the payload carries: the failure cause of a non-terminal error event, and an assistant message item's text as cumulative content. The assistant-item shape is inferred from the items-endpoint reader, not observed on the stream: the captured item.added frame carries only the user's message (role "user", input_text), which answerText() rejects, so this emission fires on no captured shape and is unverified live.
                emit(type)
                const reason = failureReason(failureCause(payload))
                if (reason) emit({ progress: `${type} — ${reason}` })
                const text = answerText(payload?.item)
                if (text) emit({ content: text })
              }
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
      const payload = await (await request(cred, pathOf(run) + "/turns?order=desc&limit=1", { signal })).json()
      const rows = Array.isArray(payload) ? payload : payload?.data ?? payload?.turns ?? payload
      let latest = Array.isArray(rows) ? rows[0] : rows
      if (Array.isArray(rows) && rows.length > 1) {
        const timed = rows.map(turn => ({ turn, time: turn?.created_at ?? turn?.created }))
        if (timed.some(entry => typeof entry.time !== "number" || !Number.isFinite(entry.time)))
          return { state: "failed", progress: "ambiguous turn chronology — session " + run.ref }
        timed.sort((left, right) => right.time - left.time)
        if (timed[0].time === timed[1].time)
          return { state: "failed", progress: "ambiguous turn chronology — session " + run.ref }
        latest = timed[0].turn
      }
      return outcome(cred, run, turnStatus(latest), signal, latest, latest?.turn_id ?? latest?.data?.turn_id ?? latest?.id)
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
        const live = cred && await driver.liveModels(cred)
        return live ? { ...provider.models, ...MODELS, ...live } : provider.models || MODELS
      },
    },
    "chat.headers": chatHeaders(ID),
  }
}

export const _internal = { makeDriver }
