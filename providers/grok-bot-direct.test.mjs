import { expect, test } from "bun:test"
import { emulate } from "../lib/emulate.mjs"
import { unwrapToken, unprotect, makeTokenStore } from "./grok-bot-token.mjs"
import { makeGrokBotDirect, cursorChecksum, transcriptEntry } from "./grok-bot-direct.mjs"

const missing = "Grok Bot direct: no local Grok Bot sign-in found — install the app and sign in once (or use the app-drive sign-in instead)"
const refused = "Grok Bot direct: couldn't read the app's sealed sign-in (OS refused) — sign in to the app again, or use the app-drive mode"

async function protect(bytes) {
  const { dlopen, ptr, toArrayBuffer } = await import("bun:ffi")
  const crypt = dlopen("crypt32.dll", { CryptProtectData: { args: ["ptr", "ptr", "ptr", "ptr", "ptr", "u32", "ptr"], returns: "i32" } })
  const kernel = dlopen("kernel32.dll", { LocalFree: { args: ["ptr"], returns: "ptr" } })
  const input = Buffer.alloc(16), output = Buffer.alloc(16)
  input.writeUInt32LE(bytes.length)
  input.writeBigUInt64LE(BigInt(ptr(bytes)), 8)
  try {
    if (!crypt.symbols.CryptProtectData(ptr(input), null, null, null, null, 1, ptr(output))) throw new Error("synthetic fixture protection failed")
    return Buffer.from(new Uint8Array(toArrayBuffer(Number(output.readBigUInt64LE(8)), 0, output.readUInt32LE(0))))
  } finally {
    const address = Number(output.readBigUInt64LE(8))
    if (address) kernel.symbols.LocalFree(address)
    crypt.close(); kernel.close()
  }
}

async function fixture() {
  const key = crypto.getRandomValues(new Uint8Array(32))
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const token = new TextEncoder().encode("synthetic-test-credential")
  const imported = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"])
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, imported, token))
  const sealed = await protect(key)
  const localState = { os_crypt: { encrypted_key: Buffer.concat([Buffer.from("DPAPI"), sealed]).toString("base64") } }
  const account = { "cursor-access-token": Buffer.concat([Buffer.from("v10"), nonce, encrypted]).toString("base64") }
  const secrets = { "cursor-machine-id": "synthetic-machine", "cursor-accounts": JSON.stringify({ active: "fixture", accounts: { fixture: account } }) }
  key.fill(0)
  return { localState, secrets, token }
}

async function failure(promise, message, status, signIn) {
  let caught
  try { await promise } catch (error) { caught = error }
  expect(caught?.message).toBe(message)
  expect(caught?.status).toBe(status)
  expect(caught?.signIn).toBe(signIn)
}

test("synthetic CryptProtectData round-trip and immediate key zeroing", async () => {
  const data = await fixture()
  let key
  const result = await unwrapToken(data.localState, data.secrets, { unprotect: async bytes => (key = await unprotect(bytes)) })
  expect(Buffer.from(result.token).equals(Buffer.from(data.token))).toBe(true)
  expect(key.every(byte => byte === 0)).toBe(true)
  result.token.fill(0); data.token.fill(0)
})

function reader(data) {
  return { profilePath: "synthetic-profile", readFile: async path => {
    if (!path.startsWith("synthetic-profile")) throw new Error("real profile access forbidden")
    return JSON.stringify(path.endsWith("Local State") ? data.localState : data.secrets)
  } }
}

for (const name of ["wrong DPAPI prefix", "truncated DPAPI", "invalid base64", "missing key", "malformed accounts", "missing machine", "wrong v10 prefix", "truncated v10", "bad GCM tag", "DPAPI refusal"]) test(`unwrap ${name}: exact 401 kept`, async () => {
  const data = await fixture()
  const accounts = JSON.parse(data.secrets["cursor-accounts"])
  const bytes = Buffer.from(accounts.accounts.fixture["cursor-access-token"], "base64")
  if (name === "wrong DPAPI prefix") data.localState.os_crypt.encrypted_key = Buffer.from("WRONG-payload").toString("base64")
  if (name === "truncated DPAPI") data.localState.os_crypt.encrypted_key = Buffer.from("DPAPI").toString("base64")
  if (name === "invalid base64") data.localState.os_crypt.encrypted_key = "%%%"
  if (name === "missing key") data.localState = {}
  if (name === "missing machine") delete data.secrets["cursor-machine-id"]
  if (name === "wrong v10 prefix") bytes[0] = 0
  if (name === "bad GCM tag") bytes[bytes.length - 1] ^= 255
  accounts.accounts.fixture["cursor-access-token"] = (name === "truncated v10" ? Buffer.from("v10short") : bytes).toString("base64")
  data.secrets["cursor-accounts"] = name === "malformed accounts" ? "{" : JSON.stringify(accounts)
  if (name === "DPAPI refusal") data.localState.os_crypt.encrypted_key = Buffer.concat([Buffer.from("DPAPI"), Buffer.alloc(64)]).toString("base64")
  await failure(unwrapToken(data.localState, data.secrets), refused, 401, "kept")
})

test("wrong-size and wrong-content keys are zeroed on failure", async () => {
  const data = await fixture()
  for (const length of [16, 32]) {
    const key = new Uint8Array(length).fill(7)
    await failure(unwrapToken(data.localState, data.secrets, { unprotect: async () => key }), refused, 401, "kept")
    expect(key.every(byte => byte === 0)).toBe(true)
  }
})

test("invalid plaintext is zeroed", async () => {
  const data = await fixture(), token = new Uint8Array([10, 13])
  await failure(unwrapToken(data.localState, data.secrets, { decryptBlob: async () => token }), refused, 401, "kept")
  expect(token.every(byte => byte === 0)).toBe(true)
})

test("missing profile or active account: exact 401 expired", async () => {
  const store = makeTokenStore({ profilePath: "synthetic-profile", readFile: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }) } })
  await failure(store.get(), missing, 401, "expired")
  const data = await fixture()
  data.secrets["cursor-accounts"] = JSON.stringify({ active: "absent", accounts: {} })
  await failure(unwrapToken(data.localState, data.secrets), missing, 401, "expired")
})

test("profile permission and JSON errors: exact 401 kept", async () => {
  for (const readFile of [async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }) }, async () => "{"]) {
    await failure(makeTokenStore({ profilePath: "synthetic-profile", readFile }).get(), refused, 401, "kept")
  }
})

test("cached token is zeroed on replacement and teardown", async () => {
  const data = await fixture(), store = makeTokenStore(reader(data))
  const first = await store.get()
  expect(await store.get() === first).toBe(true)
  const second = await store.get(true)
  expect(first.token.every(byte => byte === 0)).toBe(true)
  expect(second.token.some(byte => byte !== 0)).toBe(true)
  store.dispose()
  expect(second.token.every(byte => byte === 0)).toBe(true)
  await failure(store.get(), refused, 401, "kept")
})

test("dispose during derivation clears pending token", async () => {
  const data = await fixture(), token = new Uint8Array([65, 66])
  let release, entered
  const started = new Promise(resolve => { entered = resolve })
  const store = makeTokenStore({ ...reader(data), decryptBlob: async () => { entered(); await new Promise(resolve => { release = resolve }); return token } })
  const pending = store.get()
  await started; store.dispose(); release()
  await failure(pending, refused, 401, "kept")
  expect(token.every(byte => byte === 0)).toBe(true)
})

function harness(respond = () => ({ agents: [] }), options = {}, extra = {}) {
  const calls = [], rotations = []
  const token = new TextEncoder().encode("synthetic-request-credential")
  const store = { async get(refresh) { rotations.push(refresh); return { token, machineId: "fixture-machine" } }, dispose() { token.fill(0) } }
  const driver = makeGrokBotDirect({}, options, {
    store, now: () => 1723456789000, randomUUID: () => "fixture-session", ...extra,
    fetch: async (url, init) => {
      const snapshot = { url, ...init, headers: { ...init.headers }, body: JSON.parse(init.body) }
      calls.push(snapshot)
      const result = await respond(url.split("/").at(-1), snapshot, calls.length)
      return result instanceof Response ? result : Response.json(result)
    },
  })
  return { driver, calls, rotations, token }
}
const entry = (seq, body) => ({ seq: String(seq), updatedSeq: String(seq), entryId: `row-${seq}`, body: Buffer.from(JSON.stringify(body)).toString("base64") })
const assistant = (seq, text) => entry(seq, { kind: "send-message", message: { type: "text", content: text } })

test("checksum follows literal shipped shifts, not true big-endian", () => {
  const milliseconds = 1723456789000, timestamp = Math.floor(milliseconds / 1e6)
  const literal = new Uint8Array([timestamp >> 40 & 255, timestamp >> 32 & 255, timestamp >> 24 & 255, timestamp >> 16 & 255, timestamp >> 8 & 255, timestamp & 255])
  let seed = 165
  for (let index = 0; index < literal.length; index++) { literal[index] = (literal[index] ^ seed) + index % 256; seed = literal[index] }
  expect(cursorChecksum("fixture-machine", milliseconds)).toBe(Buffer.from(literal).toString("base64url") + "fixture-machine")
  const bigEndian = Buffer.alloc(6); bigEndian.writeUIntBE(timestamp, 0, 6)
  seed = 165
  for (let index = 0; index < bigEndian.length; index++) { bigEndian[index] = (bigEndian[index] ^ seed) + index % 256; seed = bigEndian[index] }
  expect(cursorChecksum("fixture-machine", milliseconds) === bigEndian.toString("base64url") + "fixture-machine").toBe(false)
})

test("listing URL and exact Connect headers including redirect error", async () => {
  const { driver, calls } = harness(() => ({ agents: [{ agentId: "bot-one", name: "Fixture" }] }))
  expect(await driver.verify()).toEqual([{ id: "bot-one", name: "Fixture" }])
  expect(calls[0].url).toBe("https://api2.cursor.sh/aiserver.v1.GrokBotService/ListGrokBotAgents")
  expect(calls[0].body).toEqual({}); expect(calls[0].method).toBe("POST"); expect(calls[0].redirect).toBe("error")
  expect(calls[0].headers.authorization.startsWith("Bearer ")).toBe(true)
  const { authorization, ...headers } = calls[0].headers
  expect(headers).toEqual({ "content-type": "application/json", "connect-protocol-version": "1", "x-ghost-mode": "true", "x-cursor-checksum": cursorChecksum("fixture-machine", 1723456789000), "x-cursor-client-type": "sand", "x-cursor-client-version": "0.68.1", "x-cursor-client-source": "sand-desktop" })
  driver.dispose()
})

test("host and HTTPS assertions precede credential access", async () => {
  for (const apiBase of ["https://other.invalid", "http://api2.cursor.sh", "https://api2.cursor.sh:444", "https://user@api2.cursor.sh"]) {
    const { driver, calls, rotations } = harness(undefined, {}, { apiBase })
    await failure(driver.verify(), "Grok Bot direct: request host rejected", 502, "kept")
    expect(calls.length).toBe(0); expect(rotations.length).toBe(0)
  }
})

const serverRefusal = "Grok Bot direct: the app's sign-in was refused by the server — open Grok Bot desktop once to refresh it, then retry"
test("second 401 after one re-derive: exact expired message", async () => {
  const { driver, rotations, calls } = harness(() => new Response(null, { status: 401 }))
  await failure(driver.verify(), serverRefusal, 401, "expired")
  expect(rotations).toEqual([false, true]); expect(calls.length).toBe(2)
})

test("401 retry succeeds; live single-call mode disables retry", async () => {
  const fixture = harness((method, call, count) => count === 1 ? new Response(null, { status: 401 }) : { agents: [] })
  expect(await fixture.driver.verify()).toEqual([]); expect(fixture.rotations).toEqual([false, true])
  const single = harness(() => new Response(null, { status: 401 }))
  await failure(single.driver.verify({ retryAuth: false }), serverRefusal, 401, "expired")
  expect(single.calls.length).toBe(1)
})

test("Connect rejection: vendor wording with exact 502 kept suffix", async () => {
  const { driver } = harness(() => Response.json({ message: "invalid session_id" }, { status: 400 }))
  await failure(driver.verify(), "invalid session_id — the provider's protocol table may need an update", 502, "kept")
})

test("network and timeout: exact 502 kept messages", async () => {
  const network = harness(() => { throw new Error("connection refused") })
  await failure(network.driver.verify(), "can't reach api2.cursor.sh: connection refused", 502, "kept")
  const timeout = harness(() => new Promise(() => {}), {}, { timeoutMs: 5 })
  await failure(timeout.driver.verify(), "can't reach api2.cursor.sh: upstream timed out", 502, "kept")
})

test("invalid response JSON or listing shape is rejected", async () => {
  for (const value of [new Response("{"), Response.json([]), Response.json({})]) {
    const { driver } = harness(() => value)
    let error; try { await driver.verify() } catch (caught) { error = caught }
    expect(error?.status).toBe(502); expect(error?.signIn).toBe("kept")
    expect(error?.message.endsWith("— the provider's protocol table may need an update")).toBe(true)
  }
})

test("transcript extraction rejects malformed, tool and peer rows", () => {
  expect(transcriptEntry(assistant(2, "answer"))).toEqual({ role: "assistant", text: "answer", id: "row-2" })
  expect(transcriptEntry(entry(1, { kind: "message", role: "user", content: "question" }))?.role).toBe("user")
  for (const row of [null, {}, { body: "%%%" }, { body: Buffer.from("{").toString("base64") }, entry(1, []), entry(1, { kind: "message", content: "unknown" }), entry(1, { kind: "message", role: "assistant", fromAgent: {}, content: "peer" }), entry(1, { kind: "send-message", message: { type: "tool-call", content: "tool" } })]) expect(transcriptEntry(row)).toBeNull()
})

test("send fields, two stable polls, multi-turn same bot and cancel", async () => {
  let rows = [assistant(1, "old reply")]
  const { driver, calls } = harness(method => {
    if (method === "ListGrokBotTranscriptEntries") return { entries: rows }
    if (method === "GetGrokBotSendStatus") return { status: "ACCEPTED", echoEntryId: "row-2" }
    if (method === "SendGrokBotUserMessage") return { dispatched: true }
    return {}
  })
  const run = await driver.create({}, { model: "bot-one", prompt: "question", identity: { key: "stable-identity" } })
  const sent = calls.find(call => call.url.endsWith("SendGrokBotUserMessage")).body
  expect(Object.keys(sent).sort()).toEqual(["agent_id", "message_id", "text", "sent_at_ms", "is_fork", "session_id"].sort())
  expect(sent.agent_id).toBe("bot-one"); expect(sent.text).toBe("question")
  expect(sent.sent_at_ms).toBe("1723456789000"); expect(sent.is_fork).toBe(false)
  expect((await driver.poll({}, run)).state).toBe("running")
  rows = [assistant(3, "new reply"), entry(2, { kind: "message", role: "user", content: "question" }), assistant(1, "old reply")]
  expect((await driver.poll({}, run)).state).toBe("running")
  rows[0] = assistant(3, "changed reply")
  expect((await driver.poll({}, run)).state).toBe("running")
  expect(await driver.poll({}, run)).toEqual({ state: "succeeded", text: "changed reply" })
  const next = await driver.followUp({}, run, ["next question"])
  expect(calls.filter(call => call.url.endsWith("SendGrokBotUserMessage")).at(-1).body.text).toBe("next question")
  expect(next.ref.agentId).toBe(run.ref.agentId); expect(next.ref.sessionId).toBe(run.ref.sessionId)
  expect((await driver.poll({}, next)).state).toBe("running")
  await driver.cancel({}, next)
  expect(calls.at(-1).body).toEqual({ agent_id: "bot-one", reason: "user-cancel", session_id: "fixture-session" })
  expect(calls.find(call => call.url.endsWith("GetGrokBotSendStatus")).body).toEqual({ agent_id: "bot-one", message_id: run.ref.messageId, session_id: "fixture-session" })
  expect(calls[0].body).toEqual({ agent_id: "bot-one", limit: 50, session_id: "fixture-session" })
})

test("pending cannot finish; rejected status maps to exact protocol error", async () => {
  let status = 4, rows = []
  const { driver } = harness(method => method === "GetGrokBotSendStatus" ? { status, rejection_code: "not allowed" } : method === "ListGrokBotTranscriptEntries" ? { entries: rows } : { dispatched: true })
  const run = await driver.create({}, { model: "bot-one", prompt: "question" })
  rows = [assistant(1, "reply")]
  expect((await driver.poll({}, run)).state).toBe("running"); expect((await driver.poll({}, run)).state).toBe("running")
  status = 3
  await failure(driver.poll({}, run), "not allowed — the provider's protocol table may need an update", 502, "kept")
})

test("running status prevents stable preamble completion until idle and final answer", async () => {
  let rows = [], running = true
  const { driver, calls } = harness(method => {
    if (method === "ListGrokBotTranscriptEntries") return { entries: rows }
    if (method === "GetGrokBotSendStatus") return { status: 2 }
    if (method === "ListGrokBotAgentStatuses") return { statuses: [{ agentId: "bot-one", isRunning: running }] }
    return { dispatched: true }
  })
  const run = await driver.create({}, { model: "bot-one", prompt: "question" })
  rows = [assistant(1, "Let me work that out.")]
  expect((await driver.poll({}, run)).state).toBe("running")
  expect((await driver.poll({}, run)).state).toBe("running")
  rows.push(assistant(2, "The answer is 42."))
  expect((await driver.poll({}, run)).state).toBe("running")
  running = false
  expect(await driver.poll({}, run)).toEqual({ state: "succeeded", text: "The answer is 42." })
  expect(calls.find(call => call.url.endsWith("ListGrokBotAgentStatuses")).body).toEqual({ agent_ids: ["bot-one"] })
  expect(run.url).toBe("bot-one")
})

test("non-byte injected keys yield exact 401 instead of TypeError", async () => {
  const data = await fixture()
  for (const key of [{}, new ArrayBuffer(32), "invalid"]) await failure(unwrapToken(data.localState, data.secrets, { unprotect: async () => key }), refused, 401, "kept")
})

for (const delivery of [1, 2, 3, "ACCEPTED_BOX", "ACCEPTED_TEMPORAL", "DUPLICATE"]) test(`corroborated delivery ${delivery} is accepted`, async () => {
  const { driver } = harness(method => method === "ListGrokBotTranscriptEntries" ? { entries: [] } : { delivery })
  expect((await driver.create({}, { model: "bot-one", prompt: "question" })).ref.agentId).toBe("bot-one")
})

test("bare accepted and rejected status and refused delivery", async () => {
  let rows = [], status = "ACCEPTED", delivery = "ACCEPTED_BOX"
  const { driver } = harness(method => method === "ListGrokBotTranscriptEntries" ? { entries: rows } : method === "GetGrokBotSendStatus" ? { status, rejectionCode: "denied" } : method === "ListGrokBotAgentStatuses" ? {} : { delivery })
  const run = await driver.create({}, { model: "bot-one", prompt: "question" })
  rows = [assistant(1, "answer")]
  await driver.poll({}, run)
  expect((await driver.poll({}, run)).state).toBe("succeeded")
  status = "REJECTED"
  await failure(driver.poll({}, run), "denied — the provider's protocol table may need an update", 502, "kept")
  delivery = "REFUSED"
  await failure(driver.create({}, { model: "bot-one", prompt: "question" }), "Message refused — the provider's protocol table may need an update", 502, "kept")
})

test("real core preserves folded first turn and sends only new user texts", async () => {
  let rows = [], turn = 0
  const { driver, calls } = harness(method => {
    if (method === "ListGrokBotTranscriptEntries") return { entries: rows }
    if (method === "GetGrokBotSendStatus") return { status: "ACCEPTED" }
    if (method === "ListGrokBotAgentStatuses") return { statuses: [{ agent_id: "bot-one", is_running: false }] }
    if (method === "SendGrokBotUserMessage") { rows.push(assistant(++turn, `answer ${turn}`)); return { dispatched: true } }
    return {}
  })
  const timers = { now: Date.now, random: () => 0.5, setTimeout: (callback, delay) => setTimeout(callback, delay < 15000 ? 0 : delay), clearTimeout }
  const completion = emulate(driver, async () => ({ type: "oauth", access: "derived-in-memory" }), { progress: false }, { timers })
  const post = messages => completion("https://fixture.invalid/v1/chat/completions", { headers: { "x-magpie-cloud-agents-session": "fixture-conversation" }, body: JSON.stringify({ model: "bot-one", messages, stream: false }) })
  const first = [{ role: "user", content: "FIRST QUESTION" }]
  expect((await post(first)).status).toBe(200)
  expect((await post([...first, { role: "assistant", content: "answer 1" }, { role: "user", content: "next question" }, { role: "user", content: "another detail" }])).status).toBe(200)
  const sends = calls.filter(call => call.url.endsWith("SendGrokBotUserMessage"))
  expect(sends.map(call => call.body.text)).toEqual(["Current request:\nFIRST QUESTION", "next question\n\nanother detail"])
  expect(sends[1].body.agent_id).toBe(sends[0].body.agent_id)
  driver.dispose()
})

for (const unavailable of [{}, { statuses: [{ agentId: "other", isRunning: false }] }, { statuses: [{ agentId: "bot-one", isRunning: "false" }] }, { statuses: [{ agentId: "bot-one" }] }, "network", "invalid-json"]) test(`status fallback is explicit: ${JSON.stringify(unavailable)}`, async () => {
  let rows = []
  const { driver } = harness(method => {
    if (method === "ListGrokBotTranscriptEntries") return { entries: rows }
    if (method === "GetGrokBotSendStatus") return { status: 2 }
    if (method === "ListGrokBotAgentStatuses") {
      if (unavailable === "network") throw new Error("offline")
      return unavailable === "invalid-json" ? new Response("{") : unavailable
    }
    return { dispatched: true }
  })
  const run = await driver.create({}, { model: "bot-one", prompt: "question" })
  rows = [assistant(1, "stable reply")]
  expect((await driver.poll({}, run)).progress).toContain("a paused bot's partial answer may be delivered as final")
  expect(await driver.poll({}, run)).toEqual({ state: "succeeded", text: "stable reply" })
})

test("status authentication errors cannot fall back to success", async () => {
  const { driver } = harness(method => method === "ListGrokBotAgentStatuses" ? new Response(null, { status: 401 }) : method === "ListGrokBotTranscriptEntries" ? { entries: [] } : method === "GetGrokBotSendStatus" ? { status: 2 } : { dispatched: true })
  const run = await driver.create({}, { model: "bot-one", prompt: "question" })
  await failure(driver.poll({}, run), serverRefusal, 401, "expired")
})

test("retained headers cleared and credential-bearing errors redacted", async () => {
  for (const network of [false, true]) {
    let retained
    const token = new TextEncoder().encode("synthetic-custody-value")
    const driver = makeGrokBotDirect({}, {}, { store: { get: async () => ({ token, machineId: "fixture" }), dispose: () => token.fill(0) }, fetch: async (url, init) => {
      retained = init
      const value = new TextDecoder().decode(token)
      if (network) throw new Error(`failure ${value}`)
      return Response.json({ message: `failure ${value}` }, { status: 500 })
    } })
    await failure(driver.verify(), network ? "can't reach api2.cursor.sh: failure [redacted]" : "failure [redacted] — the provider's protocol table may need an update", 502, "kept")
    expect(Object.hasOwn(retained.headers, "authorization")).toBe(false)
    expect(retained.redirect).toBe("error")
    driver.dispose()
  }
})

test("authorize returns marker only; dispose clears token", async () => {
  const { driver, token, calls } = harness()
  expect(await driver.authorize().callback()).toEqual({ type: "success", refresh: "dpapi-derive", access: "derived-in-memory", expires: 0, accountId: "grok-bot-direct" })
  expect(calls.length).toBe(0); driver.dispose()
  expect(token.every(byte => byte === 0)).toBe(true)
  await failure(driver.verify(), "Grok Bot direct: provider was disposed", 503, "kept")
})
