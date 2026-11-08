// Shared driver for the managed-agents API family (currently Qoder Cloud
// Agents). The resource model — agents, environments, sessions, events — with
// event names user.message / agent.message / agent.tool_use / session.status_idle
// is shared by several vendors, so the core talks to a small vendor shim and
// stays reusable for the next API of the same shape.
import { emulate } from "./emulate.mjs"
import { chatError, FollowupRejected } from "./errors.mjs"
import { chatHeaders } from "./chat-headers.mjs"
import { SessionMap } from "./sessions.mjs"

const CHAT = "@ai-sdk/openai-compatible"
export const SELF_HOSTED_TOOLS = ["bash", "read", "glob", "grep"]

const messageEvents = texts => texts.map(text => ({ type: "user.message", content: [{ type: "text", text }] }))
export const textOfContent = content => Array.isArray(content) ? content.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("\n").trim() : typeof content === "string" ? content.trim() : ""

// SDK errors carry .status; map auth failures to the sign-in contract the core expects.
export function wrapVendorError(error) {
  if (error?.name === "AbortError" || error?.name === "TimeoutError") throw error
  const status = error?.status
  if (status === 401 || status === 403) return chatError(401, String(error.message ?? error).slice(0, 1024), "expired")
  if (typeof status === "number") {
    const mapped = chatError(status, String(error.message ?? error).slice(0, 2048))
    const after = error.headers?.get?.("retry-after")
    if (after != null) mapped.retryAfter = after
    return mapped
  }
  return error
}

export function makeManagedDriver(vendor, options) {
  const settings = options[vendor.optionKey] ?? {}
  const selfHosted = settings.selfHosted ?? null
  // Provisioned agent/environment ids are cached per credential; a SessionMap gives TTL + cap for free.
  const provisioning = new SessionMap({ ttl: 3600000, cap: 50 })
  const clients = new SessionMap({ ttl: 3600000, cap: 50 })

  const clientOf = cred => {
    const key = cred.key
    let client = clients.get(key)
    if (!client) {
      client = vendor.client(cred, options)
      clients.set(key, client)
    }
    return client
  }

  async function provision(cred, model, signal) {
    const key = cred.key + ":" + model + ":" + (selfHosted ? "self" : "cloud")
    const cached = provisioning.get(key)
    if (cached) return cached
    const client = clientOf(cred)
    const agentId = settings.agentId ?? (await vendor.ensureAgent(client, model, selfHosted, signal))
    const environmentId = settings.environmentId ?? (await vendor.ensureEnvironment(client, selfHosted, signal))
    const ids = { agentId, environmentId }
    provisioning.set(key, ids)
    return ids
  }

  // Walk events forward from a cursor, dispatching self-hosted tool calls.
  // Returns {outcome?, lastId, partial} — outcome set only on a terminal turn state.
  async function drain(cred, run, emit, signal, fromStream) {
    const client = clientOf(cred)
    let after = run.cursor
    let partial = run.partial ?? ""
    run.seen ??= new Set()
    run.answered ??= new Set()
    let awaitingAction = false
    for (let page = 0; page < 50; page++) {
      const events = fromStream ?? await vendor.listEvents(client, run.ref, after, signal)
      fromStream = null
      if (!events.length) return { lastId: after, partial, awaitingAction }
      for (const event of events) {
        signal?.throwIfAborted()
        if (event.id && run.seen.has(event.id) && event.type !== "delta") continue
        // Delta frames extend the in-flight message; their event_id points at the
        // final agent.message, so they must not move the list cursor.
        if (event.type === "delta" && event.delta?.type === "content_delta") {
          if (run.seen.has(event.event_id)) continue // replayed delta of a completed message
          if (run.deltaParent !== event.event_id) { run.deltaParent = event.event_id; partial = "" }
          const piece = event.delta.content?.text
          if (typeof piece === "string" && piece) { partial += piece; emit({ content: partial }) }
          continue
        }
        if (event.id) { after = event.id; run.seen.add(event.id) }
        const type = event.type
        if (type === "agent.message") {
          const text = textOfContent(event.content)
          // The full message supersedes any deltas streamed for it.
          if (text) { partial = text; emit({ content: partial }) }
        } else if (type === "agent.thinking") {
          emit("thinking…")
        } else if (type === "agent.tool_use" && selfHosted) {
          emit(`running ${event.name} locally`)
          try { await vendor.runLocalTool(client, run, event, selfHosted, signal) }
          catch (error) { run.seen.delete(event.id); throw error } // retry the dispatch on the next poll
          run.answered.add(event.id)
        } else if (type === "session.status_running") {
          awaitingAction = false
        } else if (type === "session.status_idle") {
          const reason = event.stop_reason?.type
          if (reason === "end_turn") {
            if (!partial) return { outcome: { state: "failed", progress: "session ended without an agent.message — session " + run.ref }, lastId: after, partial }
            return { outcome: { state: "succeeded", text: partial }, lastId: after, partial }
          }
          if (reason === "requires_action") {
            const ids = event.stop_reason?.event_ids ?? []
            // Self-hosted tool_use we already answered: the vendor resumes shortly;
            // keep waiting. Anything else (confirmations, custom tools) we can't serve.
            if (selfHosted && ids.length && ids.every(id => run.answered.has(id))) { awaitingAction = true; continue }
            return { outcome: { state: "failed", progress: `session paused on requires_action this plugin can't serve — session ${run.ref}` }, lastId: after, partial }
          }
          if (reason === "cancelled") return { outcome: { state: "failed", progress: "session was cancelled — session " + run.ref }, lastId: after, partial }
          if (reason === "retries_exhausted" || reason === "refusal") return { outcome: { state: "failed", progress: `session stopped: ${reason} — session ${run.ref}` }, lastId: after, partial }
        } else if (type === "session.status_terminated") {
          return { outcome: { state: "expired" }, lastId: after, partial }
        } else if (type === "session.error") {
          const retry = event.error?.retry_status?.type
          if (retry !== "retrying") return { outcome: { state: "failed", progress: `session.error: ${event.error?.message ?? event.error?.type ?? "unknown"}` }, lastId: after, partial }
          emit(`recovering: ${event.error?.type ?? "error"}`)
        }
      }
      if (events.length < 100) return { lastId: after, partial, awaitingAction }
    }
    throw chatError(502, "session event pagination exceeded 50 pages — session " + run.ref)
  }

  const settle = (run, result) => {
    run.cursor = result.lastId
    run.partial = result.partial
    return result.outcome
  }

  return {
    id: vendor.id, name: vendor.name, staticModels: vendor.models, methods: vendor.methods,
    async liveModels(cred, signal) {
      try { return await vendor.liveModels(clientOf(cred), signal) }
      catch (error) { const mapped = wrapVendorError(error); if (mapped.status === 401) throw mapped; return null }
    },
    async create(cred, { model, prompt, identity }, signal) {
      try {
        const client = clientOf(cred)
        const { agentId, environmentId } = await provision(cred, model, signal)
        const session = await vendor.createSession(client, { agentId, environmentId, prompt, identity }, signal)
        if (typeof session?.id !== "string" || !session.id) throw chatError(502, vendor.name + " returned no session id")
        return { ref: session.id, identity, cursor: "", partial: "", model }
      } catch (error) { throw wrapVendorError(error) }
    },
    async followUp(cred, run, texts, signal) {
      try {
        const client = clientOf(cred)
        const session = await vendor.getSession(client, run.ref, signal)
        if (session.status !== "idle") throw new FollowupRejected("session is not idle")
        await vendor.sendEvents(client, run.ref, messageEvents(texts), signal)
        return { ...run, partial: "" }
      } catch (error) {
        if (error instanceof FollowupRejected) throw error
        if (error?.status === 404 || error?.status === 409 || error?.status === 410) throw new FollowupRejected()
        throw wrapVendorError(error)
      }
    },
    async stream(cred, run, emit, signal) {
      try {
        const client = clientOf(cred)
        for await (const event of vendor.streamEvents(client, run.ref, run.cursor, signal)) {
          signal?.throwIfAborted()
          const result = await drain(cred, run, emit, signal, [event])
          const outcome = settle(run, result)
          if (outcome) return outcome
        }
        return null
      } catch (error) {
        if (signal?.aborted) throw signal.reason
        const mapped = wrapVendorError(error)
        if (mapped.status === 401) throw mapped
        return null // fall back to polling, same as codex-agents
      }
    },
    async poll(cred, run, signal) {
      try {
        const client = clientOf(cred)
        const session = await vendor.getSession(client, run.ref, signal)
        if (session.status === "terminated") return { state: "expired" }
        let progress
        const result = await drain(cred, run, update => { if (typeof update === "string" && update) progress = update }, signal)
        const outcome = settle(run, result)
        if (outcome) return outcome
        if (session.status === "idle" && result.partial && !result.awaitingAction) return { state: "succeeded", text: result.partial }
        return { state: "running", partial: result.partial || undefined, progress }
      } catch (error) { throw wrapVendorError(error) }
    },
    async cancel(cred, run) {
      try { await vendor.cancel(clientOf(cred), run.ref) } catch {}
    },
  }
}

export function managedPlugin(vendor, options = {}) {
  const driver = makeManagedDriver(vendor, options)
  const base = vendor.fakeBase
  const credentialOf = auth => auth?.type === "api" && typeof auth.key === "string" && auth.key.trim() ? { type: "api", key: auth.key } : null
  return {
    auth: {
      provider: vendor.id, maxConcurrency: options.maxConcurrency ?? 2, methods: vendor.methods,
      async loader(getAuth) {
        if (!credentialOf(await getAuth())) return {}
        return { baseURL: base, fetch: emulate(driver, async () => credentialOf(await getAuth()), options) }
      },
    },
    async config(config) {
      config.provider ??= {}
      const was = config.provider[vendor.id] ?? {}
      config.provider[vendor.id] = { name: vendor.name, npm: CHAT, api: base, ...was, models: { ...vendor.models, ...(was.models ?? {}) } }
    },
    provider: {
      id: vendor.id,
      async models(provider, { auth } = {}) {
        const cred = credentialOf(auth)
        const live = cred && await driver.liveModels(cred)
        return live ? { ...provider.models, ...vendor.models, ...live } : provider.models || vendor.models
      },
    },
    "chat.headers": chatHeaders(vendor.id),
  }
}

export const _internal = { makeManagedDriver, SELF_HOSTED_TOOLS }