import { createHash, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { chatError } from "../lib/errors.mjs"
import { withTimeout } from "../lib/http.mjs"
import { makeTokenStore } from "./grok-bot-token.mjs"

const HOST = "api2.cursor.sh"
const SERVICE = "aiserver.v1.GrokBotService"
// Live replies use the full ACCEPTED_TEMPORAL, DUPLICATE and SEND_STATUS_ACCEPTED strings below; keep older wire aliases too.
const DELIVERY = {
  accepted: [1, 2, 3, "ACCEPTED_BOX", "ACCEPTED_TEMPORAL", "DUPLICATE", "GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_BOX", "GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL", "GROK_BOT_USER_MESSAGE_DELIVERY_DUPLICATE"],
  duplicate: [3, "DUPLICATE", "GROK_BOT_USER_MESSAGE_DELIVERY_DUPLICATE"],
  refused: [4, "REFUSED", "GROK_BOT_USER_MESSAGE_DELIVERY_REFUSED"],
}
const SEND_STATUS = {
  accepted: [2, "ACCEPTED", "GROK_BOT_SEND_STATUS_ACCEPTED"],
  rejected: [3, "REJECTED", "GROK_BOT_SEND_STATUS_REJECTED"],
}
// The app's transcript watch uses 90s when a live row omits stale_after_ms (bundle: `var hJ=9e4`).
const DEFAULT_STALE_AFTER_MS = 90000
const REFUSED = "Grok Bot direct: the app's sign-in was refused by the server — open Grok Bot desktop once to refresh it, then retry"
const protocolError = message => chatError(502, `${message} — the provider's protocol table may need an update`, "kept")
const record = value => value !== null && typeof value === "object" && !Array.isArray(value)
const flag = (row, camel, snake) => { const value = row[camel] ?? row[snake]; return typeof value === "boolean" ? value : undefined }
const text = (row, camel, snake) => { const value = row[camel] ?? row[snake]; return typeof value === "string" && value ? value : undefined }

export function liveActivity(row, milliseconds, seen = undefined) {
  const live = record(row.live) ? row.live : undefined
  const flat = flag(row, "isRunning", "is_running")
  if (!live) return { busy: flat === true, idle: flat === false, stale: false }
  const running = flag(live, "isRunning", "is_running")
  const subagents = flag(live, "hasRunningSubagents", "has_running_subagents")
  // Composing alone deliberately blocks completion; the app requires running && composing.
  const composing = flag(live, "isComposingMessage", "is_composing_message")
  const awaiting = record(live.awaiting)
  const handoff = text(live, "boxHandoffRequestId", "box_handoff_request_id") !== undefined
  const updatedAt = Number(live.updatedAtMs ?? live.updated_at_ms)
  const staleAfter = Number(live.staleAfterMs ?? live.stale_after_ms)
  const window = Number.isFinite(staleAfter) && staleAfter > 0 ? staleAfter : DEFAULT_STALE_AFTER_MS
  let basis = Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : undefined
  if (running === true && basis === undefined && seen) {
    const key = JSON.stringify(live)
    seen[key] ??= milliseconds
    basis = seen[key]
  }
  const stale = running === true && basis !== undefined && Math.max(0, milliseconds - basis) >= window
  const busy = (!stale && (flat === true || running === true)) || subagents === true || composing === true || awaiting || handoff
  const idle = !busy && flat === false
  return { busy, idle: idle && !stale, stale }
}

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

// Persistence filenames are the app's base32 client keys with its ".blob" extension
// (Grok Bot 0.68.1 app.asar: pSr = base32(key) + ".blob"). The app also switches oversized
// keys (encoded name over 240 chars) to a digest-framed base32 + ".kblob" name; both keys
// in play are ~94 bytes, so that branch cannot fire here and is deliberately not implemented.
function persistenceFilename(key) {
  let output = "", bits = 0, buffer = 0
  for (const byte of Buffer.from(key)) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) { bits -= 5; output += "abcdefghijklmnopqrstuvwxyz234567"[(buffer >>> bits) & 31] }
  }
  if (bits) output += "abcdefghijklmnopqrstuvwxyz234567"[(buffer << (5 - bits)) & 31]
  return output + ".blob"
}

async function selectedAgent(dependencies) {
  try {
    const profile = dependencies.profilePath ?? (process.env.APPDATA && join(process.env.APPDATA, "Grok Bot"))
    if (!profile) return undefined
    const reader = dependencies.readFile ?? readFile
    const readValue = async key => {
      const data = JSON.parse(await reader(join(profile, "sand-client-persistence", persistenceFilename(key)), "utf8"))
      return data?.schemaVersion === 1 ? data.value : undefined
    }
    const slot = await readValue("sand.client.slice.client-meta.account-slot")
    if (typeof slot !== "string" || !slot) return undefined
    // The app escapes slots with encodeURIComponent plus "." -> "%2E" (app.asar sE).
    const selection = await readValue(`sand.client.slice.account.${encodeURIComponent(slot).replaceAll(".", "%2E")}.selection.last-agent`)
    return typeof selection?.agentId === "string" ? selection.agentId : undefined
  } catch { return undefined }
}

export function makeGrokBotDirect(input, options = {}, dependencies = {}) {
  const config = options.grokBot ?? options
  const store = dependencies.store ?? makeTokenStore(dependencies)
  const fetcher = dependencies.fetch ?? globalThis.fetch
  const now = dependencies.now ?? Date.now
  const uuid = dependencies.randomUUID ?? randomUUID
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
          if (!response.ok) {
            const detail = safeMessage(typeof parsed?.message === "string" ? parsed.message : raw || `HTTP ${response.status}`, credential.token)
            const declared = Number(parsed?.status)
            throw chatError(Number.isInteger(declared) && declared >= 400 && declared <= 599 ? declared : 502, `${detail} — the provider's protocol table may need an update`, "kept")
          }
          if (!record(parsed)) throw protocolError("Invalid Connect response shape")
          return parsed
        }, signal, dependencies.timeoutMs ?? 15000)
      } catch (error) {
        if (signal?.aborted) throw signal.reason
        if (error?.status === 401 && error?.signIn === "expired") {
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
  const tail = async (agentId, signal) => {
    const result = await request("ListGrokBotTranscriptEntries", { agent_id: agentId, limit: 50 }, signal)
    if (!Array.isArray(result.entries)) throw protocolError("Invalid transcript response")
    return result.entries
  }
  const send = async (agentId, prompt, identity, signal) => {
    const baseline = await tail(agentId, signal)
    const messageId = identity?.key ? createHash("sha256").update(identity.key).digest("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5") : uuid()
    const response = await request("SendGrokBotUserMessage", { agent_id: agentId, message_id: messageId, text: prompt, sent_at_ms: String(now()), is_fork: false }, signal)
    if (response.refusal || DELIVERY.refused.includes(response.delivery)) throw protocolError(response.refusal?.message ?? "Message refused")
    if (response.dispatched !== true && !DELIVERY.accepted.includes(response.delivery)) throw protocolError("Message dispatch was not acknowledged")
    return { url: agentId, ref: { agentId, messageId }, view: { baseline: new Set(baseline.map(row => row.entryId ?? row.entry_id ?? String(row.seq))), duplicate: DELIVERY.duplicate.includes(response.delivery), stable: undefined } }
  }
  const driver = {
    id: "grok-bot", name: "Grok Bot direct", staticModels: { "app-bot": { name: "App bot", tool_call: false } },
    methods: [],
    async verify({ signal, retryAuth = true } = {}) { return list(signal, retryAuth) },
    async liveModels(credential, signal) { return Object.fromEntries((await list(signal)).map(agent => [agent.id, { name: agent.name, tool_call: false }])) },
    authorize() {
      return { url: "", method: "auto", instructions: "Reads the installed Grok Bot app's sealed sign-in in memory and sends it only to api2.cursor.sh, with redirects refused. Keys and tokens are never saved or logged; buffers are cleared after use or on teardown. Sign in to the app once on this machine first. If bot status is unavailable or a stale running row is demoted, completion falls back to transcript stability: a paused bot's partial answer may be delivered as final when its transcript stops growing. A flat idle reading is not trusted while the bot's nested live state still shows work in progress. Observed status rows contain only agentId and client, without live or is_running, so completion uses the transcript stability fallback for those rows.", callback: async () => {
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
        const selected = await selectedAgent(dependencies)
        agentId = agents.find(agent => agent.id === selected)?.id
        if (!agentId && agents.length === 1) agentId = agents[0].id
        if (!agentId) throw chatError(400, "Grok Bot direct: select a bot by its model ID, or open Grok Bot desktop and select a bot before retrying app-bot", "kept")
      }
      return send(agentId, prompt, identity, signal)
    },
    async followUp(credential, run, suffix, signal) {
      return send(run.ref.agentId, suffix.join("\n\n"), undefined, signal)
    },
    async poll(credential, run, signal) {
      const { agentId, messageId } = run.ref
      const status = await request("GetGrokBotSendStatus", { agent_id: agentId, message_id: messageId }, signal)
      if (SEND_STATUS.rejected.includes(status.status)) throw protocolError(status.rejectionCode ?? status.rejection_code ?? "Message rejected")
      let running, stale = false
      try {
        const result = await request("ListGrokBotAgentStatuses", { agent_ids: [agentId] }, signal, false)
        const matches = Array.isArray(result.statuses) ? result.statuses.filter(row => record(row) && (row.agentId ?? row.agent_id) === agentId) : []
        run.view.seen ??= {}
        const states = matches.map(row => liveActivity(row, now(), run.view.seen))
        stale = states.some(state => state.stale)
        if (states.some(state => state.busy)) running = true
        else if (states.some(state => state.idle) && states.every(state => state.idle || state.stale)) running = false
      } catch (error) {
        if (signal?.aborted) throw signal.reason
        if (error?.status === 401 || error?.signIn === "expired") throw error
      }
      const entries = await tail(agentId, signal)
      const echoId = status.echoEntryId ?? status.echo_entry_id
      const ordered = entries.filter(record).slice().sort((left, right) => {
        try { const difference = BigInt(left.seq) - BigInt(right.seq); return difference < 0n ? -1 : difference > 0n ? 1 : 0 } catch { return 0 }
      })
      const echoIndex = ordered.findIndex(row => (row.entryId ?? row.entry_id) === echoId && echoId)
      // A duplicate's baseline may already contain its answer; trust the located echo instead.
      const replay = run.view.duplicate && echoIndex >= 0
      const nextUserIndex = replay ? ordered.findIndex((row, index) => index > echoIndex && transcriptEntry(row)?.role === "user") : -1
      const candidates = ordered.filter((row, index) => (replay || !run.view.baseline.has(row.entryId ?? row.entry_id ?? String(row.seq))) && (echoIndex < 0 || index > echoIndex) && (nextUserIndex < 0 || index < nextUserIndex))
      const replies = candidates.map(transcriptEntry).filter(row => row?.role === "assistant" && row.text.trim())
      const fingerprint = JSON.stringify(ordered)
      const accepted = SEND_STATUS.accepted.includes(status.status)
      const text = replies.at(-1)?.text
      // The running text goes out as `partial` so pollWithBackoff (lib/http.mjs) forwards it and
      // the emulate layer accumulates it prefix-monotonically into content deltas. replies are
      // already trimmed, so the guard only excludes an empty transcript; a rewritten non-prefix
      // text is tolerated downstream as divergence (accepted F2 behaviour), not gated here.
      const partial = text ? { partial: text } : {}
      if (running === true) {
        run.view.stable = undefined
        return { state: "running", progress: "Grok Bot direct: the bot is still running", ...partial }
      }
      if (accepted && text && (running === false || run.view.stable === fingerprint)) return { state: "succeeded", text }
      run.view.stable = accepted && text ? fingerprint : undefined
      return { state: "running", progress: running === undefined ? `Grok Bot direct: ${stale ? "stale running status demoted" : "status unavailable"}; using transcript stability — a paused bot's partial answer may be delivered as final` : "Grok Bot direct: waiting for the bot", ...partial }
    },
    async cancel(credential, run) { await request("InterruptGrokBotAgentRun", { agent_id: run.ref.agentId, reason: "user-cancel" }) },
    dispose() { disposed = true; store.dispose() },
  }
  driver.methods = [{ type: "oauth", label: "Direct Connect protocol (reads the app's local sign-in)", authorize: driver.authorize }]
  return driver
}
