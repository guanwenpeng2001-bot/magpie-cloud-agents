import { emulate } from "../lib/emulate.mjs"
import { chatError, FollowupRejected } from "../lib/errors.mjs"
import { fetchWithTimeout } from "../lib/http.mjs"
import { sessionOf, SESSION_HEADER } from "../lib/sessions.mjs"

const ID = "devin-cloud"
const NAME = "Devin Cloud"
const BASE = "https://devin-cloud.cloud-agents.invalid/v1"
const MODELS = { "devin-session": { name: "Devin session", tool_call: false, reasoning: false } }
const credentialOf = auth => auth?.type === "api" && typeof auth.key === "string" && auth.key.trim() ? { type: "api", key: auth.key } : null

export function makeDevinDriver(options = {}) {
  const base = (options.apiBase?.[ID] ?? "https://api.devin.ai").replace(/\/$/, "")
  const rejectedRuns = new WeakMap()
  function rejectFollowup(run, signal, message) {
    if (signal) rejectedRuns.set(signal, run.url || run.ref)
    throw new FollowupRejected(message)
  }
  async function call(credential, path, signal, body) {
    try {
      const response = await fetchWithTimeout(base + "/v1/sessions" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${credential.key}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal,
      })
      return await response.json()
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      if (error.status === 401 || error.status === 403) throw chatError(401, error.message, "expired")
      if (error.status === 429) {
        error.message += ` — Devin rate limited — try again${error.retryAfter == null ? " later" : ` after ${error.retryAfter}`}`
        throw error
      }
      if (error.status) throw error
      throw new Error(`can't reach ${new URL(base).host}: ${error.message}`)
    }
  }
  function result(session, run) {
    const last = Array.isArray(session.messages) ? session.messages.findLast(message => message?.type !== "user_message") : undefined
    let text = typeof last?.message === "string" && last.message.trim() ? last.message
      : session.structured_output != null ? JSON.stringify(session.structured_output)
      : `Devin finished the session without writing a reply — see ${run.url || run.ref}`
    if (session.status_enum === "blocked") text += `\n\nDevin is waiting for input — continue at ${run.url || run.ref}`
    if (session.pull_request?.url) text += `\n\nPull request: ${session.pull_request.url}`
    return text
  }
  return {
    id: ID, name: NAME, staticModels: MODELS,
    async create(credential, { prompt }, signal) {
      const body = { prompt, title: "magpie: " + prompt.slice(0, 60), tags: ["magpie"] }
      if (options.devinCloud?.maxAcuLimit != null && options.devinCloud.maxAcuLimit !== 0) body.max_acu_limit = options.devinCloud.maxAcuLimit
      const session = await call(credential, "", signal, body)
      if (typeof session?.session_id !== "string" || !session.session_id) throw chatError(502, "Devin create returned no session id")
      const previous = signal && rejectedRuns.get(signal)
      if (signal) rejectedRuns.delete(signal)
      return { ref: session.session_id, url: session.url, ...(previous ? { announcement: `Devin follow-up moved from ${previous} to ${session.url || session.session_id}` } : {}) }
    },
    async followUp(credential, run, texts, signal) {
      let response
      try { response = await call(credential, `/${encodeURIComponent(run.ref)}/message`, signal, { message: texts.join("\n\n") }) }
      catch (error) {
        if (signal?.aborted) throw signal.reason
        if (error.status) rejectFollowup(run, signal, error.message)
        throw error
      }
      if (response?.detail != null) rejectFollowup(run, signal, String(response.detail))
      return run
    },
    async poll(credential, run, signal) {
      let session
      try { session = await call(credential, `/${encodeURIComponent(run.ref)}`, signal) }
      catch (error) {
        if (signal?.aborted) throw signal.reason
        if (error.status && error.status !== 401 && error.status !== 429) throw chatError(502, `${NAME} run failed: ${error.message} — ${run.url || run.ref}`)
        throw error
      }
      const announcement = run.announcement
      delete run.announcement
      if (session.status_enum === "expired") return { state: "expired", progress: announcement || session.status || "expired" }
      if (["finished", "blocked"].includes(session.status_enum)) return { state: "succeeded", text: result(session, run), ...(announcement ? { progress: announcement } : {}) }
      return { state: "running", progress: announcement || session.status_enum || session.status || undefined }
    },
  }
}

export function makeDevinCloud(options = {}) {
  return {
    auth: {
      provider: ID,
      maxConcurrency: 4,
      async loader(getAuth) {
        if (!credentialOf(await getAuth())) return {}
        return { baseURL: BASE, fetch: emulate(makeDevinDriver(options), async () => credentialOf(await getAuth()), options) }
      },
      methods: [{ type: "api", label: "Devin API key", placeholder: "apk_user_… (app.devin.ai → Settings → API)" }],
    },
    async config(config) {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      config.provider[ID] = { name: NAME, npm: "@ai-sdk/openai-compatible", api: BASE, ...was, models: { ...MODELS, ...(was.models ?? {}) } }
    },
    provider: { id: ID, async models(provider) { return provider.models } },
    async "chat.headers"(input, output) {
      if (input?.model?.providerID !== ID && input?.provider?.info?.id !== ID) return
      const session = sessionOf(input)
      if (session) output.headers[SESSION_HEADER] = session
    },
  }
}
