import { test, expect, afterEach } from "bun:test"
import { gzipSync } from "node:zlib"
import { makeDevinCloud, makeDevinDriver } from "./devin-cloud.mjs"
import { FollowupRejected } from "../lib/errors.mjs"
import { emulate } from "../lib/emulate.mjs"
import { SESSION_HEADER } from "../lib/sessions.mjs"
import { foldPrompt } from "../lib/transcript.mjs"
import { startFakeCloud } from "../scripts/fake-cloud.mjs"

const servers = []
afterEach(() => { for (const server of servers.splice(0)) server.stop() })
const auth = () => ({ type: "api", key: "apk_user_synthetic" })
const codeiumAuth = () => ({ type: "api", key: "cog_" + "a".repeat(52) })
const messages = [{ role: "user", content: "Explain the change" }]
async function setup(scenario, options = {}) {
  const server = startFakeCloud({ scenario }); servers.push(server)
  const plugin = makeDevinCloud({ ...options, apiBase: { "devin-cloud": server.url + "/devin" } })
  const loader = await plugin.auth.loader(auth)
  const driver = makeDevinDriver({ ...options, apiBase: { "devin-cloud": server.url + "/devin" } })
  return { server, plugin, loader, driver }
}
const request = (loader, body = {}, init = {}) => loader.fetch(loader.baseURL + "/chat/completions", { body: JSON.stringify({ model: "devin-session", messages, ...body }), ...init })

const run = { ref: "synthetic", url: "http://127.0.0.1/session/synthetic" }
const polling = payload => ({ request }) => request.method === "GET" ? Response.json(payload) : undefined

// a fake Connect endpoint: records method, path, headers and raw body, and
// answers GetChatMessage with one text frame and the stream's end.
function startFakeCodeium({ scenario } = {}) {
  const requests = []
  const enc = new TextEncoder()
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const headers = {}
      for (const name of ["authorization", "content-type", "connect-protocol-version"]) headers[name] = request.headers.get(name)
      const body = new Uint8Array(await request.arrayBuffer())
      requests.push({ method: request.method, path: url.pathname, headers, body })
      if (scenario) {
        const response = await scenario({ request, url, headers, body })
        if (response) return response
      }
      if (request.method === "POST" && url.pathname === "/exa.api_server_pb.ApiServerService/GetChatMessage") {
        const text = enc.encode("Synthetic Codeium answer")
        const msg = new Uint8Array(2 + text.length) // field 3, wire 2, the reply text
        msg[0] = 0x1a; msg[1] = text.length; msg.set(text, 2)
        const end = enc.encode("{}")
        const out = new Uint8Array(10 + msg.length + end.length)
        const view = new DataView(out.buffer)
        out[0] = 0; view.setUint32(1, msg.length); out.set(msg, 5)
        out[5 + msg.length] = 2; view.setUint32(6 + msg.length, end.length); out.set(end, 10 + msg.length)
        return new Response(out, { headers: { "Content-Type": "application/connect+proto" } })
      }
      return new Response("unknown synthetic route", { status: 404 })
    },
  })
  return { url: server.url.origin, requests, stop: () => server.stop(true) }
}
const fastTimers = {
  now: () => Date.now(), random: () => 0.5,
  setTimeout: (callback, delay) => setTimeout(callback, delay < 15000 ? 0 : delay),
  clearTimeout: timer => clearTimeout(timer),
}

test.each([undefined, 0, 12])("create fields and optional ACU ceiling %s", async maxAcuLimit => {
  let authorized = false, privateHeader = false
  const { loader, server } = await setup(({ request }) => {
    authorized = request.headers.get("authorization") === "Bearer apk_user_synthetic"
    privateHeader ||= request.headers.has(SESSION_HEADER)
  }, { devinCloud: { maxAcuLimit } })
  const promptMessages = [{ role: "user", content: "x".repeat(100) }]
  await request(loader, { messages: promptMessages }, { headers: { [SESSION_HEADER]: "conversation" } })
  const prompt = foldPrompt(promptMessages)
  expect(server.requests[0].body).toEqual({ prompt, title: "magpie session", tags: ["magpie"], ...(maxAcuLimit ? { max_acu_limit: maxAcuLimit } : {}) })
  expect(authorized).toBe(true)
  expect(privateHeader).toBe(false)
})

test.each(["working", "suspend_requested", "suspend_requested_frontend", "suspend_transient", "resume_requested", "resume_requested_frontend", "resumed", "unexpected", null])("poll %s remains running then finishes", async status => {
  let polls = 0
  const { driver, server } = await setup(({ request }) => request.method === "GET" ? Response.json({ status_enum: ++polls === 1 ? status : "finished", messages: [{ type: "unverified_assistant_name", message: "Done" }] }) : undefined)
  const fetcher = emulate(driver, auth, {}, { timers: fastTimers })
  const response = await request({ fetch: fetcher, baseURL: "https://test.invalid" })
  expect(response.status).toBe(200)
  expect((await response.json()).choices[0].message.content).toBe("Done")
  expect(server.requests.filter(row => row.method === "GET")).toHaveLength(2)
})

test.each([
  [{ messages: [{ type: "agent_message", message: "old" }, { type: "unknown_agent", message: "new" }, { type: "user_message", message: "user" }], structured_output: { ignored: true } }, "new"],
  [{ messages: [{ type: "user_message", message: "user" }], structured_output: { answer: 42 } }, '{"answer":42}'],
  [{ messages: [{ type: "agent_message", message: "" }], structured_output: false }, "false"],
  [{ messages: [] }, "Devin finished the session without writing a reply — see " + run.url],
])("result extraction follows fallback order %#", async (payload, expected) => {
  const { driver } = await setup(polling({ status_enum: "finished", ...payload }))
  expect(await driver.poll(auth(), run)).toEqual({ state: "succeeded", text: expected })
})

test("blocked returns 200 last agent text and continuation URL with PR footer", async () => {
  const { loader, server } = await setup(polling({ status_enum: "blocked", messages: [{ type: "agent_message", message: "Need approval" }], pull_request: { url: "http://127.0.0.1/pr/1" } }))
  const response = await request(loader)
  expect(response.status).toBe(200)
  expect((await response.json()).choices[0].message.content).toBe(`Need approval\n\nDevin is waiting for input — continue at ${server.url}/devin/sessions/devin-1\n\nPull request: http://127.0.0.1/pr/1`)
})

test("finished appends pull request after no-reply fallback", async () => {
  const { driver } = await setup(polling({ status_enum: "finished", pull_request: { url: "http://127.0.0.1/pr/1" } }))
  expect((await driver.poll(auth(), run)).text).toBe(`Devin finished the session without writing a reply — see ${run.url}\n\nPull request: http://127.0.0.1/pr/1`)
})

test.each([null, { detail: null }, {}])("follow-up accepts successful message response %#", async payload => {
  const { driver, server } = await setup(() => Response.json(payload))
  expect(await driver.followUp(auth(), run, ["first", "second"])).toEqual(run)
  expect(server.requests[0]).toEqual({ method: "POST", path: "/devin/v1/sessions/synthetic/message", body: { message: "first\n\nsecond" } })
})

test.each([400, 401, 403, 404, 410, 429, 500])("follow-up HTTP %s becomes FollowupRejected", async status => {
  const { driver } = await setup(() => Response.json({ detail: "rejected" }, { status }))
  await expect(driver.followUp(auth(), run, ["next"])).rejects.toBeInstanceOf(FollowupRejected)
})

test.each(["suspended", "", false, 0])("follow-up non-null detail %# becomes FollowupRejected", async detail => {
  const { driver } = await setup(() => Response.json({ detail }))
  await expect(driver.followUp(auth(), run, ["next"])).rejects.toBeInstanceOf(FollowupRejected)
})

test("rejected follow-up creates fresh session carrying the full fold", async () => {
  const { loader, server } = await setup(({ url }) => url.pathname.endsWith("/message") ? Response.json({ detail: "suspended" }) : undefined)
  const headers = { [SESSION_HEADER]: "conversation" }
  await request(loader, {}, { headers })
  const next = [...messages, { role: "assistant", content: "Prior answer" }, { role: "user", content: "Now extend it" }]
  expect((await request(loader, { messages: next }, { headers })).status).toBe(200)
  const creates = server.requests.filter(row => row.path === "/devin/v1/sessions")
  expect(creates).toHaveLength(2)
  expect(creates[1].body.prompt).toBe(foldPrompt(next))
})

test("fallback progress names both URLs without leaking into another request", async () => {
  const { loader, server } = await setup(({ url }) => url.pathname.endsWith("/message") ? Response.json({ detail: "suspended" }) : undefined)
  const headers = { [SESSION_HEADER]: "conversation" }
  await request(loader, {}, { headers })
  const response = await request(loader, { stream: true, messages: [...messages, { role: "user", content: "Next" }] }, { headers })
  const frames = (await response.text()).split("\n\n").filter(frame => frame.startsWith("data: {")).map(frame => JSON.parse(frame.slice(6)))
  const progress = frames.map(frame => frame.choices?.[0].delta.reasoning_content).filter(Boolean)
  expect(progress.some(text => text.includes(`${server.url}/devin/sessions/devin-1`) && text.includes(`${server.url}/devin/sessions/devin-2`))).toBe(true)
  const separate = await request(loader, { stream: true, messages: [{ role: "user", content: "Separate request" }] })
  expect(await separate.text()).not.toContain("devin-1")
})

test("accepted follow-up reuses the session", async () => {
  const { loader, server } = await setup()
  const headers = { [SESSION_HEADER]: "conversation" }
  await request(loader, {}, { headers })
  await request(loader, { messages: [...messages, { role: "user", content: "Next" }] }, { headers })
  expect(server.requests.filter(row => row.path === "/devin/v1/sessions")).toHaveLength(1)
  expect(server.requests.find(row => row.path.endsWith("/message")).body).toEqual({ message: "Next" })
})

test("static model, auth methods, config preservation and scoped session header", async () => {
  const { plugin, driver, server } = await setup()
  const config = { provider: { "devin-cloud": { name: "Custom", models: {} } } }
  await plugin.config(config)
  expect(Object.keys(config.provider["devin-cloud"].models)).toEqual(["devin-session"])
  expect(config.provider["devin-cloud"].models["devin-session"]).toEqual({ name: "Devin session", tool_call: false, reasoning: false })
  expect(config.provider["devin-cloud"].name).toBe("Custom")
  expect(await plugin.provider.models(config.provider["devin-cloud"])).toEqual(config.provider["devin-cloud"].models)
  expect(plugin.auth.methods).toHaveLength(2)
  expect(plugin.auth.methods.every(method => method.type === "oauth" && typeof method.authorize === "function")).toBe(true)
  expect(new Set(plugin.auth.methods.map(method => method.label)).size).toBe(2)
  expect(plugin.auth.methods[0].label).toContain("apk_")
  expect(plugin.auth.methods[0].label).toContain("api.devin.ai")
  expect(plugin.auth.methods[1].label).toContain("cog_")
  expect(plugin.auth.methods[1].label).toContain("Codeium")
  expect(plugin.auth.maxConcurrency).toBe(4)
  expect(typeof driver.cancel).toBe("function")
  expect(driver.stream).toBeUndefined()
  expect(plugin.auth.usage).toBeUndefined()
  const output = { headers: {} }
  await plugin["chat.headers"]({ model: { providerID: "other" }, sessionID: "other-session" }, output)
  await plugin["chat.headers"]({ model: { providerID: "devin-cloud" }, sessionID: "magpie-" + "a".repeat(24) }, output)
  expect(output.headers).toEqual({})
  await plugin["chat.headers"]({ provider: { info: { id: "devin-cloud" } }, sessionID: "session" }, output)
  expect(output.headers).toEqual({ [SESSION_HEADER]: "session" })
  expect(server.requests).toHaveLength(0)
})

test.each([null, { type: "oauth", access: "synthetic" }, { type: "api", key: " " }, { type: "api", key: 123 }])("unsigned loader is gated %#", async value => {
  expect(await makeDevinCloud().auth.loader(() => value)).toEqual({})
})

test("auth vanished or changed type returns 401 expired before any vendor call", async () => {
  const { plugin, server } = await setup()
  let current = auth()
  const loader = await plugin.auth.loader(() => current)
  current = { type: "oauth", access: "synthetic" }
  const response = await request(loader)
  expect(response.status).toBe(401)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe("expired")
  expect((await response.json()).error.message).toContain("magpie plugin login devin-cloud")
  expect(server.requests).toHaveLength(0)
})

test.each([401, 403, 429, 500])("create vendor %s preserves wording and sign-in marker", async status => {
  const wording = JSON.stringify({ detail: [{ msg: "vendor rejection" }] })
  const { loader } = await setup(() => new Response(wording, { status, headers: status === 429 ? { "Retry-After": "10" } : {} }))
  const response = await request(loader)
  expect(response.status).toBe(status === 403 ? 401 : status)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe(status === 401 || status === 403 ? "expired" : "kept")
  expect((await response.json()).error.message).toContain(wording)
  if (status === 429) expect(response.headers.get("Retry-After")).toBe("10")
})

test.each([401, 403, 429, 502])("poll vendor %s returns specified error and sign-in", async status => {
  const { loader } = await setup(({ request }) => request.method === "GET" ? Response.json({ detail: "poll failure" }, { status }) : undefined)
  const response = await request(loader)
  expect(response.status).toBe(status === 403 ? 401 : status)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe(status === 401 || status === 403 ? "expired" : "kept")
  expect((await response.json()).error.message).toContain("poll failure")
})

test("expired run returns 502 kept and session URL", async () => {
  const { loader, server } = await setup(polling({ status_enum: "expired" }))
  const response = await request(loader)
  expect(response.status).toBe(502)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect((await response.json()).error.message).toContain(`expired before finishing — ${server.url}/devin/sessions/devin-1`)
})

test("poll 429 Retry-After recovers without creating another session", async () => {
  let polls = 0
  const { loader, server } = await setup(({ request }) => request.method === "GET" && polls++ === 0 ? Response.json({ detail: "slow down" }, { status: 429, headers: { "Retry-After": "0" } }) : undefined)
  expect((await request(loader)).status).toBe(200)
  expect(server.requests.map(row => row.method)).toEqual(["POST", "GET", "GET"])
})

test("network failure returns 502 kept naming loopback host", async () => {
  const { loader, server } = await setup()
  server.stop()
  const response = await request(loader)
  expect(response.status).toBe(502)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect((await response.json()).error.message).toContain("can't reach 127.0.0.1:")
})

test("overall cap returns 504 kept with run URL", async () => {
  const { loader, server } = await setup(polling({ status_enum: "working" }), { maxRunMinutes: 0.001 })
  const response = await request(loader)
  expect(response.status).toBe(504)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect((await response.json()).error.message).toContain(server.url)
})

test("bad JSON and wrong path return 400 and 404 kept without network", async () => {
  const { loader, server } = await setup()
  for (const [path, body, status] of [["/chat/completions", "{", 400], ["/models", "{}", 404]]) {
    const response = await loader.fetch(loader.baseURL + path, { body })
    expect(response.status).toBe(status)
    expect(response.headers.get("X-Magpie-Sign-In")).toBe("kept")
  }
  expect(server.requests).toHaveLength(0)
})

test("abort closes stream and terminates the cloud session", async () => {
  let terminated
  const cancellation = new Promise(resolve => { terminated = resolve })
  const { loader, server } = await setup(context => {
    if (context.request.method === "DELETE") { terminated(); return Response.json({ detail: "terminated" }) }
    return polling({ status_enum: "working" })(context)
  })
  const controller = new AbortController()
  const response = await request(loader, { stream: true }, { signal: controller.signal })
  const reading = response.text()
  controller.abort()
  await reading
  await Promise.race([cancellation, new Promise((_, reject) => setTimeout(() => reject(new Error("missing remote cancellation")), 100))])
  expect(server.requests.filter(row => row.method === "DELETE")).toEqual([{ method: "DELETE", path: "/devin/v1/sessions/devin-1", body: undefined }])
})

test("poll-side server failure returns run-failed 502 kept with URL", async () => {
  const { loader, server } = await setup(({ request }) => request.method === "GET" ? Response.json({ detail: "backend failure" }, { status: 500 }) : undefined)
  const response = await request(loader)
  expect(response.status).toBe(502)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe("kept")
  const body = await response.json()
  expect(body.error.message).toContain("run failed:")
  expect(body.error.message).toContain("backend failure")
  expect(body.error.message).toContain(server.url)
})

test("stream emits answer, finish and DONE without progress contaminating text", async () => {
  const { loader } = await setup()
  const response = await request(loader, { stream: true })
  const frames = (await response.text()).trim().split("\n\n").map(frame => frame.slice(6)).map(frame => frame === "[DONE]" ? frame : JSON.parse(frame))
  expect(frames[0].choices[0].delta.role).toBe("assistant")
  expect(frames.at(-1)).toBe("[DONE]")
  expect(frames.at(-2).choices[0].finish_reason).toBe("stop")
  expect(frames.flatMap(frame => frame.choices?.[0].delta.content ?? []).join("")).toBe("Synthetic Devin answer")
})

test("fake vendor create and poll produce a chat answer", async () => {
  const { loader, server } = await setup()
  const response = await request(loader)
  expect(response.status).toBe(200)
  expect((await response.json()).choices[0].message.content).toBe("Synthetic Devin answer")
  expect(server.requests.map(row => [row.method, row.path])).toEqual([["POST", "/devin/v1/sessions"], ["GET", "/devin/v1/sessions/devin-1"]])
})

test("an apk_ credential keeps going to api.devin.ai with Bearer", async () => {
  let bearer = ""
  const { loader, server } = await setup(({ request }) => { bearer = request.headers.get("authorization") })
  const response = await request(loader)
  expect(response.status).toBe(200)
  expect(bearer).toBe("Bearer apk_user_synthetic")
  expect(server.requests[0].path).toBe("/devin/v1/sessions")
})

test("a cog_ credential goes to the Codeium Connect endpoint with Basic auth and connect+proto", async () => {
  const codeiumServer = startFakeCodeium(); servers.push(codeiumServer)
  const plugin = makeDevinCloud({ apiBase: { "devin-cloud-codeium": codeiumServer.url } })
  const loader = await plugin.auth.loader(codeiumAuth)
  const response = await loader.fetch(loader.baseURL + "/chat/completions", { body: JSON.stringify({ model: "swe-2", messages }) })
  expect(response.status).toBe(200)
  expect((await response.json()).choices[0].message.content).toBe("Synthetic Codeium answer")
  const row = codeiumServer.requests[0]
  expect(row.path).toBe("/exa.api_server_pb.ApiServerService/GetChatMessage")
  expect(row.headers.authorization).toBe(`Basic cog_${"a".repeat(52)}`)
  expect(row.headers["content-type"]).toBe("application/connect+proto")
  expect(row.headers["connect-protocol-version"]).toBe("1")
  expect(new TextDecoder().decode(row.body)).toContain("swe-2-high")
})

test("the loader dispatches on the stored mechanism, so each credential reaches only its own endpoint", async () => {
  const devinServer = startFakeCloud({}); servers.push(devinServer)
  const codeiumServer = startFakeCodeium(); servers.push(codeiumServer)
  const plugin = makeDevinCloud({ apiBase: { "devin-cloud": devinServer.url + "/devin", "devin-cloud-codeium": codeiumServer.url } })
  let current = auth()
  const loader = await plugin.auth.loader(() => current)
  expect((await request(loader)).status).toBe(200)
  current = codeiumAuth()
  const codeiumLoader = await plugin.auth.loader(() => current)
  expect((await codeiumLoader.fetch(codeiumLoader.baseURL + "/chat/completions", { body: JSON.stringify({ model: "swe-2", messages }) })).status).toBe(200)
  expect(devinServer.requests.map(row => [row.method, row.path])).toEqual([["POST", "/devin/v1/sessions"], ["GET", "/devin/v1/sessions/devin-1"]])
  expect(codeiumServer.requests).toHaveLength(1)
  expect(codeiumServer.requests[0].headers.authorization).toContain("Basic cog_")
  expect(codeiumServer.requests[0].headers["content-type"]).toBe("application/connect+proto")
})

test("an unrecognized credential shape fails naming both accepted forms without a vendor call", async () => {
  const { plugin, server } = await setup()
  const loader = await plugin.auth.loader(() => ({ type: "api", key: "sk-neither-shape" }))
  const response = await loader.fetch(loader.baseURL + "/chat/completions", { body: JSON.stringify({ model: "devin-session", messages }) })
  expect(response.status).toBe(401)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe("expired")
  const message = (await response.json()).error.message
  expect(message).toContain("apk_")
  expect(message).toContain("cog_")
  expect(server.requests).toHaveLength(0)
})

test("a devin-path account whose key becomes cog_ returns 401 expired before any vendor call", async () => {
  const { plugin, server } = await setup()
  let current = auth()
  const loader = await plugin.auth.loader(() => current)
  current = { ...codeiumAuth(), mechanism: "devin" }
  const response = await request(loader)
  expect(response.status).toBe(401)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe("expired")
  expect(server.requests).toHaveLength(0)
})

test("a Codeium account is offered the Connect model list, an apk_ account the session floor", async () => {
  const { plugin } = await setup(undefined, { fetch: async () => new Response(null, { status: 503 }) })
  const config = { provider: { "devin-cloud": { models: {} } } }
  await plugin.config(config)
  const floor = await plugin.provider.models(config.provider["devin-cloud"])
  expect(Object.keys(floor)).toEqual(["devin-session"])
  const codeium = await plugin.provider.models(config.provider["devin-cloud"], { auth: codeiumAuth() })
  expect(Object.keys(codeium)).toContain("swe-2")
  expect(codeium["swe-2"].tool_call).toBe(false)
  expect(codeium["devin-session"]).toBeUndefined()
})


test.each([[0, "devin", "apk_user_synthetic"], [1, "codeium", "cog_synthetic"]])("sign-in %s persists its mechanism", async (index, mechanism, key) => {
  const method = makeDevinCloud().auth.methods[index]
  expect(await (await method.authorize({ key })).callback()).toEqual({ type: "success", access: key, refresh: "", expires: 0, mechanism, metadata: { mechanism } })
  const invalid = await (await method.authorize({ key: "unrecognized" })).callback()
  expect(invalid.type).toBe("failed")
  expect(invalid.error).toContain("cog_")
  expect(invalid.error).toContain("apk_")
  expect((await (await method.authorize({ key: index ? "apk_other" : "cog_other" })).callback()).type).toBe("failed")
})

test("Codeium streams text before the vendor finishes and maps the existing model", async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const textFrame = text => {
    const bytes = new TextEncoder().encode(text), result = new Uint8Array(7 + bytes.length)
    new DataView(result.buffer).setUint32(1, bytes.length + 2)
    result[5] = 26; result[6] = bytes.length; result.set(bytes, 7)
    return result
  }
  const server = startFakeCodeium({ scenario: ({ body }) => {
    expect(new TextDecoder().decode(body)).toContain("swe-2-high")
    return new Response(new ReadableStream({ async start(stream) {
      stream.enqueue(textFrame("First")); await gate
      stream.enqueue(textFrame(" second"))
      stream.enqueue(Uint8Array.from([2, 0, 0, 0, 2, 123, 125])); stream.close()
    } }))
  } }); servers.push(server)
  const loader = await makeDevinCloud({ apiBase: { "devin-cloud-codeium": server.url } }).auth.loader(codeiumAuth)
  try {
    const reader = (await request(loader, { stream: true })).body.getReader()
    let first = ""
    while (!first.includes("First")) first += new TextDecoder().decode((await reader.read()).value)
    expect(first).not.toContain("[DONE]")
    release()
    let rest = ""
    for (;;) { const part = await reader.read(); if (part.done) break; rest += new TextDecoder().decode(part.value) }
    expect(rest).toContain(" second"); expect(rest).toContain("[DONE]")
  } finally { release() }
})

test.each([["unauthenticated", 401], ["invalid_argument", 400], ["resource_exhausted", 429]])("Connect trailer %s maps to HTTP %s", async (code, status) => {
  const server = startFakeCodeium({ scenario: () => {
    const payload = new TextEncoder().encode(JSON.stringify({ error: { code, message: "vendor failure" } }))
    const frame = new Uint8Array(payload.length + 5)
    frame[0] = 2; new DataView(frame.buffer).setUint32(1, payload.length); frame.set(payload, 5)
    return new Response(frame)
  } }); servers.push(server)
  const loader = await makeDevinCloud({ apiBase: { "devin-cloud-codeium": server.url } }).auth.loader(codeiumAuth)
  const response = await request(loader)
  expect(response.status).toBe(status)
  expect((await response.json()).error.message).toContain("vendor failure")
})


test("default endpoints isolate stored mechanisms and retain their authorization schemes", async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers })
    if (String(url).startsWith("https://server.codeium.com/")) return new Response(Uint8Array.from([0, 0, 0, 0, 4, 26, 2, 79, 75, 2, 0, 0, 0, 2, 123, 125]))
    return Response.json(init.method === "POST" ? { session_id: "default-endpoint" } : { status_enum: "finished", messages: [{ type: "agent_message", message: "OK" }] })
  }
  try {
    const plugin = makeDevinCloud()
    for (const [key, mechanism] of [["cog_synthetic", "codeium"], ["apk_synthetic", "devin"]]) {
      const loader = await plugin.auth.loader(() => ({ type: "api", key, metadata: { mechanism } }))
      expect((await request(loader)).status).toBe(200)
    }
    expect(calls.map(call => call.url)).toEqual([
      "https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage",
      "https://api.devin.ai/v1/sessions", "https://api.devin.ai/v1/sessions/default-endpoint",
    ])
    expect(calls[0].headers.Authorization).toBe("Basic cog_synthetic")
    expect(calls[0].headers["Content-Type"]).toBe("application/connect+proto")
    expect(calls[1].headers.Authorization).toBe("Bearer apk_synthetic")
    for (const [key, mechanism] of [["cog_synthetic", "devin"], ["apk_synthetic", "codeium"]]) {
      const loader = await plugin.auth.loader(() => ({ type: "api", key, metadata: { mechanism } }))
      expect((await request(loader)).status).toBe(401)
    }
    expect(calls).toHaveLength(3)
  } finally { globalThis.fetch = originalFetch }
})


test.each([0, 1])("successful sign-in %s round trips through stored OAuth into a working loader", async index => {
  const platform = startFakeCloud(); servers.push(platform)
  const connect = startFakeCodeium(); servers.push(connect)
  const plugin = makeDevinCloud({ apiBase: { "devin-cloud": platform.url + "/devin", "devin-cloud-codeium": connect.url } })
  const method = plugin.auth.methods[index]
  const outcome = await (await method.authorize({ key: index ? "cog_synthetic" : "apk_synthetic" })).callback()
  expect(outcome.type).toBe("success")
  const stored = JSON.parse(JSON.stringify({ ...outcome, type: method.type }))
  const loader = await plugin.auth.loader(() => stored)
  expect(typeof loader.fetch).toBe("function")
  const response = await request(loader)
  expect(response.status).toBe(200)
  expect((await response.json()).choices[0].message.content).toBe(index ? "Synthetic Codeium answer" : "Synthetic Devin answer")
  expect(index ? platform.requests.length : connect.requests.length).toBe(0)
})

test.each(["sk_foreign", "devin-session-token$legacy"])("models preserve the floor for unknown credential %s", async key => {
  const plugin = makeDevinCloud(), provider = { models: { "devin-session": { name: "Custom" } } }
  expect(await plugin.provider.models(provider, { auth: { type: "api", key } })).toBe(provider.models)
})

test("legacy credentials are identified and refused before network access", async () => {
  const { plugin, server } = await setup()
  const loader = await plugin.auth.loader(() => ({ type: "api", key: "devin-session-token$legacy" }))
  const response = await request(loader)
  expect(response.status).toBe(401)
  const message = (await response.json()).error.message
  for (const prefix of ["cog_", "apk_", "devin-session-token$"]) expect(message).toContain(prefix)
  expect(server.requests).toHaveLength(0)
})

test.each([false, true])("Codeium deadline after first text is 504 with stream=%s", async stream => {
  const originalTimeout = AbortSignal.timeout, originalFetch = globalThis.fetch
  const deadline = new AbortController()
  AbortSignal.timeout = () => deadline.signal
  globalThis.fetch = async (url, { signal }) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(Uint8Array.from([0, 0, 0, 0, 4, 26, 2, 79, 75]))
    signal.addEventListener("abort", () => controller.error(signal.reason), { once: true })
  } }))
  try {
    const loader = await makeDevinCloud().auth.loader(codeiumAuth)
    const pending = request(loader, { stream })
    if (stream) {
      const response = await pending
      deadline.abort(new DOMException("The operation timed out.", "TimeoutError"))
      const events = (await response.text()).split("\n\n").filter(value => value.startsWith("data: {")).map(value => JSON.parse(value.slice(6)))
      expect(events.find(event => event.error)?.error).toMatchObject({ code: 504, message: "Codeium request timed out" })
    } else {
      await new Promise(resolve => setTimeout(resolve, 0))
      deadline.abort(new DOMException("The operation timed out.", "TimeoutError"))
      const response = await pending
      expect(response.status).toBe(504)
      expect((await response.json()).error.message).toBe("Codeium request timed out")
    }
  } finally { AbortSignal.timeout = originalTimeout; globalThis.fetch = originalFetch }
})

function protoString(field, value) {
  const bytes = Buffer.from(value), tag = field * 8 + 2
  return Buffer.concat([Buffer.from(tag < 128 ? [tag, bytes.length] : [(tag & 127) | 128, tag >> 7, bytes.length]), bytes])
}
const modelFixture = () => Buffer.concat([
  protoString(1, Buffer.concat([protoString(1, "SWE Slow"), protoString(22, "swe-1-6-slow")])),
  protoString(1, Buffer.concat([protoString(1, "SWE High"), protoString(22, "swe-2-high"), protoString(30, "#Upgrade to Pro to access this model")])),
])
test("session title excludes system text and supports an explicit driver title", async () => {
  const { loader, server, driver } = await setup()
  await request(loader, { messages: [{ role: "system", content: "PRIVATE INSTRUCTIONS" }, ...messages] })
  expect(server.requests[0].body.title).toBe("magpie session")
  await driver.create(auth(), { prompt: "PRIVATE INSTRUCTIONS", title: "User task" })
  expect(server.requests.at(-1).body.title).toBe("User task")
})

test("session headers initialize an absent headers object", async () => {
  const output = {}
  await makeDevinCloud()["chat.headers"]({ model: { providerID: "devin-cloud" }, sessionID: "session" }, output)
  expect(output.headers).toEqual({ [SESSION_HEADER]: "session" })
})

test.each([false, true])("Codeium accepts byte-fragmented frames with compression=%s", async compressed => {
  const message = Buffer.concat([protoString(3, "fragmented answer")])
  const payload = compressed ? gzipSync(message) : message
  const frame = Buffer.alloc(5 + payload.length)
  frame[0] = compressed ? 1 : 0; frame.writeUInt32BE(payload.length, 1); payload.copy(frame, 5)
  const bytes = Buffer.concat([frame, Buffer.from([2, 0, 0, 0, 2, 123, 125])])
  const plugin = makeDevinCloud({ fetch: async () => {
    let offset = 0
    return new Response(new ReadableStream({ pull(controller) {
      if (offset === bytes.length) { controller.close(); return }
      controller.enqueue(bytes.subarray(offset, ++offset))
    } }))
  } })
  const response = await request(await plugin.auth.loader(codeiumAuth))
  expect(response.status).toBe(200)
  expect((await response.json()).choices[0].message.content).toBe("fragmented answer")
})

test("Codeium rejects gzip output over the frame limit", async () => {
  const compressed = gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1))
  const frame = Buffer.alloc(5 + compressed.length)
  frame[0] = 1; frame.writeUInt32BE(compressed.length, 1); compressed.copy(frame, 5)
  const plugin = makeDevinCloud({ fetch: async () => new Response(frame) })
  const response = await request(await plugin.auth.loader(codeiumAuth))
  expect(response.status).toBe(502)
  expect((await response.json()).error.message).toMatch(/larger than|too large|size|length/i)
})

const connectOK = () => new Response(Uint8Array.from([0, 0, 0, 0, 4, 26, 2, 79, 75, 2, 0, 0, 0, 2, 123, 125]))

test("Codeium live model discovery filters upgrades and caches per credential", async () => {
  const calls = []
  const plugin = makeDevinCloud({ fetch: async (url, init) => {
    calls.push({ url, init })
    return new Response(modelFixture())
  } })
  const provider = { models: { "devin-session": {}, custom: { name: "Custom" } } }
  const listed = await plugin.provider.models(provider, { auth: codeiumAuth() })
  expect(Object.keys(listed)).toEqual(["swe-1-6-slow", "custom"])
  expect(listed["swe-1-6-slow"]).toEqual({ name: "SWE Slow", tool_call: false, reasoning: false })
  await plugin.provider.models(provider, { auth: codeiumAuth() })
  expect(calls).toHaveLength(1)
  expect(calls[0].url).toEndWith("/GetCliModelConfigs")
  expect(calls[0].init.headers["Content-Type"]).toBe("application/proto")
  expect(Buffer.from(calls[0].init.body).toString()).toContain(codeiumAuth().key)
  await plugin.provider.models(provider, { auth: { type: "api", key: "cog_other" } })
  expect(calls).toHaveLength(2)
})

test.each(["http", "network", "malformed"])("Codeium model discovery falls back on %s failure", async kind => {
  const plugin = makeDevinCloud({ fetch: async () => {
    if (kind === "network") throw new Error("offline")
    return kind === "http" ? new Response(null, { status: 503 }) : new Response(Uint8Array.of(255))
  } })
  expect(await plugin.provider.models({ models: {} }, { auth: codeiumAuth() })).toEqual({ "swe-2": { name: "SWE-2", tool_call: false, reasoning: false } })
})

test.each(["", "swe-2", "devin-session", "explicit-model"])("Codeium resolves known model alias %s", async model => {
  let sent
  const plugin = makeDevinCloud({ fetch: async (url, init) => {
    if (url.endsWith("/GetCliModelConfigs")) return new Response(modelFixture())
    sent = Buffer.from(init.body).toString()
    return connectOK()
  } })
  await plugin.provider.models({ models: {} }, { auth: codeiumAuth() })
  const loader = await plugin.auth.loader(codeiumAuth)
  expect((await request(loader, { model })).status).toBe(200)
  expect(sent).toContain(model === "explicit-model" ? model : "swe-1-6-slow")
  expect(sent).not.toContain("swe-2-high")
})

test("Codeium permission_denied trailer is 403 entitlement with sign-in kept", async () => {
  const plugin = makeDevinCloud({ fetch: async () => {
    const payload = Buffer.from(JSON.stringify({ error: { code: "permission_denied", message: "an internal error occurred" } }))
    const frame = Buffer.alloc(5 + payload.length)
    frame[0] = 2; frame.writeUInt32BE(payload.length, 1); payload.copy(frame, 5)
    return new Response(frame)
  } })
  const response = await request(await plugin.auth.loader(codeiumAuth), { model: "swe-2-high" })
  expect(response.status).toBe(403)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect((await response.json()).error.message).toContain("isn't entitled")
})

test("Codeium cache expiry refreshes discovery and never reuses another account's default", async () => {
  const originalNow = Date.now
  let now = originalNow(), discoveries = 0, sent
  Date.now = () => now
  const plugin = makeDevinCloud({ fetch: async (url, init) => {
    if (url.endsWith("/GetCliModelConfigs")) { discoveries++; return new Response(modelFixture()) }
    sent = Buffer.from(init.body).toString()
    return connectOK()
  } })
  try {
    await plugin.provider.models({ models: {} }, { auth: codeiumAuth() })
    const other = await plugin.auth.loader(() => ({ type: "api", key: "cog_other" }))
    await request(other)
    expect(sent).toContain("swe-2-high")
    now += 5 * 60000
    await request(await plugin.auth.loader(codeiumAuth))
    expect(sent).toContain("swe-2-high")
    await plugin.provider.models({ models: {} }, { auth: codeiumAuth() })
    expect(discoveries).toBe(2)
    await request(await plugin.auth.loader(codeiumAuth))
    expect(sent).toContain("swe-1-6-slow")
  } finally { Date.now = originalNow }
})
