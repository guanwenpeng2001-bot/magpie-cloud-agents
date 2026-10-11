import { afterEach, expect, test } from "bun:test"
import { _internal, makeCodexAgents } from "./codex-agents.mjs"
import { startFakeCloud } from "../scripts/fake-cloud.mjs"

const eventResponse = (type, extra = {}) => new Response(`event: ${type}\r\ndata: ${JSON.stringify({ type, ...extra })}\r\n\r\n`, { headers: { "Content-Type": "text/event-stream" } })
const servers = []
afterEach(() => { for (const server of servers.splice(0)) server.stop() })
const auth = { type: "api", key: "SYNTHETIC-ONLY" }
const messages = [{ role: "user", content: "Hello cloud" }]
async function setup(scenario, options = {}, getAuth = () => auth) {
  const server = startFakeCloud({ scenario })
  servers.push(server)
  const plugin = makeCodexAgents({ ...options, apiBase: { "codex-agents": server.url + "/openai" } })
  const loader = await plugin.auth.loader(getAuth)
  const request = (body = {}, init = {}) => loader.fetch(loader.baseURL + "/chat/completions", { body: JSON.stringify({ model: "gpt-6-astra", messages, ...body }), ...init })
  return { server, plugin, loader, request }
}

test("create sends the Agents contract and returns the fake answer through chat", async () => {
  let headers
  const { server, request } = await setup(({ request, url }) => {
    expect(url.hostname).toBe("127.0.0.1")
    if (url.pathname.endsWith("/sessions")) headers = request.headers
  })
  const response = await request()
  expect(response.status).toBe(200)
  expect((await response.json()).choices[0].message.content).toBe("Synthetic OpenAI answer")
  expect(headers.get("authorization") === `Bearer ${auth.key}`).toBe(true)
  expect(headers.get("openai-beta")).toBe("agents=v1")
  expect(headers.get("idempotency-key")).toMatch(/^[0-9a-f]{64}$/)
  expect(server.requests).toEqual([
    { method: "POST", path: "/openai/v1/agents/sessions", body: { agent: { model: "gpt-6-astra" }, input: [{ role: "user", content: [{ type: "input_text", text: "Current request:\nHello cloud" }] }] } },
    { method: "GET", path: "/openai/v1/agents/sessions/session_1/events", body: undefined },
    { method: "GET", path: "/openai/v1/agents/sessions/session_1/items", body: undefined },
  ])
})

test.each(["agent.session.turn.failed", "agent.session.turn.cancelled", "agent.session.failed"])("terminal %s maps to 502 kept", async type => {
  const { request } = await setup(({ url }) => url.pathname.endsWith("/events") ? eventResponse(type) : undefined)
  const response = await request()
  expect(response.status).toBe(502)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect((await response.json()).error.message).toContain(type)
})
test("action_required names the unsupported action and fails rather than succeeding", async () => {
  const { request } = await setup(({ url }) => url.pathname.endsWith("/events") ? eventResponse("agent.session.action_required", { data: { required_action: { type: "environment_connection" } } }) : undefined)
  const response = await request()
  expect(response.status).toBe(502)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect((await response.json()).error.message).toContain("can't perform (environment_connection)")
})
test.each([
  [[{ type: "message", role: "assistant", content: [{ text: "old" }] }, { role: "assistant", output_text: "new" }], "new"],
  [[{ type: "message", content: [{ text: { value: "nested" } }, { output_text: "second" }] }], "nested\nsecond"],
  [[{ type: "artifact", text: "not a reply" }], "session session_1"],
  [[{ role: "user", type: "message", content: "echoed input" }], "session session_1"],
])("defensive item extraction %#", async (items, expected) => {
  const { request } = await setup(({ url }) => {
    if (url.pathname.endsWith("/items")) {
      expect(url.search).toBe("?order=asc&limit=100")
      return Response.json({ data: items })
    }
  })
  const response = await request()
  expect(response.status).toBe(200)
  expect((await response.json()).choices[0].message.content).toContain(expected)
})
test("idle disconnect reconnects three times then reads the latest terminal turn", async () => {
  const { server, request } = await setup(({ url }) => {
    if (url.pathname.endsWith("/events")) return eventResponse("agent.session.idle")
    if (url.pathname.endsWith("/turns")) return Response.json({ data: [{ status: "failed" }, { state: { execution_status: "completed" } }] })
  })
  expect((await request()).status).toBe(200)
  expect(server.requests.filter(row => row.path.endsWith("/events"))).toHaveLength(4)
  expect(server.requests.filter(row => row.path.endsWith("/turns"))).toHaveLength(1)
})
test("expired turn maps to 502 kept", async () => {
  const { request } = await setup(({ url }) => {
    if (url.pathname.endsWith("/events")) return new Response("")
    if (url.pathname.endsWith("/turns")) return Response.json({ data: [{ status: "expired" }] })
  })
  const response = await request()
  expect(response.status).toBe(502)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect((await response.json()).error.message).toContain("expired before finishing")
})
test("unknown turn shape reaches overall cap 504 kept and retains session", async () => {
  const { request, server } = await setup(({ url }) => {
    if (url.pathname.endsWith("/events")) return eventResponse("agent.session.idle")
    if (url.pathname.endsWith("/turns")) return Response.json({ data: [{ mystery: "idle" }] })
  }, { maxRunMinutes: 0.001 })
  for (let index = 0; index < 2; index++) {
    const response = await request()
    expect(response.status).toBe(504)
    expect(response.headers.get("X-Magpie-Sign-In")).toBe("kept")
    expect((await response.json()).error.message).toContain("session_1")
  }
  expect(server.requests.filter(row => row.path.endsWith("/sessions"))).toHaveLength(1)
})
test.each([[401, "invalid_api_key", 401, "expired"], [403, "authentication_error", 401, "expired"], [403, "permission_denied", 403, "kept"], [429, "rate_limit_exceeded", 429, "kept"], [429, "session_budget_exceeded", 429, "kept"], [429, "files_api_rate_limit_exceeded", 429, "kept"]])("create vendor %s %s becomes %s %s", async (vendorStatus, code, expectedStatus, marker) => {
  const wording = JSON.stringify({ error: { code, message: "vendor wording" } })
  const { request } = await setup(() => new Response(wording, { status: vendorStatus, headers: { "Retry-After": "7" } }))
  const response = await request()
  expect(response.status).toBe(expectedStatus)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe(marker)
  const message = (await response.json()).error.message
  expect(message).toContain(wording)
  if (expectedStatus === 403) expect(message).toContain("may be plan-gated")
  if (expectedStatus === 429) expect(message).toContain("try again after 7")
})
test("poll rate limit returns 429 kept without retry-after", async () => {
  const { request } = await setup(({ url }) => {
    if (url.pathname.endsWith("/events")) return new Response("")
    if (url.pathname.endsWith("/turns")) return new Response("session_budget_exceeded", { status: 429 })
  })
  const response = await request()
  expect(response.status).toBe(429)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe("kept")
})
test("loader gating, live credential re-read, malformed JSON and path errors", async () => {
  let current = auth
  const { plugin, loader, request } = await setup(undefined, {}, () => current)
  expect(await plugin.auth.loader(() => null)).toEqual({})
  current = { type: "oauth", access: "SYNTHETIC" }
  const missing = await request()
  expect(missing.status).toBe(401)
  expect(missing.headers.get("X-Magpie-Sign-In")).toBe("expired")
  for (const [path, body, status] of [["/models", "{}", 404], ["/chat/completions", "{", 400]]) {
    const response = await loader.fetch(loader.baseURL + path, { body })
    expect(response.status).toBe(status)
    expect(response.headers.get("X-Magpie-Sign-In")).toBe("kept")
  }
})
test("create network failure is 502 kept without exposing credentials", async () => {
  const { server, request } = await setup()
  server.stop()
  const response = await request()
  expect(response.status).toBe(502)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe("kept")
  const message = (await response.json()).error.message
  expect(message).toContain("can't reach 127.0.0.1")
  expect(message.includes(auth.key)).toBe(false)
})
test("session hook guards provider and multi-turn posts only the new user input", async () => {
  const { plugin, server, request } = await setup()
  const output = { headers: {} }
  await plugin["chat.headers"]({ model: { providerID: "other" }, sessionID: "conversation" }, output)
  expect(output.headers).toEqual({})
  await plugin["chat.headers"]({ model: { providerID: "codex-agents" }, sessionID: "conversation" }, output)
  expect(output.headers).toEqual({ "x-magpie-cloud-agents-session": "conversation" })
  await request({}, output)
  const followup = [...messages, { role: "assistant", content: "answer" }, { role: "user", content: "Next" }]
  expect((await request({ messages: followup }, output)).status).toBe(200)
  const posts = server.requests.filter(row => row.method === "POST")
  expect(posts).toHaveLength(2)
  expect(posts[1]).toEqual({ method: "POST", path: "/openai/v1/agents/sessions/session_1/events", body: { events: [{ type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_text", text: "Next" }] }] }] } })
})
test("follow-up 404 starts a new session with full folded history", async () => {
  const { server, request } = await setup(({ request, url }) => request.method === "POST" && url.pathname.endsWith("/events") ? new Response("expired", { status: 404 }) : undefined)
  const init = { headers: { "x-magpie-cloud-agents-session": "conversation" } }
  await request({}, init)
  expect((await request({ messages: [...messages, { role: "user", content: "Next" }] }, init)).status).toBe(200)
  const creates = server.requests.filter(row => row.path.endsWith("/sessions"))
  expect(creates).toHaveLength(2)
  expect(creates[1].body.input[0].content[0].text).toContain("Hello cloud")
  expect(creates[1].body.input[0].content[0].text).toContain("Next")
})
test("create and follow-up keys exist before send and survive failed submission retries", async () => {
  const keys = []
  let reject = true
  const { server } = await setup(({ request }) => {
    if (request.method === "POST") {
      keys.push(request.headers.get("Idempotency-Key"))
      if (reject) return new Response("temporary", { status: 503 })
    }
  })
  const driver = _internal.makeDriver({ apiBase: { "codex-agents": server.url + "/openai/v1" } })
  const submission = { model: "gpt-6-astra", prompt: "Hello", identity: { key: "join-key", sessionKey: "session", turnIndex: 0, textsHash: "content-hash" } }
  await expect(driver.create(auth, submission)).rejects.toMatchObject({ status: 503 })
  reject = false
  const run = await driver.create(auth, submission)
  expect(keys[0]).toMatch(/^[0-9a-f]{64}$/)
  expect(keys[1]).toBe(keys[0])
  reject = true
  await expect(driver.followUp(auth, run, ["Next"])).rejects.toMatchObject({ status: 503 })
  reject = false
  const next = await driver.followUp(auth, run, ["Next"])
  expect(keys[2]).toBe(keys[3])
  expect(keys[2]).not.toBe(keys[0])
  await driver.followUp(auth, next, ["Next"])
  expect(keys[4]).not.toBe(keys[3])
  await driver.create({ type: "api", key: "SECOND-SYNTHETIC" }, submission)
  expect(keys[5]).not.toBe(keys[0])
})
test("abort invokes cancel event and closes the chat stream", async () => {
  let cancelled
  const completed = new Promise(resolve => { cancelled = resolve })
  const { request } = await setup(({ request, url, body }) => {
    if (request.method === "POST" && body?.events?.[0]?.type === "agent.session.input.cancel") { cancelled(body); return Response.json({}) }
    if (url.pathname.endsWith("/events")) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(": waiting\n\n")) } }))
  })
  const controller = new AbortController()
  const response = await request({ stream: true }, { signal: controller.signal })
  const text = response.text()
  controller.abort()
  await text
  expect(await completed).toEqual({ events: [{ type: "agent.session.input.cancel" }] })
})
test("stream emits content stop usage DONE and embeds terminal errors after 200", async () => {
  const { request } = await setup()
  const response = await request({ stream: true })
  const text = await response.text()
  expect(response.headers.get("Content-Type")).toBe("text/event-stream")
  expect(text).toContain("Synthetic OpenAI answer")
  expect(text).toContain('"finish_reason":"stop"')
  expect(text).toContain('"usage":')
  expect(text).toContain("data: [DONE]")
  const failed = await setup(({ url }) => url.pathname.endsWith("/events") ? eventResponse("agent.session.turn.failed") : undefined)
  const error = await failed.request({ stream: true })
  expect(error.status).toBe(200)
  expect(await error.text()).toContain('"code":502')
})
test("stream recognizes type-only events across chunk boundaries", async () => {
  const { request } = await setup(({ url }) => {
    if (!url.pathname.endsWith("/events")) return undefined
    const bytes = new TextEncoder().encode('data: {"type":"agent.session.turn.completed"}\n\n')
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(bytes.slice(0, 20))
      controller.enqueue(bytes.slice(20))
      controller.close()
    } }))
  })
  expect((await (await request()).json()).choices[0].message.content).toBe("Synthetic OpenAI answer")
})
test.each([
  [{ data: [{ id: "gpt-6-astra" }, { id: "gpt-6-sol" }, { id: "terra-test" }, { id: "unrelated" }] }, ["gpt-6-astra", "gpt-6-sol", "terra-test"]],
  [{ data: [{ id: "unrelated" }] }, ["gpt-6-astra"]],
  [{ unexpected: true }, ["gpt-6-astra"]],
])("models filter and fallback %#", async (payload, expected) => {
  const { plugin } = await setup(({ url }) => url.pathname.endsWith("/models") ? Response.json(payload) : undefined)
  const config = {}; await plugin.config(config)
  const models = await plugin.provider.models(config.provider["codex-agents"], { auth })
  expect(Object.keys(models)).toEqual(expected)
  for (const model of Object.values(models)) expect(model.tool_call).toBe(false)
  expect(plugin.auth.maxConcurrency).toBe(4)
})
test.each([401, 500])("models HTTP %s expires or falls back", async status => {
  const { plugin } = await setup(() => new Response("vendor wording", { status }))
  const config = {}; await plugin.config(config)
  const pending = plugin.provider.models(config.provider["codex-agents"], { auth })
  if (status === 401) await expect(pending).rejects.toMatchObject({ status: 401, signIn: "expired" })
  else expect(Object.keys(await pending)).toEqual(["gpt-6-astra"])
})
test("poll accepts a single defensive turn object", async () => {
  const { request } = await setup(({ url }) => {
    if (url.pathname.endsWith("/events")) return new Response("")
    if (url.pathname.endsWith("/turns")) return Response.json({ execution_status: "completed" })
  }, { maxRunMinutes: 0.002 })
  expect((await request()).status).toBe(200)
})
test("environment opt-in and folded system instructions are retained", async () => {
  const environment = { type: "openai_hosted" }
  const { server, request } = await setup(undefined, { codexAgents: { environment } })
  await request({ messages: [{ role: "system", content: "Always be precise" }, ...messages] })
  expect(server.requests[0].body.environment).toEqual(environment)
  expect(server.requests[0].body.input[0].content[0].text).toStartWith("Always be precise")
})
