import { describe, test, expect } from "bun:test"
import http from "node:http"
import { EventEmitter } from "node:events"
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

function stubTunnelChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  child.exitCode = null; child.kills = 0
  child.kill = () => { child.kills++; child.exitCode = 1; child.emit("exit", 1) }
  return child
}

for (const initialFailure of ["network", "status"]) test(`startup retries ${initialFailure} until the public URL answers`, async () => {
  const child = stubTunnelChild()
  let probes = 0
  await withTunnel(async ({ tunnel, directory, states }) => {
    const pending = tunnel.start()
    child.stderr.emit("data", "https://synthetic-dots.trycloudflare.com\n")
    expect(await pending).toBe("https://synthetic-dots.trycloudflare.com")
    expect(probes).toBe(4)
    expect(tunnel.state).toBe("ready")
    expect(states.filter(state => state === "ready")).toHaveLength(1)
    expect(child.kills).toBe(0)
    expect(JSON.parse(await readFile(join(directory, "tunnel-state.json"), "utf8")).publicUrl).toBe(tunnel.publicUrl)
  }, { command: ["fixture"], spawnChild: () => child, startupMs: 1000, backoffMs: 5, fetch: async () => {
    if (++probes <= 3) {
      if (initialFailure === "network") throw new TypeError("not ready")
      return { status: 200 }
    }
    return { status: 401 }
  } })
})

test("startup unreachable deadline kills the child and stops probing", async () => {
  const child = stubTunnelChild()
  let probes = 0
  await withTunnel(async ({ tunnel }) => {
    const started = performance.now(), pending = tunnel.start()
    child.stderr.emit("data", "https://synthetic-dots.trycloudflare.com\n")
    await expect(pending).rejects.toThrow(tunnelModule.DOTS_FAILURES.unreachable)
    const elapsed = performance.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(70)
    expect(elapsed).toBeLessThan(250)
    expect(probes).toBeGreaterThan(1)
    expect(child.kills).toBe(1)
    await tunnel.stop()
    const stoppedProbes = probes
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(probes).toBe(stoppedProbes)
  }, { command: ["fixture"], spawnChild: () => child, startupMs: 80, backoffMs: 5, fetch: async () => { probes++; throw new TypeError("not ready") } })
})

test("startup 5xx fails as down without retrying", async () => {
  const child = stubTunnelChild()
  let probes = 0
  await withTunnel(async ({ tunnel }) => {
    const started = performance.now(), pending = tunnel.start()
    child.stderr.emit("data", "https://synthetic-dots.trycloudflare.com\n")
    await expect(pending).rejects.toThrow(tunnelModule.DOTS_FAILURES.down)
    expect(performance.now() - started).toBeLessThan(250)
    expect(probes).toBe(1)
    expect(child.kills).toBe(1)
  }, { command: ["fixture"], spawnChild: () => child, startupMs: 1000, backoffMs: 5, fetch: async () => { probes++; return { status: 502 } } })
})

test("startup stop cancels scheduled probes", async () => {
  const child = stubTunnelChild()
  let probes = 0, retryScheduled
  const scheduled = new Promise(resolve => { retryScheduled = resolve })
  await withTunnel(async ({ tunnel, states }) => {
    const pending = tunnel.start()
    const rejected = pending.catch(error => error)
    child.stderr.emit("data", "https://synthetic-dots.trycloudflare.com\n")
    await scheduled
    await tunnel.stop()
    expect((await rejected).message).toContain(tunnelModule.DOTS_FAILURES.down)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(probes).toBe(1)
    expect(tunnel.state).toBe("stopped")
    expect(states).not.toContain("ready")
  }, { command: ["fixture"], spawnChild: () => child, startupMs: 1000, backoffMs: 20,
    timers: { clearTimeout, setTimeout: (callback, delay) => { const timer = setTimeout(callback, delay); if (delay === 20) retryScheduled(); return timer } },
    fetch: async () => { probes++; throw new TypeError("not ready") },
  })
})

test("startup hung probe respects deadline and late success cannot resurrect the tunnel", async () => {
  const child = stubTunnelChild()
  let completeProbe
  await withTunnel(async ({ tunnel, directory, states }) => {
    const started = performance.now(), pending = tunnel.start()
    child.stderr.emit("data", "https://synthetic-dots.trycloudflare.com\n")
    await expect(pending).rejects.toThrow(tunnelModule.DOTS_FAILURES.unreachable)
    expect(performance.now() - started).toBeLessThan(250)
    expect(child.kills).toBe(1)
    await tunnel.stop()
    completeProbe({ status: 401 })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(tunnel.state).toBe("stopped")
    expect(states).not.toContain("ready")
    expect(await readdir(directory)).toEqual([])
  }, { command: ["fixture"], spawnChild: () => child, startupMs: 80, backoffMs: 1000,
    fetch: () => new Promise(resolve => { completeProbe = resolve }),
  })
})

test("startup old generation cannot replace a restarted tunnel", async () => {
  const children = [stubTunnelChild(), stubTunnelChild()]
  let spawned = 0, probes = 0, completeOldProbe
  await withTunnel(async ({ tunnel, states }) => {
    const pending = tunnel.start()
    const rejected = pending.catch(error => error)
    children[0].stderr.emit("data", "https://synthetic-old.trycloudflare.com\n")
    await tunnel.stop()
    expect((await rejected).message).toContain(tunnelModule.DOTS_FAILURES.down)
    const restarted = tunnel.start()
    children[1].stderr.emit("data", "https://synthetic-new.trycloudflare.com\n")
    expect(await restarted).toBe("https://synthetic-new.trycloudflare.com")
    completeOldProbe({ status: 401 })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(tunnel.publicUrl).toBe("https://synthetic-new.trycloudflare.com")
    expect(states.filter(state => state === "ready")).toHaveLength(1)
  }, { command: ["fixture"], spawnChild: () => children[spawned++], startupMs: 1000, backoffMs: 5,
    fetch: () => ++probes === 1 ? new Promise(resolve => { completeOldProbe = resolve }) : Promise.resolve({ status: 401 }),
  })
})

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
    createTunnel: config => { tunnel.knownSecrets = config.knownSecrets; return tunnel },
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
  expect(flow.url).toBe("https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt")
  expect(flow.instructions.includes("Dots has no OpenAI sign-in page")).toBe(true)
  expect(flow.instructions.includes("opens OpenAI's guide")).toBe(true)
  expect(flow.instructions.includes("Settings → Apps → Create with developer mode")).toBe(true)
  expect(flow.instructions.includes("Endpoint: https://synthetic-dots.trycloudflare.com/mcp")).toBe(true)
  expect(flow.instructions.includes("Bearer token (shown once): ")).toBe(true)
  expect(flow.instructions.includes("help.openai.com")).toBe(false)
  expect(await plugin.auth.checkin(async () => auth)).toEqual({ outcome: "done", message: "ready" })
}))

test("sign-in failure branch returns no url and keeps method auto", async () => {
  const { makeDotsDriver } = await import("./dots.mjs")
  const plugin = makeDotsDriver({}, {}, { startMcp: () => ({ url: "http://127.0.0.1:9/mcp", close: async () => {} }), createTunnel: () => { throw new Error("synthetic tunnel failure") } })
  try {
    const flow = await plugin.auth.methods[0].authorize()
    expect(flow.url).toBe("")
    expect(flow.method).toBe("auto")
    expect(flow.instructions).toBe("synthetic tunnel failure")
  } finally { await plugin._internal.close() }
})

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
  ["restarted", 502, "Dots: the bridge restarted; asking again sends it as a new task"],
]) test(`failure message ${kind}: exact status and kept sign-in`, () => expectChatError(async () => { throw tunnelModule.dotsFailure(kind) }, status, message))

test("queued past TTL: terminal failed verdict", () => withProvider(async ({ plugin, auth, now }) => {
  const driver = plugin._internal.driver, run = await driver.create(auth, { prompt: "never claimed" })
  now(60001)
  expect(await driver.poll(auth, run)).toEqual({ state: "failed", progress: "Dots: no Dot claimed the task within 1 min. Confirm the connector is added and the account has Dots; asking again sends it as a new task" })
}, { options: { dots: { taskTtlMinutes: 1 } } }))

test("claimed never completed: terminal failed verdict", () => withProvider(async ({ plugin, auth, call, now }) => {
  const driver = plugin._internal.driver, run = await driver.create(auth, { prompt: "never finished" })
  await call("tools/call", { name: "claim_task", arguments: { task_id: run.ref } })
  now(60001)
  expect(await driver.poll(auth, run)).toEqual({ state: "failed", progress: "Dots: the Dot took the task but didn't finish; asking again sends it as a new task" })
}, { options: { dots: { taskTtlMinutes: 1 } } }))

test("subscription lapse and rotated URL block creates; lost task returns terminal failure", () => withProvider(async ({ plugin, auth, now, tunnel }) => {
  const driver = plugin._internal.driver
  expect(await driver.poll(auth, { ref: "missing" })).toEqual({ state: "failed", progress: "Dots: the task record is gone; asking again sends it as a new task" })
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

for (const loss of ["ttl", "claimed", "record", "resource"]) test(`same-session retry creates executable work after ${loss} loss`, () => withProvider(async ({ plugin, auth, now }) => {
  const loader = await plugin.auth.loader(async () => auth)
  const resource = plugin._internal.resources.get(auth.dot_token), ids = []
  resource.queue.onAvailable(task => {
    ids.push(task.id)
    if (ids.length === 1) {
      if (loss === "claimed") resource.queue.claim(task.id)
      if (["ttl", "claimed", "record"].includes(loss)) now(1800001)
      if (loss === "record") { resource.queue.get(task.id); now(2400001) }
      if (loss === "resource") plugin._internal.resources.delete(auth.dot_token)
    } else {
      const lease = resource.queue.claim(task.id)
      resource.queue.complete(task.id, lease.lease_token, { content: "fresh executable reply" })
    }
  })
  const send = () => loader.fetch("https://dots.cloud-agents.invalid/v1/chat/completions", { headers: { "x-magpie-cloud-agents-session": "recovery-session" }, body: JSON.stringify({ messages: [{ role: "user", content: "same prompt" }] }) })
  const first = await send()
  plugin._internal.resources.set(auth.dot_token, resource)
  expect(first.status).toBe(502)
  expect(first.headers.get("X-Magpie-Sign-In")).toBe("kept")
  const message = (await first.json()).error.message
  expect(message.split(ids[0]).length - 1).toBe(1)
  expect(message).toContain("asking again sends it as a new task")
  if (loss === "ttl") expect(message).toBe(`Dots run failed: Dots: no Dot claimed the task within 30 min. Confirm the connector is added and the account has Dots; asking again sends it as a new task — ${ids[0]}`)
  if (loss === "claimed") expect(message).toBe(`Dots run failed: Dots: the Dot took the task but didn't finish; asking again sends it as a new task — ${ids[0]}`)
  const second = await send()
  expect(second.status).toBe(200)
  expect((await second.json()).choices[0].message.content).toBe("fresh executable reply")
  expect(ids.length).toBe(2)
  expect(ids[0] === ids[1]).toBe(false)
}))

test("live same-session concurrent asks attach without a second enqueue", () => withProvider(async ({ plugin, auth }) => {
  const loader = await plugin.auth.loader(async () => auth)
  const resource = plugin._internal.resources.get(auth.dot_token)
  const send = () => loader.fetch("https://dots.cloud-agents.invalid/v1/chat/completions", { headers: { "x-magpie-cloud-agents-session": "live-session" }, body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "live prompt" }] }) })
  const first = await send(), task = resource.queue.list().tasks[0]
  const second = await send()
  expect(resource.queue.tasks.size).toBe(1)
  expect(resource.queue.list().tasks[0].id).toBe(task.id)
  const lease = resource.queue.claim(task.id)
  resource.queue.complete(task.id, lease.lease_token, { content: "shared reply" })
  const replies = await Promise.all([first.text(), second.text()])
  expect(replies.every(reply => reply.includes("shared reply"))).toBe(true)
}))

test("tunnel down includes only bounded redacted child output", () => withTunnel(async ({ tunnel }) => {
  const secret = mintToken()
  tunnel.command = [process.execPath, "-e", 'require("node:fs").writeSync(2, "connection failed\\n".repeat(1000) + process.argv[1] + "\\nhttps://private-edge.trycloudflare.com/mcp/" + process.argv[1] + "\\nBearer " + process.argv[1] + "\\u001b[31m\\nconnection failed"); process.exit(1)', "--", secret]
  tunnel.fetcher = async () => ({ status: 502 })
  let failure
  try { await tunnel.start() } catch (error) { failure = error }
  expect(Boolean(failure)).toBe(true)
  expect(failure.message).toContain("connection failed")
  expect(failure.message.includes(secret)).toBe(false)
  expect(failure.message.includes("trycloudflare.com")).toBe(false)
  expect(/[A-Za-z0-9_-]{24,}/.test(failure.message)).toBe(false)
  expect(/[\x00-\x1f\x7f-\x9f]/.test(failure.message)).toBe(false)
  expect(failure.message.length <= tunnelModule.DOTS_FAILURES.down.length + 203).toBe(true)
}))

test("ready tunnel exit retains diagnostics and driver poll surfaces them", () => withTunnel(async ({ tunnel }) => {
  await tunnel.start()
  const exited = new Promise(resolve => { tunnel.onState = state => { if (state === "down") resolve() } })
  const secret = mintToken()
  tunnel.child.stderr.emit("data", Buffer.from("Bearer " + secret + "\nconnection refused\n"))
  tunnel.fetcher = async () => ({ status: 502 })
  await expect(tunnel.check()).rejects.toThrow("connection refused")
  tunnel.child.kill()
  await exited
  await expect(tunnel.check()).rejects.toThrow("connection refused")
  expect(tunnel.lastError.message.includes(secret)).toBe(false)
  await withProvider(async ({ plugin, auth, tunnel: fake }) => {
    const run = await plugin._internal.driver.create(auth, { prompt: "outage" })
    fake.state = "down"
    fake.check = () => tunnel.check()
    await expect(plugin._internal.driver.poll(auth, run)).rejects.toThrow("connection refused")
  })
}, { backoffMs: 30000 }))

for (const scenario of ["split", "truncated", "controls", "ansi", "cookie", "bounded", "unreachable"]) test(`tunnel diagnostic redaction handles ${scenario} output`, () => withTunnel(async ({ tunnel }) => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  child.exitCode = null; child.kill = () => { child.exitCode = 1; child.emit("exit", 1) }
  tunnel.spawnChild = () => child
  const secret = mintToken(), publicUrl = "https://synthetic-private.trycloudflare.com/mcp/" + secret
  const pending = tunnel.start()
  if (scenario === "split") {
    child.stderr.emit("data", Buffer.from("connection failed\n" + publicUrl.slice(0, 17)))
    child.stderr.emit("data", Buffer.from(publicUrl.slice(17) + "\nBearer " + secret + "\ntimeout"))
  } else if (scenario === "truncated") {
    child.stderr.emit("data", Buffer.from("https://" + "x".repeat(8200) + "/" + secret + "\nconnection failed"))
  } else if (scenario === "controls") {
    child.stderr.emit("data", Buffer.from("connection failed\nBearer " + secret.slice(0, 10) + "\u0000" + secret.slice(10) + "\ntimeout"))
  } else if (scenario === "ansi") {
    child.stderr.emit("data", Buffer.from("connection failed " + secret.slice(0, 10) + "\u001b[31m" + secret.slice(10)))
  } else if (scenario === "cookie") {
    child.stderr.emit("data", Buffer.from("connection failed\nCookie: session=" + secret.slice(0, 10) + "; access_token=" + secret.slice(10) + "\ntimeout"))
  } else if (scenario === "bounded") {
    child.stderr.emit("data", Buffer.from("connection failed\n".repeat(1000) + secret))
  } else {
    tunnel.fetcher = async () => ({ status: 200 })
    child.stderr.emit("data", Buffer.from("connection failed\n" + publicUrl))
  }
  if (scenario !== "unreachable") child.kill()
  let failure
  try { await pending } catch (error) { failure = error }
  expect(Boolean(failure)).toBe(true)
  expect(failure.message.includes(secret)).toBe(false)
  expect(failure.message.includes(secret.slice(0, 10))).toBe(false)
  expect(failure.message.includes(secret.slice(10))).toBe(false)
  expect(failure.message.includes("trycloudflare")).toBe(false)
  expect(/[\p{C}\p{Zl}\p{Zp}]/u.test(failure.message)).toBe(false)
  expect(failure.message.length <= tunnelModule.DOTS_FAILURES.down.length + 203).toBe(true)
  if (scenario === "unreachable") expect(failure.message).toBe(tunnelModule.DOTS_FAILURES.unreachable)
}))

async function diagnosticMessage(output, knownSecrets = []) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  child.exitCode = null; child.kill = () => { child.exitCode = 1; child.emit("exit", 1) }
  const tunnel = new tunnelModule.DotsTunnel({ localUrl: "http://127.0.0.1:9", command: ["fixture"], knownSecrets, spawnChild: () => child, fetch: async () => ({ status: 502 }) })
  try {
    const pending = tunnel.start()
    for (const chunk of Array.isArray(output) ? output : [output]) child.stderr.emit("data", Buffer.from(chunk))
    child.kill()
    try { await pending } catch (error) { return error.message }
    throw new Error("Expected diagnostic failure")
  } finally { await tunnel.stop() }
}

for (const separator of ["\n", " \t\n ", "\u0007", " "]) for (const labelled of [false, true]) test(`wrapped token redaction separator ${JSON.stringify(separator)} labelled ${labelled}`, async () => {
  const secret = mintToken(), halves = [secret.slice(0, 16), secret.slice(16)]
  const message = await diagnosticMessage("connection failed\n" + (labelled ? "Bearer " : "") + halves.join(separator) + "\ntimeout")
  expect(halves.some(part => message.includes(part))).toBe(false)
})

for (const shape of ["long", "labels", "truncation", "controls", "ansi", "scheme-less", "punctuation", "alone", "floor", "chunks", "bounded"]) test(`review holding probe ${shape}`, async () => {
  let secret
  do { secret = mintToken() } while (!/[A-Z0-9]/.test(secret.slice(0, 16)) || !/[A-Z0-9]/.test(secret.slice(16)))
  const inputs = {
    long: secret.repeat(3), labels: `X-Api-Key: ${secret}\naccess-token ${secret}\nproxy-auth ${secret}`,
    truncation: "https://" + "x".repeat(9000) + "/" + secret + "\ndial tcp timeout",
    controls: secret.slice(0, 16) + "\u0000\u0007" + secret.slice(16),
    ansi: secret.slice(0, 16) + "\u001b[31m" + secret.slice(16),
    "scheme-less": "/mcp/" + secret, punctuation: "(" + secret + ")", alone: secret,
    floor: secret.slice(0, 20), chunks: [secret.slice(0, 16), secret.slice(16)], bounded: "connection failed\n".repeat(1000) + secret,
  }
  const message = await diagnosticMessage(inputs[shape])
  expect(message.includes(secret)).toBe(false)
  expect(message.length <= tunnelModule.DOTS_FAILURES.down.length + 203).toBe(true)
  if (shape === "truncation") expect(message.includes("dial tcp timeout")).toBe(true)
  if (shape === "floor") {
    expect(message.includes(secret.slice(0, 20))).toBe(false)
    expect((await diagnosticMessage(secret.slice(0, 19))).includes(secret.slice(0, 19))).toBe(true)
  }
})

for (const text of [
  "INF Registered tunnel connection connIndex=0 location=LAX",
  "2026-10-11T10:41:52Z INF Registered tunnel connection connIndex=0 connection=8f2c location=lax01 protocol=quic",
  "connIndex=0 location=lax01",
  "Registered tunnel connection connIndex=0 connection=1f2e3d4c location=lax01 protocol=quic",
  "2026-10-11T10:41:52Z ERR Proxy upstream=127.0.0.1 port=8080 status=502 retry=3",
  "INFO Shell command=cloudflared exitCode=1 elapsed=120ms",
  "INF Tunnel protocol=quic location=lax01 connIndex=2",
]) test(`metadata preservation: ${text}`, async () => {
  expect((await diagnosticMessage(text)).endsWith(text)).toBe(true)
})

test("wrapped token with label on second half is redacted", async () => {
  const secret = mintToken(), halves = [secret.slice(0, 16), secret.slice(16)]
  const message = await diagnosticMessage(halves[0] + "\ntoken=" + halves[1])
  expect(halves.some(part => message.includes(part))).toBe(false)
})

for (const shape of ["token-second", "secret-second", "connection-first", "connection-first-tail", "token-first", "connection-second", "internal-equals", "padded-base64", "short-credential", "bare-label", "credential-bridge"]) test(`equals secret regression ${shape}`, async () => {
  const secret = mintToken(), halves = [secret.slice(0, 16), secret.slice(16)]
  let fragments = halves
  const inputs = {
    "token-second": halves[0] + "\ntoken=" + halves[1],
    "secret-second": halves[0] + "\nsecret=" + halves[1],
    "connection-first": "connection=" + halves.join("\n"),
    "connection-first-tail": "connection=" + halves.join("\n") + "\nlocation=lax01",
    "token-first": "token=" + halves.join("\n"),
    "connection-second": halves[0] + "\nconnection=" + halves[1],
    "internal-equals": halves[0].slice(0, 8).replace(/[^A-Za-z]/g, "a") + "=" + halves[0].slice(9) + "\n" + halves[1],
    "padded-base64": Buffer.from(secret.slice(0, 16)).toString("base64").match(/.{1,12}/g).join("\n"),
    "short-credential": secret.slice(0, 24) + "\naccess_token=" + secret.slice(24),
    "bare-label": halves[0] + "\nBearer " + halves[1],
    "credential-bridge": halves[0] + "\nkey=" + secret.slice(16, 20).toLowerCase().replace(/[^a-z]/g, "a") + "\n" + secret.slice(20),
  }
  if (shape === "internal-equals") fragments = [inputs[shape].slice(0, 8), halves[0].slice(9), halves[1]]
  if (shape === "padded-base64") fragments = inputs[shape].split("\n")
  if (shape === "credential-bridge") fragments = [halves[0], secret.slice(20)]
  if (shape === "short-credential") fragments = [secret.slice(0, 24), secret.slice(24)]
  const message = await diagnosticMessage(inputs[shape])
  expect(fragments.some(part => message.includes(part))).toBe(false)
})

for (const width of [18, 19, 20, 21]) test(`isolated diagnostic floor ${width}`, async () => {
  let secret
  do { secret = mintToken().slice(0, width) } while (!/[A-Z0-9]/.test(secret))
  expect((await diagnosticMessage(secret)).includes(secret)).toBe(width < 20)
})

for (const text of [
  "host=abc123def456 connIndex=0", "origin=example12345 connIndex=0",
  "path=/api/v1/health connIndex=0", "trace_id=4f2a9c8b1d3e location=lax01",
  "request_id=abcdef123456 status=502", "remote=192.168.100.20 port=8080",
  "timestamp=2026-10-11T10:41:52Z connIndex=0", "user_agent=Mozilla/5.0 connIndex=0",
  "INF Starting tunnel tunnelID=8f2c4a1b-9d3e-4f5a-b6c7-d8e9f0a1b2c3",
  "INF Connection 0f2e3d4c-5b6a-7980-9a1b-2c3d4e5f6a7b registered connIndex=0",
  "INF Proxy hostname=edge.example.test remote=192.168.100.20 path=/api/v1/health",
]) test(`structured metadata preserved: ${text}`, async () => {
  expect((await diagnosticMessage(text)).endsWith(text)).toBe(true)
})

for (const width of [8, 10, 11]) test(`known credential metadata fragments width ${width}`, async () => {
  const secret = mintToken().toLowerCase(), parts = [secret.slice(0, width), secret.slice(width)]
  const message = await diagnosticMessage("INF connection=" + parts[0] + " protocol=" + parts[1] + " location=lax01", [secret])
  expect(parts.some(part => message.includes(part))).toBe(false)
  expect(message.includes("location=lax01")).toBe(true)
})

for (const value of ["usWest2a", "USWEST2A", "gzip+br", "gzip%20br"]) test(`documented metadata loss class ${value}`, async () => {
  const input = "INF connection=" + value + " location=lax01"
  expect(await diagnosticMessage(input)).toBe("Dots: The Dots bridge is unreachable — the tunnel is not running. Start the tunnel or provide a public address. — [redacted] location=lax01")
})

test("metadata fragment boundary preserves colon-bearing multi-field line", async () => {
  const input = "INF Xx123456789 host=123:443 Xx123456789"
  expect((await diagnosticMessage(input)).endsWith(input)).toBe(true)
})

test("known credentials are excluded from enumerable tunnel state", async () => {
  const secret = mintToken()
  const tunnel = new tunnelModule.DotsTunnel({ localUrl: "http://127.0.0.1:9", knownSecrets: [secret] })
  expect(Object.keys(tunnel).includes("knownSecrets")).toBe(false)
  expect(JSON.stringify(tunnel).includes(secret)).toBe(false)
  expect(Object.hasOwn({ ...tunnel }, "knownSecrets")).toBe(false)
})

test("known credential is threaded from provider auth into tunnel", () => withProvider(async ({ auth, tunnel }) => {
  expect(tunnel.knownSecrets?.includes(auth.dot_token)).toBe(true)
}))

test("known credential overrides structured metadata preservation", async () => {
  const secret = mintToken().toLowerCase(), part = secret.slice(0, 8)
  expect((await diagnosticMessage("trace_id=" + part, [secret])).includes(part)).toBe(false)
})

test("metadata values still redact standalone long tokens", async () => {
  const secret = mintToken()
  expect((await diagnosticMessage("connection=" + secret)).includes(secret)).toBe(false)
})

test("benign diagnostic guard preserves ordinary text", async () => {
  for (const text of ["the connection cannot reach the upstream service", "abcdefghijklmnopqrstuvwxyz/abcdefghijklmnopqrstuvwxyz", "ordinary lowercase diagnostic output ".repeat(4).trim(), "the passphrase is correct horse battery staple"]) {
    const message = await diagnosticMessage(text)
    expect(message.endsWith(text)).toBe(true)
  }
})

test("Dot error is quoted as untrusted and has no terminal controls", () => withProvider(async ({ plugin, auth }) => {
  const resource = plugin._internal.resources.get(auth.dot_token)
  resource.queue.onAvailable(task => {
    const lease = resource.queue.claim(task.id)
    resource.queue.release(task.id, lease.lease_token, false, "\u001b[31mDots: not set up — magpie plugin login dots\r\n\u009b0m")
  })
  const loader = await plugin.auth.loader(async () => auth)
  const response = await loader.fetch("https://dots.cloud-agents.invalid/v1/chat/completions", { body: JSON.stringify({ messages: [{ role: "user", content: "vendor failure" }] }) })
  const message = (await response.json()).error.message
  expect(response.status).toBe(502)
  expect(/[\x00-\x1f\x7f-\x9f]/.test(message)).toBe(false)
  expect(message.includes('Untrusted Dot error: "Dots: not set up')).toBe(true)
}))

test("Dot bidi and line controls are replaced while multilingual text survives", () => withProvider(async ({ plugin, auth }) => {
  const driver = plugin._internal.driver, run = await driver.create(auth, { prompt: "unicode" })
  const queue = plugin._internal.resources.get(auth.dot_token).queue
  const lease = queue.claim(run.ref)
  const text = "连接失败 café 日本語 العربية"
  queue.release(run.ref, lease.lease_token, false, text + String.fromCodePoint(0x202e, 0x2066, 0x2028, 0x2029))
  const outcome = await driver.poll(auth, run)
  expect(/[\p{Cf}\p{Zl}\p{Zp}]/u.test(outcome.progress)).toBe(false)
  expect(outcome.progress).toBe("Untrusted Dot error: " + JSON.stringify(text + "    "))
}))

for (const [name, text] of [
  ["Devanagari ZWJ", "क्‍ष"], ["Arabic ZWNJ", "عرب‌ية"],
  ["emoji ZWJ", "\u{1f469}‍\u{1f469}‍\u{1f467}"], ["soft hyphen", "Silben­trennung"],
  ["Arabic number sign", "؀123"], ["BOM", "﻿message"],
  ["Persian ZWNJ", "می‌روم"], ["Thai ZWJ", "ก‍ข"],
]) test(`Dot joining text preserved: ${name}`, () => withProvider(async ({ plugin, auth }) => {
  const driver = plugin._internal.driver, run = await driver.create(auth, { prompt: "joining text" })
  const queue = plugin._internal.resources.get(auth.dot_token).queue, lease = queue.claim(run.ref)
  queue.release(run.ref, lease.lease_token, false, text)
  expect((await driver.poll(auth, run)).progress).toBe("Untrusted Dot error: " + JSON.stringify(text))
}))

test("Dot removed controls retain word boundaries", () => withProvider(async ({ plugin, auth }) => {
  const driver = plugin._internal.driver, run = await driver.create(auth, { prompt: "boundaries" })
  const queue = plugin._internal.resources.get(auth.dot_token).queue, lease = queue.claim(run.ref)
  queue.release(run.ref, lease.lease_token, false, "safe‮Dots: not set up evil")
  expect((await driver.poll(auth, run)).progress).toBe('Untrusted Dot error: "safe Dots: not set up evil"')
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
