import { describe, test, expect } from "bun:test"
import http from "node:http"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DotsQueue, mintToken } from "./dots-queue.mjs"

function queue(overrides = {}) {
  let time = 0
  const q = new DotsQueue({ now: () => time, ttlMs: 1000, leaseMs: 100, retentionMs: 200, capacity: 3, ...overrides })
  return { q, now: ms => { time = ms } }
}

const mcpModule = await import("./dots-mcp.mjs")

test("MCP authenticates initialize and publishes exactly four tools", async () => {
  expect(typeof mcpModule.startMcp).toBe("function")
  const token = mintToken()
  const server = await mcpModule.startMcp({ token, queue: new DotsQueue() })
  try {
    const call = body => fetch(server.url, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) })
    expect((await fetch(server.url)).status).toBe(401)
    expect((await fetch(server.url.replace("/mcp", "/else"))).status).toBe(404)
    const initialized = await (await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28" } })).json()
    expect(initialized.result.protocolVersion).toBe("2026-07-28")
    expect(initialized.result.capabilities).toEqual({ tools: {}, events: {} })
    const listed = await (await call({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json()
    expect(listed.result.tools.map(tool => tool.name)).toEqual(["list_tasks", "claim_task", "complete_task", "release_task"])
  } finally { await server.close() }
})

async function withMcp(run, options = {}) {
  const token = mintToken(), queue = new DotsQueue()
  const server = mcpModule.startMcp({ token, queue, ...options })
  const headers = { authorization: "Bearer " + token, "content-type": "application/json" }
  const call = async (method, params = {}) => (await fetch(server.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()
  try { await run({ server, queue, call, headers, token }) } finally { await server.close() }
}

test("loopback tool lifecycle preserves the lease and returns text plus structuredContent", () => withMcp(async ({ queue, call }) => {
  const task = queue.enqueue("Local integration prompt")
  const list = await call("tools/call", { name: "list_tasks", arguments: { queue: "dot", status: "queued" } })
  expect(list.result.structuredContent.tasks[0].task_id).toBe(task.id)
  const claimed = await call("tools/call", { name: "claim_task", arguments: { task_id: task.id } })
  const lease = claimed.result.structuredContent.lease_token
  expect(typeof lease).toBe("string")
  expect(claimed.result.structuredContent.task.prompt).toBe("Local integration prompt")
  const bad = await call("tools/call", { name: "complete_task", arguments: { task_id: task.id, lease_token: mintToken(), result: { content: "bad" } } })
  expect(bad.result.isError).toBe(true)
  const release = await call("tools/call", { name: "release_task", arguments: { task_id: task.id, lease_token: lease, retry: true, error: "retry" } })
  expect(release.result.structuredContent.task.status).toBe("queued")
  const again = await call("tools/call", { name: "claim_task", arguments: {} })
  const result = await call("tools/call", { name: "complete_task", arguments: { task_id: task.id, lease_token: again.result.structuredContent.lease_token, result: { content: "Local integration answer" } } })
  expect(result.result.structuredContent.task.status).toBe("completed")
  expect(result.result.structuredContent.task.result).toEqual({ content: "Local integration answer" })
  expect(JSON.parse(result.result.content[0].text)).toEqual(result.result.structuredContent)
}))

test("batch, SSE Accept, capability URL and stateless Mcp-Session-Id", () => withMcp(async ({ server, headers, token }) => {
  const response = await fetch(server.url + "/" + token, { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream", "Mcp-Session-Id": "ignored" }, body: JSON.stringify([{ jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 5, method: "ping" }]) })
  expect(await response.json()).toEqual([{ jsonrpc: "2.0", id: 5, result: {} }])
  expect(response.headers.has("Mcp-Session-Id")).toBe(false)
  const notification = await fetch(server.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "claim_task" } }) })
  expect(notification.status).toBe(202)
}))

test("MCP rejects invalid tool arguments, origin and over-limit bodies", () => withMcp(async ({ call, server, headers }) => {
  const invalid = await call("tools/call", { name: "release_task", arguments: { task_id: "task", lease_token: mintToken(), retry: "false" } })
  expect(invalid.result.isError).toBe(true)
  expect((await fetch(server.url, { method: "POST", headers: { ...headers, origin: "https://untrusted.invalid" }, body: "{}" })).status).toBe(403)
  expect((await fetch(server.url, { method: "POST", headers, body: "x".repeat(262145) })).status).toBe(413)
}))

test("MCP rate cap returns 429 and retry-after", () => withMcp(async ({ server }) => {
  expect((await fetch(server.url)).status).toBe(401)
  const limited = await fetch(server.url)
  expect(limited.status).toBe(429)
  expect(limited.headers.get("retry-after")).toBe("60")
}, { ratePerMinute: 1 }))

test("MCP refuses non-loopback bind", () => {
  expect(() => mcpModule.startMcp({ token: mintToken(), queue: new DotsQueue(), hostname: "0.0.0.0" })).toThrow("127.0.0.1")
})

test("events subscription verifies challenge, HMAC signs enqueue, renews and expires", async () => {
  const { createHmac } = await import("node:crypto")
  let time = 0
  const secret = mcpModule.mintSigningSecret(), captured = []
  const transport = async (url, body, headers) => {
    const wanted = createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(headers["webhook-id"] + "." + headers["webhook-timestamp"] + "." + body).digest("base64")
    expect(headers["webhook-signature"] === "v1," + wanted).toBe(true)
    const data = JSON.parse(body)
    captured.push(data)
    return { status: 200, body: JSON.stringify({ challenge: data.challenge }) }
  }
  await withMcp(async ({ call, queue, server }) => {
    const params = { name: "task.available", arguments: { queue: "dot" }, delivery: { mode: "webhook", url: "https://callback.invalid/events", secret }, ttlMs: 1000 }
    const subscription = await call("events/subscribe", params)
    expect(subscription.result.refreshBefore).toBe("1970-01-01T00:00:01.000Z")
    expect(server.subscriptionState()).toBe("ready")
    const task = queue.enqueue("event prompt")
    await server.drain()
    expect(captured[1].name).toBe("task.available")
    expect(captured[1].data).toEqual({ task_id: task.id, queue: "dot", status: "queued", revision: 1 })
    time = 1001
    expect(server.subscriptionState()).toBe("subscription lapsed")
    expect((await call("events/subscribe", params)).result.id).toBe(subscription.result.id)
    expect(server.subscriptionState()).toBe("ready")
    await call("events/unsubscribe", params)
    expect(server.subscriptionState()).toBe("subscription lapsed")
  }, { transport, now: () => time })
})

test("failed callback challenge is never stored and dead deliveries lapse", async () => {
  let accept = false
  await withMcp(async ({ call, server, queue }) => {
    const params = { name: "task.available", arguments: { queue: "dot" }, delivery: { mode: "webhook", url: "https://callback.invalid/events", secret: mcpModule.mintSigningSecret() } }
    expect((await call("events/subscribe", params)).error.code).toBe(-32015)
    expect(server.subscriptionState()).toBe("subscription lapsed")
    accept = true
    expect((await call("events/subscribe", params)).result.id.startsWith("sub_")).toBe(true)
    queue.enqueue("failure")
    await server.drain()
    expect(server.subscriptionState()).toBe("subscription lapsed")
  }, { transport: async (_url, body) => ({ status: JSON.parse(body).type === "verification" ? 200 : 410, body: accept ? JSON.stringify({ challenge: JSON.parse(body).challenge }) : "{}" }) })
})

test("webhooks reject private, mixed DNS and redirect URLs before opening a connection", async () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "fc00::1", "2001:db8::1"]) expect(mcpModule.publicAddress(address)).toBe(false)
  for (const address of ["8.8.8.8", "2606:4700:4700::1111"]) expect(mcpModule.publicAddress(address)).toBe(true)
  await expect(mcpModule.deliverWebhook("https://callback.invalid/events", "{}", {}, { resolver: async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }], request: () => { throw new Error("must not connect") } })).rejects.toThrow("non_public_address")
  expect(() => mcpModule.validateCallbackUrl("http://127.0.0.1")).toThrow("invalid_url")
})

const tunnelModule = await import("./dots-tunnel.mjs").catch(() => ({}))

test("tunnel parser accepts only allocated HTTPS quick-tunnel origins", () => {
  expect(typeof tunnelModule.parseTunnelUrl).toBe("function")
  expect(tunnelModule.parseTunnelUrl("INF https://synthetic-dots.trycloudflare.com | ready")).toBe("https://synthetic-dots.trycloudflare.com")
  expect(tunnelModule.parseTunnelUrl("https://synthetic.trycloudflare.com.evil.invalid")).toBeNull()
  expect(tunnelModule.parseTunnelUrl("http://synthetic.trycloudflare.com")).toBeNull()
})

function fakeTunnelScript(url, exitAfterMs = 0) {
  return `setInterval(() => console.log("INF |  https://${url} |"), 20);${exitAfterMs ? `setTimeout(() => process.exit(0), ${exitAfterMs})` : ""}`
}
async function withTunnel(run, { script, checkStatus = 401, url = "synthetic-dots.trycloudflare.com", ...options } = {}) {
  let server
  const directory = await mkdtemp(join(tmpdir(), "dots-tunnel-"))
  const fetcher = async () => ({ status: checkStatus })
  const exitAfterMs = options.exitAfterMs
  const command = [process.execPath, "-e", script ?? fakeTunnelScript(url, exitAfterMs)]
  const tunnel = new tunnelModule.DotsTunnel({ localUrl: "http://127.0.0.1:9", directory, command, fetch: fetcher, startupMs: 2000, backoffMs: 10, ...options })
  const states = []
  tunnel.onState = state => states.push(state)
  try { await run({ tunnel, directory, states }) } finally { await tunnel.stop(); await rm(directory, { recursive: true, force: true }) }
}

test("fake tunnel allocates a URL, health-checks it and records state", () => withTunnel(async ({ tunnel, directory, states }) => {
  expect(await tunnel.start()).toBe("https://synthetic-dots.trycloudflare.com")
  expect(tunnel.state).toBe("ready")
  const recorded = JSON.parse(await readFile(join(directory, "tunnel-state.json"), "utf8"))
  expect(recorded.publicUrl).toBe("https://synthetic-dots.trycloudflare.com")
  expect(typeof recorded.pid).toBe("number")
  expect(states).toContain("starting")
  await tunnel.check()
}))

test("health check distinguishes bridge outage from unreachable URL", async () => {
  await expect(tunnelModule.healthCheck("https://synthetic-dots.trycloudflare.com", { fetch: async () => ({ status: 502 }) })).rejects.toThrow(tunnelModule.DOTS_FAILURES.down)
  await expect(tunnelModule.healthCheck("https://synthetic-dots.trycloudflare.com", { fetch: async () => { throw new Error("network down") } })).rejects.toThrow(tunnelModule.DOTS_FAILURES.unreachable)
  await expect(tunnelModule.healthCheck("https://synthetic-dots.trycloudflare.com", { fetch: async () => ({ status: 200 }) })).rejects.toThrow(tunnelModule.DOTS_FAILURES.unreachable)
})

test("tunnel exits and restarts with backoff on a fresh URL", () => withTunnel(async ({ tunnel }) => {
  expect(await tunnel.start()).toBe("https://synthetic-dots.trycloudflare.com")
  tunnel.command = [process.execPath, "-e", fakeTunnelScript("synthetic-restarted.trycloudflare.com")]
  const scheduled = []
  tunnel.timers = { clearTimeout, setTimeout: (callback, delay) => { scheduled.push(delay); return setTimeout(callback, delay) } }
  const ready = new Promise(resolve => { tunnel.onState = state => { if (state === "ready") resolve() } })
  tunnel.child.kill()
  await ready
  expect(scheduled).toContain(10)
  expect(tunnel.publicUrl).toBe("https://synthetic-restarted.trycloudflare.com")
  expect(tunnel.rotated).toBe(true)
  await expect(tunnel.check()).rejects.toThrow(tunnelModule.DOTS_FAILURES.rotated)
}))

test("downloader verifies pinned checksum and fails closed on mismatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dots-download-"))
  try {
    const body = "synthetic tunnel binary"
    const good = createHash("sha256").update(body).digest("hex")
    let server
    const listener = http.createServer((request, response) => response.end(request.url === "/good" ? body : "corrupted"))
    await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve))
    const base = `http://127.0.0.1:${listener.address().port}`
    try {
      const fetched = await tunnelModule.ensureTunnelBinary({ directory, sourceUrl: base + "/good", expectedSha256: good, version: tunnelModule.CLOUDFLARED_VERSION })
      expect(await readFile(fetched, "utf8")).toBe(body)
      expect(fetched.startsWith(join(directory, "cloudflared-"))).toBe(true)
      await expect(tunnelModule.ensureTunnelBinary({ directory: join(directory, "mismatch"), sourceUrl: base + "/bad", expectedSha256: good })).rejects.toThrow(tunnelModule.DOTS_FAILURES.download)
      await expect(tunnelModule.ensureTunnelBinary({ directory, sourceUrl: tunnelModule.CLOUDFLARED_URL, expectedSha256: good })).rejects.toThrow(tunnelModule.DOTS_FAILURES.download)
      await expect(tunnelModule.ensureTunnelBinary({ directory, sourceUrl: base + "/good", expectedSha256: good, version: "9999.1.1" })).rejects.toThrow(tunnelModule.DOTS_FAILURES.download)
      expect(await readdir(directory)).toEqual([`cloudflared-${tunnelModule.CLOUDFLARED_VERSION}-windows-amd64.exe`])
    } finally { listener.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("Dots factory exposes a driver with create/poll and intentionally no followUp", async () => {
  const { makeDotsDriver } = await import("./dots.mjs")
  const plugin = makeDotsDriver({}, {})
  expect(typeof plugin._internal?.driver?.create).toBe("function")
  expect(plugin._internal.driver.followUp).toBeUndefined()
})

async function withProvider(run, { options = {}, handshake = true, ...overrides } = {}) {
  const { makeDotsDriver } = await import("./dots.mjs")
  let time = 0, server, token, callbackStatus = 200
  const tunnel = { state: "ready", publicUrl: "https://synthetic-dots.trycloudflare.com", rotated: false, async start() { return this.publicUrl }, async check() { if (this.rotated) throw tunnelModule.dotsFailure("rotated"); if (this.state !== "ready") throw tunnelModule.dotsFailure("down"); return true }, async stop() { this.state = "stopped" } }
  const plugin = makeDotsDriver({}, options, {
    now: () => time, handshakeTimeoutMs: 20,
    createTunnel: () => tunnel,
    startMcp: settings => { token = settings.token; server = mcpModule.startMcp({ ...settings, transport: async (_url, body) => ({ status: callbackStatus, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) }) }); return server },
    ...overrides,
  })
  const call = async (method, params = {}) => (await fetch(server.url, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()
  try {
    const flow = await plugin.auth.methods[0].authorize()
    if (handshake && server) {
      await call("initialize", { protocolVersion: "2026-07-28" })
      await call("events/subscribe", { name: "task.available", arguments: { queue: "dot" }, delivery: { mode: "webhook", url: "https://callback.invalid/events", secret: mcpModule.mintSigningSecret() } })
    }
    const result = await flow.callback()
    const auth = result.type === "success" ? { ...result, type: "oauth" } : null
    await run({ plugin, call, auth, result, flow, server, tunnel, now: value => { time = value } })
  } finally { await plugin._internal.close() }
}

test("provider sign-in observes handshake and doctor reports ready", () => withProvider(async ({ plugin, auth, result, flow }) => {
  expect(result.type).toBe("success")
  expect(auth.access).toBe("dots-local")
  expect(auth.refresh).toBe("dots-tunnel")
  expect(auth.expires).toBe(0)
  expect(flow.instructions.includes("ChatGPT → Plugins → Add → Create custom MCP server")).toBe(true)
  expect(await plugin.auth.checkin(async () => auth)).toEqual({ outcome: "done", message: "ready" })
}))

test("no Dot handshake makes sign-in fail with the exact no-Dot message", () => withProvider(async ({ result }) => {
  expect(result.type).toBe("failed")
  expect(result.error).toBe("Dots: Your ChatGPT account doesn't have Dots enabled. This provider needs a Dot on the account.")
}, { handshake: false }))

test("driver maps queued, claimed, completed and terminal failures", () => withProvider(async ({ plugin, auth, call, now }) => {
  const driver = plugin._internal.driver
  const run = await driver.create(auth, { prompt: "integration prompt" })
  expect((await driver.poll(auth, run)).state).toBe("running")
  now(1000)
  const claimed = (await call("tools/call", { name: "claim_task", arguments: { task_id: run.ref } })).result.structuredContent
  expect((await driver.poll(auth, run)).progress).toContain("waiting for the Dot (1 s) — claimed")
  await call("tools/call", { name: "complete_task", arguments: { task_id: run.ref, lease_token: claimed.lease_token, result: { content: "integration answer" } } })
  expect(await driver.poll(auth, run)).toEqual({ state: "succeeded", text: "integration answer" })
  const failed = await driver.create(auth, { prompt: "failure" })
  const lease = (await call("tools/call", { name: "claim_task", arguments: { task_id: failed.ref } })).result.structuredContent
  await call("tools/call", { name: "release_task", arguments: { task_id: failed.ref, lease_token: lease.lease_token, retry: false, error: "cannot answer" } })
  expect((await driver.poll(auth, failed)).state).toBe("failed")
  const cancelled = await driver.create(auth, { prompt: "cancel" })
  await driver.cancel(auth, cancelled)
  expect((await driver.poll(auth, cancelled)).state).toBe("failed")
}))

test("full core chat completion and fresh-fold multi-turn have no followUp", () => withProvider(async ({ plugin, auth }) => {
  const resource = plugin._internal.resources.get(auth.dot_token)
  const prompts = []
  resource.queue.onAvailable(task => {
    prompts.push(task.prompt)
    const lease = resource.queue.claim(task.id)
    resource.queue.complete(task.id, lease.lease_token, { content: "reply " + prompts.length })
  })
  const loader = await plugin.auth.loader(async () => auth)
  const messages = [{ role: "user", content: "first question" }]
  const send = async () => loader.fetch("https://dots.cloud-agents.invalid/v1/chat/completions", { method: "POST", headers: { "x-magpie-cloud-agents-session": "session-one" }, body: JSON.stringify({ model: "dot", messages }) })
  const first = await send()
  expect(first.status).toBe(200)
  expect((await first.json()).choices[0].message.content).toBe("reply 1")
  messages.push({ role: "assistant", content: "reply 1" }, { role: "user", content: "second question" })
  expect((await (await send()).json()).choices[0].message.content).toBe("reply 2")
  expect(prompts.length).toBe(2)
  expect(prompts[1]).toContain("User: first question")
  expect(prompts[1]).toContain("Assistant: reply 1")
  expect(prompts[1]).toContain("Current request:\nsecond question")
  expect(plugin._internal.driver.followUp).toBeUndefined()
}))

async function expectChatError(operation, status, message) {
  const { errorResponse } = await import("../lib/errors.mjs")
  let error
  try { await operation() } catch (caught) { error = caught }
  expect(Boolean(error)).toBe(true)
  const response = errorResponse(error)
  expect(response.status).toBe(status)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect((await response.json()).error.message).toBe(message)
}

for (const [kind, status, message] of [
  ["download", 502, "Dots: couldn't fetch the tunnel tool — check the proxy in Magpie Settings or your AV, then sign in again"],
  ["down", 502, "Dots: The Dots bridge is unreachable — the tunnel is not running. Start the tunnel or provide a public address."],
  ["unreachable", 502, "Dots: the public URL isn't answering — the tunnel is up but unreachable; check firewall/proxy"],
  ["rotated", 503, "Dots: the tunnel URL changed — copy the new one from magpie plugin login dots (re-run sign-in) into the ChatGPT connector"],
  ["lapsed", 503, "Dots: The Dot's queue subscription lapsed. Ask the Dot to re-subscribe (or re-run setup)."],
  ["noDot", 503, "Dots: Your ChatGPT account doesn't have Dots enabled. This provider needs a Dot on the account."],
  ["restarted", 502, "Dots: the bridge restarted; ask again"],
]) test(`failure message ${kind}: exact status and kept sign-in`, () => expectChatError(async () => { throw tunnelModule.dotsFailure(kind) }, status, message))

test("queued past TTL: exact 504 and kept sign-in", () => withProvider(async ({ plugin, auth, now }) => {
  const driver = plugin._internal.driver, run = await driver.create(auth, { prompt: "never claimed" })
  now(60001)
  await expectChatError(() => driver.poll(auth, run), 504, `Dots: no Dot claimed the task within 1 min (task_id ${run.ref}). Confirm the connector is added and the account has Dots; asking again rejoins it`)
}, { options: { dots: { taskTtlMinutes: 1 } } }))

test("claimed never completed: exact 504 and kept sign-in", () => withProvider(async ({ plugin, auth, call, now }) => {
  const driver = plugin._internal.driver, run = await driver.create(auth, { prompt: "never finished" })
  await call("tools/call", { name: "claim_task", arguments: { task_id: run.ref } })
  now(60001)
  await expectChatError(() => driver.poll(auth, run), 504, `Dots: the Dot took the task but didn't finish (task_id ${run.ref}); asking again rejoins/retries safely`)
}, { options: { dots: { taskTtlMinutes: 1 } } }))

test("subscription lapse and rotated URL block creates; lost task reports bridge restart", () => withProvider(async ({ plugin, auth, now, tunnel }) => {
  const driver = plugin._internal.driver
  await expectChatError(() => driver.poll(auth, { ref: "missing" }), 502, "Dots: the bridge restarted; ask again")
  now(86400001)
  await expectChatError(() => driver.create(auth, { prompt: "lapsed" }), 503, "Dots: The Dot's queue subscription lapsed. Ask the Dot to re-subscribe (or re-run setup).")
  tunnel.rotated = true
  await expectChatError(() => driver.create(auth, { prompt: "rotated" }), 503, "Dots: the tunnel URL changed — copy the new one from magpie plugin login dots (re-run sign-in) into the ChatGPT connector")
}))

test("not set up hides loader; logout stops owned bridge", () => withProvider(async ({ plugin, auth, tunnel }) => {
  expect(await plugin.auth.loader(async () => null)).toEqual({})
  let current = auth
  const loader = await plugin.auth.loader(async () => current)
  current = null
  const response = await loader.fetch("https://dots.cloud-agents.invalid/v1/chat/completions", { body: "{}" })
  expect(response.status).toBe(503)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect(tunnel.state).toBe("stopped")
}))

test("run cap 504 preserves task identity and same-content retry rejoins", () => withProvider(async ({ plugin, auth }) => {
  const loader = await plugin.auth.loader(async () => auth)
  const request = { method: "POST", body: JSON.stringify({ model: "dot", messages: [{ role: "user", content: "slow reply" }] }) }
  const response = await loader.fetch("https://dots.cloud-agents.invalid/v1/chat/completions", request)
  expect(response.status).toBe(504)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe("kept")
  const resource = plugin._internal.resources.get(auth.dot_token)
  const task = resource.queue.list().tasks[0]
  expect((await response.json()).error.message).toBe(`Dots: still waiting (task_id ${task.id}); ask again to keep waiting — the same request rejoins the task`)
  const lease = resource.queue.claim(task.id)
  resource.queue.complete(task.id, lease.lease_token, { content: "late answer" })
  const retried = await loader.fetch("https://dots.cloud-agents.invalid/v1/chat/completions", request)
  expect(retried.status).toBe(200)
  expect((await retried.json()).choices[0].message.content).toBe("late answer")
  expect(resource.queue.tasks.size).toBe(1)
}, { options: { maxRunMinutes: 0.001 } }))

test("streaming run-cap error carries the Dots rejoin instruction", () => withProvider(async ({ plugin, auth }) => {
  const loader = await plugin.auth.loader(async () => auth)
  const response = await loader.fetch("https://dots.cloud-agents.invalid/v1/chat/completions", { body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "stream timeout" }] }) })
  const body = await response.text()
  expect(body).toContain("ask again to keep waiting — the same request rejoins the task")
  expect(body).toContain('"code":504')
}, { options: { maxRunMinutes: 0.001 } }))

test("MCP handshake and task mutation notifications never execute", () => withMcp(async ({ server, headers }) => {
  const response = await fetch(server.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "initialize" }) })
  expect(response.status).toBe(202)
  expect(server.initialized).toBe(false)
}))

describe("Dots queue", () => {
  test("leases expire and requeue with a fresh lease", () => {
    const { q, now } = queue()
    const task = q.enqueue("hello")
    const first = q.claim(task.id)
    expect(first.task.status).toBe("running")
    now(101)
    expect(q.get(task.id).status).toBe("queued")
    const second = q.claim(task.id)
    expect(second.lease_token === first.lease_token).toBe(false)
    expect(() => q.complete(task.id, first.lease_token, { content: "old" })).toThrow("Lease")
    q.complete(task.id, second.lease_token, { content: "answer" })
    expect(q.get(task.id).result).toEqual({ content: "answer" })
  })

  test("tasks expire past their TTL", () => {
    const { q, now } = queue()
    const task = q.enqueue("hello")
    now(1001)
    expect(q.get(task.id).status).toBe("expired")
    expect(q.list().tasks).toEqual([])
    now(1202)
    expect(q.get(task.id)).toBeUndefined()
  })

  test("completed results stay readable, then age out", () => {
    const { q, now } = queue()
    const task = q.enqueue("hello")
    const lease = q.claim(task.id)
    q.complete(task.id, lease.lease_token, { content: "answer" })
    now(199)
    expect(q.get(task.id).result).toEqual({ content: "answer" })
    now(201)
    expect(q.get(task.id)).toBeUndefined()
  })

  test("retry release requeues, terminal release fails the task", () => {
    const { q } = queue()
    const task = q.enqueue("hello")
    const lease = q.claim(task.id)
    q.release(task.id, lease.lease_token, true, "busy")
    expect(q.get(task.id).status).toBe("queued")
    const again = q.claim(task.id)
    q.release(task.id, again.lease_token, false, "cannot answer")
    expect(q.get(task.id).status).toBe("failed")
  })

  test("enqueue notifies task.available listeners", () => {
    const { q } = queue()
    const events = []
    q.onAvailable(event => events.push(event))
    const task = q.enqueue("hello")
    expect(events).toEqual([{ ...task, error: null }])
  })

  test("capacity caps the queue", () => {
    const { q } = queue()
    for (let i = 0; i < 3; i++) q.enqueue("task " + i)
    expect(() => q.enqueue("one more")).toThrow("full")
  })

  test("claim with no id pops the oldest queued task", () => {
    const { q } = queue()
    const a = q.enqueue("first")
    q.enqueue("second")
    const lease = q.claim()
    expect(lease.task.id).toBe(a.id)
  })

  test("minted tokens are long random strings", () => {
    expect(mintToken().length).toBe(32)
    expect(mintToken() === mintToken()).toBe(false)
  })
})
