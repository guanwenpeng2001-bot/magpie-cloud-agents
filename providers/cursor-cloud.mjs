import { createHash } from "node:crypto"
import { emulate } from "../lib/emulate.mjs"
import { chatError, FollowupRejected } from "../lib/errors.mjs"
import { fetchWithTimeout } from "../lib/http.mjs"
import { sessionOf, SESSION_HEADER, SessionMap } from "../lib/sessions.mjs"

const ID = "cursor-cloud"
const NAME = "Cursor Cloud Agents"
const BASE = "https://cursor-cloud.cloud-agents.invalid/v1"
const CHAT = "@ai-sdk/openai-compatible"
const MODELS = {
  "composer-2": { name: "Composer 2", tool_call: false, reasoning: false },
  "claude-sonnet-4-5": { name: "Claude Sonnet 4.5", tool_call: false, reasoning: false },
}
const TERMINAL = new Set(["FINISHED", "ERROR", "CANCELLED", "EXPIRED"])
const methods = [{ type: "api", label: "Cursor user API key", placeholder: "Cursor Dashboard → API Keys (team keys aren't supported)" }]
const valid = auth => auth?.type === "api" && typeof auth.key === "string" && !!auth.key.trim()
const segment = encodeURIComponent

function agentIdFor(credential, identity, generation = 0) {
  const bytes = createHash("sha256").update(JSON.stringify([credential.key, identity.sessionKey, identity.textsHash, generation])).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = bytes.toString("hex")
  return `bc-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function* frames(body) {
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of body) {
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, "\n")
    let boundary
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = { event: "message", data: [] }
      for (const line of buffer.slice(0, boundary).split("\n")) {
        const colon = line.indexOf(":")
        const field = colon < 0 ? line : line.slice(0, colon)
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "")
        if (field === "data") frame.data.push(value)
        if (field === "event") frame.event = value
        if (field === "id" && !value.includes("\0")) frame.id = value
      }
      buffer = buffer.slice(boundary + 2)
      yield { ...frame, data: frame.data.join("\n") }
    }
  }
}

function outcome(data, run) {
  const result = typeof data?.result === "string" ? data.result : ""
  const branches = (Array.isArray(data?.git?.branches) ? data.git.branches : []).flatMap(branch => {
    const fields = [branch?.repoUrl, branch?.branch, branch?.prUrl].filter(value => typeof value === "string" && value)
    return fields.length ? [fields.join(" — ")] : []
  })
  if (data?.status === "FINISHED" || (data?.status === "ERROR" && result)) {
    const text = result || `${NAME} finished the session without writing a reply — see ${run.url || run.ref}`
    return { state: "succeeded", text: [text, ...branches, ...(data.status === "ERROR" ? ["⚠ run ended ERROR"] : [])].join("\n\n") }
  }
  if (data?.status === "EXPIRED") return { state: "expired" }
  if (["ERROR", "CANCELLED"].includes(data?.status)) return { state: "failed", progress: data.status }
  return { state: "running", progress: `Cursor run: ${data?.status ?? "unknown"}` }
}

function makeDriver(options) {
  const base = (options.apiBase?.[ID] ?? "https://api.cursor.com").replace(/\/+$/, "")
  const deadAgents = new SessionMap()
  const deadKey = (credential, ref) => createHash("sha256").update(JSON.stringify([credential.key, ref])).digest("hex")
  const pathOf = run => `/v1/agents/${segment(run.ref)}/runs/${segment(run.runId)}`
  async function request(credential, path, init = {}) {
    if (credential.key.startsWith("grok_")) throw chatError(403, "key_not_supported: Cursor Cloud Agents does not support this key type; use a Cursor user API key")
    try {
      return await fetchWithTimeout(base + path, { ...init, headers: { Authorization: "Basic " + Buffer.from(credential.key + ":").toString("base64"), ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers } })
    } catch (error) {
      if (init.signal?.aborted) throw init.signal.reason
      if (error.status === 403 && /invalid[_ -]?(api[_ -]?)?key|invalid[_ -]?token|unauthenticated|authentication[_ -]?(failed|required)|credential[_ -]?(invalid|expired)|token[_ -]?expired/i.test(error.message)) throw chatError(401, error.message)
      if (error.status === 429) error.message += ` — rate limited — try again${error.retryAfter != null ? " after " + error.retryAfter : " later"}`
      if (error.status) throw error
      throw new Error(`can't reach ${new URL(base).host}: ${error.message}`, { cause: error })
    }
  }
  const json = async (credential, path, init) => (await request(credential, path, init)).json()
  const runFrom = (agent, run) => {
    if (typeof agent?.id !== "string" || !agent.id || typeof run?.id !== "string" || !run.id) throw chatError(502, "Cursor returned no agent or run identifier")
    return { ref: agent.id, runId: run.id, url: agent.url }
  }
  const readRun = async (credential, run, signal) => outcome(await json(credential, pathOf(run), { signal }), run)
  return {
    id: ID, name: NAME, staticModels: MODELS, methods,
    async create(credential, { model, prompt, identity }, signal) {
      const body = { prompt: { text: prompt }, model: { id: model }, name: "magpie: " + prompt.slice(0, 60) }
      let generation = 0
      let escalated = false
      if (identity?.sessionKey) {
        body.agentId = agentIdFor(credential, identity)
        if (deadAgents.get(deadKey(credential, body.agentId))) body.agentId = agentIdFor(credential, identity, ++generation)
      }
      if (options.cursorCloud?.repos !== undefined) body.repos = options.cursorCloud.repos
      for (let attempt = 0; ; attempt++) {
        try {
          const data = await json(credential, "/v1/agents", { method: "POST", body: JSON.stringify(body), signal })
          return runFrom(data.agent, data.run)
        } catch (error) {
          if (error.status === 409 && body.agentId && /agent_id_conflict/.test(error.message)) {
            if (escalated) throw error
            const data = await json(credential, "/v1/agents/" + segment(body.agentId), { signal })
            const agent = data.agent ?? data
            if (agent.status === "ARCHIVED") {
              if (generation) throw error
              deadAgents.set(deadKey(credential, body.agentId), true)
              body.agentId = agentIdFor(credential, identity, ++generation)
              escalated = true
              continue
            }
            return runFrom(agent, data.run ?? { id: agent.latestRunId })
          }
          // Only a caller-supplied agentId makes a retry safe after an uncertain POST.
          if (!body.agentId || attempt || error.status || signal?.aborted) throw error
        }
      }
    },
    async followUp(credential, run, texts, signal) {
      try {
        const data = await json(credential, `/v1/agents/${segment(run.ref)}/runs`, { method: "POST", body: JSON.stringify({ prompt: { text: texts.join("\n\n") } }), signal })
        return runFrom({ id: run.ref, url: run.url }, data.run)
      } catch (error) {
        if (error.status === 404 || /agent_archived/i.test(error.message)) {
          deadAgents.set(deadKey(credential, run.ref), true)
          throw new FollowupRejected()
        }
        if (error.status === 409 && /agent_busy/.test(error.message)) throw chatError(409, `this Cursor agent is still working on the previous request — wait for it, or cancel it at ${run.url || run.ref}`)
        if (error.status === 409) {
          const data = await json(credential, `/v1/agents/${segment(run.ref)}`, { signal })
          if ((data.agent ?? data).status === "ARCHIVED") {
            deadAgents.set(deadKey(credential, run.ref), true)
            throw new FollowupRejected()
          }
        }
        throw error
      }
    },
    poll: readRun,
    async stream(credential, run, emit, signal) {
      let lastEventId = ""
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await request(credential, pathOf(run) + "/stream", { signal, headers: { Accept: "text/event-stream", ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}) } })
          if (!response.headers.get("content-type")?.includes("text/event-stream")) { await response.body?.cancel(); return null }
          for await (const frame of frames(response.body)) {
            if (frame.id !== undefined) lastEventId = frame.id
            let data
            try { data = JSON.parse(frame.data) } catch { data = frame.data }
            const status = typeof data === "string" ? data : data?.status
            if (frame.event === "done" || frame.event === "error" || (frame.event === "status" && TERMINAL.has(status))) return await readRun(credential, run, signal)
            if (frame.event === "status" && typeof status === "string") emit(`Cursor run: ${status}`)
          }
        } catch (error) {
          if (signal?.aborted || error.status || attempt === 2) throw error
        }
      }
      return null
    },
    async cancel(credential, run) {
      try { await request(credential, pathOf(run) + "/cancel", { method: "POST", signal: AbortSignal.timeout(5000) }) }
      catch (error) { if (error.status !== 409 || !/run_not_cancellable/.test(error.message)) throw error }
    },
    async liveModels(credential, signal) {
      try {
        const data = await json(credential, "/v1/models", { signal })
        const rows = Array.isArray(data) ? data : Array.isArray(data?.models) ? data.models : []
        const models = Object.fromEntries(rows.flatMap(row => {
          const id = [row?.id, row?.model, row?.name].find(value => typeof value === "string" && value)
          return id ? [[id, { id, name: typeof row.name === "string" && row.name ? row.name : id, capabilities: { toolcall: false, reasoning: false } }]] : []
        }))
        return Object.keys(models).length ? models : null
      } catch (error) {
        if (error.status === 401 || error.status === 403 || signal?.aborted) throw error
        return null
      }
    },
  }
}

export function makeCursorCloud(options = {}) {
  const driver = makeDriver(options)
  return {
    auth: {
      provider: ID, maxConcurrency: 4, methods,
      async loader(getAuth) {
        if (!valid(await getAuth())) return {}
        return { baseURL: BASE, fetch: emulate(driver, async () => {
          const auth = await getAuth()
          return valid(auth) ? { type: "api", key: auth.key } : null
        }, options) }
      },
    },
    async config(config) {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      config.provider[ID] = { name: NAME, npm: CHAT, api: BASE, ...was, models: { ...MODELS, ...(was.models ?? {}) } }
    },
    async "chat.headers"(input, output) {
      if (input?.model?.providerID !== ID && input?.provider?.info?.id !== ID) return
      const session = sessionOf(input)
      if (session) output.headers[SESSION_HEADER] = session
    },
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        if (!valid(auth)) return provider.models
        const live = await driver.liveModels(auth)
        return live ? { ...provider.models, ...live } : provider.models
      },
    },
  }
}

export const _internal = { makeDriver }
