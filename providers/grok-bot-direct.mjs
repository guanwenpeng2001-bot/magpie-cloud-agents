import { createHash, randomUUID } from "node:crypto"
import { chatError } from "../lib/errors.mjs"
import { withTimeout } from "../lib/http.mjs"
import { makeTokenStore } from "./grok-bot-token.mjs"

const HOST = "api2.cursor.sh"
const SERVICE = "aiserver.v1.GrokBotService"
const REFUSED = "Grok Bot direct: the app's sign-in was refused by the server — open Grok Bot desktop once to refresh it, then retry"
const protocolError = message => chatError(502, `${message} — the provider's protocol table may need an update`, "kept")
const record = value => value !== null && typeof value === "object" && !Array.isArray(value)

export function cursorChecksum(machineId, milliseconds = Date.now()) {
  const timestamp = Math.floor(milliseconds / 1e6)
  // The shipped Number shifts wrap modulo 32; true six-byte big-endian differs.
  const bytes = new Uint8Array([timestamp >> 40 & 255, timestamp >> 32 & 255, timestamp >> 24 & 255, timestamp >> 16 & 255, timestamp >> 8 & 255, timestamp & 255])
  let seed = 165
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = (bytes[index] ^ seed) + index % 256
    seed = bytes[index]
  }
  return Buffer.from(bytes).toString("base64url") + machineId
}

export function transcriptEntry(entry) {
  if (!record(entry) || typeof entry.body !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.body)) return null
  let body
  try { body = JSON.parse(Buffer.from(entry.body, "base64").toString("utf8")) } catch { return null }
  if (!record(body)) return null
  let role, text
  if (body.kind === "message" && !body.fromAgent && !body.toAgent && !body.channel && ["user", "assistant"].includes(body.role)) {
    role = body.role; text = body.content
  } else if (body.kind === "send-message" && body.message?.type === "text" && !body.message.channel) {
    role = "assistant"; text = body.message.content
  } else return null
  if (typeof text !== "string") return null
  return { role, text, id: entry.entryId ?? entry.entry_id ?? body.id }
}

export function makeGrokBotDirect(input, options = {}, dependencies = {}) {
  const config = options.grokBot ?? options
  const store = dependencies.store ?? makeTokenStore(dependencies)
  const fetcher = dependencies.fetch ?? globalThis.fetch
  const now = dependencies.now ?? Date.now
  const uuid = dependencies.randomUUID ?? randomUUID
  const sessionId = uuid()
  let disposed = false
  const safeMessage = (message, token) => String(message).split(new TextDecoder().decode(token)).join("[redacted]")
  const request = async (method, body, signal, retryAuth = true) => {
    if (disposed) throw chatError(503, "Grok Bot direct: provider was disposed", "kept")
    const url = new URL(`${dependencies.apiBase ?? `https://${HOST}`}/${SERVICE}/${method}`)
    if (url.protocol !== "https:" || url.host !== HOST || url.username || url.password) throw chatError(502, "Grok Bot direct: request host rejected", "kept")
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted()
      const credential = await store.get(attempt > 0)
      try {
        return await withTimeout(async requestSignal => {
          const headers = {
            "content-type": "application/json", "connect-protocol-version": "1",
            "x-ghost-mode": config.ghostMode === false ? "false" : "true",
            "x-cursor-checksum": cursorChecksum(credential.machineId, now()),
            "x-cursor-client-type": "sand", "x-cursor-client-version": "0.68.1",
            "x-cursor-client-source": "sand-desktop",
            authorization: `Bearer ${new TextDecoder().decode(credential.token)}`,
          }
          let response
          try { response = await fetcher(url.href, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: requestSignal }) }
          finally { delete headers.authorization }
          if (response.status === 401) {
            await response.body?.cancel()
            throw chatError(401, REFUSED, "expired")
          }
          const raw = await response.text()
          let parsed
          try { parsed = JSON.parse(raw) } catch { if (response.ok) throw protocolError("Invalid Connect JSON response") }
          if (!response.ok) throw protocolError(safeMessage(typeof parsed?.message === "string" ? parsed.message : raw || `HTTP ${response.status}`, credential.token))
          if (!record(parsed)) throw protocolError("Invalid Connect response shape")
          return parsed
        }, signal, dependencies.timeoutMs ?? 15000)
      } catch (error) {
        if (signal?.aborted) throw signal.reason
        if (error?.status === 401) {
          if (attempt === 0 && retryAuth) continue
          throw chatError(401, REFUSED, "expired")
        }
        if (error?.status) throw error
        throw chatError(502, `can't reach api2.cursor.sh: ${safeMessage(error?.message ?? "network failure", credential.token)}`, "kept")
      }
    }
  }
  const list = async (signal, retryAuth = true) => {
    const result = await request("ListGrokBotAgents", {}, signal, retryAuth)
    if (!Array.isArray(result.agents)) throw protocolError("Invalid bot list response")
    return result.agents.filter(record).map(agent => ({ id: agent.agentId ?? agent.agent_id ?? agent.id, name: agent.name })).filter(agent => typeof agent.id === "string" && agent.id && typeof agent.name === "string")
  }
  const tail = async (agentId, session, signal) => {
    const result = await request("ListGrokBotTranscriptEntries", { agent_id: agentId, limit: 50, session_id: session }, signal)
    if (!Array.isArray(result.entries)) throw protocolError("Invalid transcript response")
    return result.entries
  }
  const send = async (agentId, session, prompt, identity, signal) => {
    const baseline = await tail(agentId, session, signal)
    const messageId = identity?.key ? createHash("sha256").update(identity.key).digest("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5") : uuid()
    const response = await request("SendGrokBotUserMessage", { agent_id: agentId, message_id: messageId, text: prompt, sent_at_ms: String(now()), is_fork: false, session_id: session }, signal)
    if (response.refusal || response.delivery === 4 || response.delivery === "REFUSED") throw protocolError(response.refusal?.message ?? "Message refused")
    if (response.dispatched !== true && ![1, 2, 3, "ACCEPTED_BOX", "ACCEPTED_TEMPORAL", "DUPLICATE"].includes(response.delivery)) throw protocolError("Message dispatch was not acknowledged")
    return { url: agentId, ref: { agentId, messageId, sessionId: session }, view: { baseline: new Set(baseline.map(row => row.entryId ?? row.entry_id ?? String(row.seq))), stable: undefined } }
  }
  const driver = {
    id: "grok-bot", name: "Grok Bot direct", staticModels: { "app-bot": { name: "App bot", tool_call: false } },
    methods: [],
    async verify({ signal, retryAuth = true } = {}) { return list(signal, retryAuth) },
    async liveModels(credential, signal) { return Object.fromEntries((await list(signal)).map(agent => [agent.id, { name: agent.name, tool_call: false }])) },
    authorize() {
      return { url: "", method: "auto", instructions: "Reads the installed Grok Bot app's sealed sign-in in memory and sends it only to api2.cursor.sh, with redirects refused. Keys and tokens are never saved or logged; buffers are cleared after use or on teardown. Sign in to the app once on this machine first. If bot status is unavailable, completion falls back to transcript stability: a paused bot's partial answer may be delivered as final.", callback: async () => {
        try {
          await store.get()
          return { type: "success", refresh: "dpapi-derive", access: "derived-in-memory", expires: 0, accountId: "grok-bot-direct" }
        } catch (error) { return { type: "failed", error: error.message } }
      } }
    },
    async create(credential, { model, prompt, identity }, signal) {
      let agentId = model
      if (!agentId || agentId === "app-bot") {
        const agents = await list(signal)
        if (agents.length !== 1) throw chatError(400, "Grok Bot direct: select a bot from the model list", "kept")
        agentId = agents[0].id
      }
      return send(agentId, sessionId, prompt, identity, signal)
    },
    async followUp(credential, run, suffix, signal) {
      return send(run.ref.agentId, run.ref.sessionId, suffix.join("\n\n"), undefined, signal)
    },
    async poll(credential, run, signal) {
      const { agentId, messageId, sessionId: session } = run.ref
      const status = await request("GetGrokBotSendStatus", { agent_id: agentId, message_id: messageId, session_id: session }, signal)
      if ([3, "REJECTED"].includes(status.status)) throw protocolError(status.rejectionCode ?? status.rejection_code ?? "Message rejected")
      let running
      try {
        const result = await request("ListGrokBotAgentStatuses", { agent_ids: [agentId] }, signal)
        const matches = Array.isArray(result.statuses) ? result.statuses.filter(row => record(row) && (row.agentId ?? row.agent_id) === agentId) : []
        const states = matches.map(row => row.isRunning ?? row.is_running)
        if (states.includes(true)) running = true
        else if (states.length && states.every(state => state === false)) running = false
      } catch (error) {
        if (signal?.aborted) throw signal.reason
        if (error?.status === 401 || error?.signIn === "expired") throw error
      }
      const entries = await tail(agentId, session, signal)
      const echoId = status.echoEntryId ?? status.echo_entry_id
      const ordered = entries.filter(record).slice().sort((left, right) => {
        try { const difference = BigInt(left.seq) - BigInt(right.seq); return difference < 0n ? -1 : difference > 0n ? 1 : 0 } catch { return 0 }
      })
      const echoIndex = ordered.findIndex(row => (row.entryId ?? row.entry_id) === echoId && echoId)
      const candidates = ordered.filter((row, index) => !run.view.baseline.has(row.entryId ?? row.entry_id ?? String(row.seq)) && (echoIndex < 0 || index > echoIndex))
      const replies = candidates.map(transcriptEntry).filter(row => row?.role === "assistant" && row.text.trim())
      const fingerprint = JSON.stringify(ordered)
      const accepted = [2, "ACCEPTED"].includes(status.status)
      const text = replies.at(-1)?.text
      if (running === true) {
        run.view.stable = undefined
        return { state: "running", progress: "Grok Bot direct: the bot is still running" }
      }
      if (accepted && text && (running === false || run.view.stable === fingerprint)) return { state: "succeeded", text }
      run.view.stable = accepted && text ? fingerprint : undefined
      return { state: "running", progress: running === undefined ? "Grok Bot direct: status unavailable; using transcript stability — a paused bot's partial answer may be delivered as final" : "Grok Bot direct: waiting for the bot" }
    },
    async cancel(credential, run) { await request("InterruptGrokBotAgentRun", { agent_id: run.ref.agentId, reason: "user-cancel", session_id: run.ref.sessionId }) },
    dispose() { disposed = true; store.dispose() },
  }
  driver.methods = [{ type: "oauth", label: "Direct Connect protocol (reads the app's local sign-in)", authorize: driver.authorize }]
  return driver
}
