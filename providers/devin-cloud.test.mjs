import { test, expect, afterEach } from "bun:test"
import { makeDevinCloud, makeDevinDriver } from "./devin-cloud.mjs"
import { FollowupRejected } from "../lib/errors.mjs"
import { emulate } from "../lib/emulate.mjs"
import { SESSION_HEADER } from "../lib/sessions.mjs"
import { foldPrompt } from "../lib/transcript.mjs"
import { startFakeCloud } from "../scripts/fake-cloud.mjs"

const servers = []
afterEach(() => { for (const server of servers.splice(0)) server.stop() })
const auth = () => ({ type: "api", key: "SYNTHETIC" })
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
const fastTimers = {
  now: () => Date.now(), random: () => 0.5,
  setTimeout: (callback, delay) => setTimeout(callback, delay < 15000 ? 0 : delay),
  clearTimeout: timer => clearTimeout(timer),
}

test.each([undefined, 0, 12])("create fields and optional ACU ceiling %s", async maxAcuLimit => {
  let authorized = false, privateHeader = false
  const { loader, server } = await setup(({ request }) => {
    authorized = request.headers.get("authorization") === "Bearer SYNTHETIC"
    privateHeader ||= request.headers.has(SESSION_HEADER)
  }, { devinCloud: { maxAcuLimit } })
  const promptMessages = [{ role: "user", content: "x".repeat(100) }]
  await request(loader, { messages: promptMessages }, { headers: { [SESSION_HEADER]: "conversation" } })
  const prompt = foldPrompt(promptMessages)
  expect(server.requests[0].body).toEqual({ prompt, title: "magpie: " + prompt.slice(0, 60), tags: ["magpie"], ...(maxAcuLimit ? { max_acu_limit: maxAcuLimit } : {}) })
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
  expect(plugin.auth.methods[0].type).toBe("api")
  expect(plugin.auth.methods[0].authorize).toBeUndefined()
  expect(plugin.auth.maxConcurrency).toBe(4)
  expect(driver.cancel).toBeUndefined()
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

test("abort closes stream without deleting the cloud session", async () => {
  const { loader, server } = await setup(polling({ status_enum: "working" }))
  const controller = new AbortController()
  const response = await request(loader, { stream: true }, { signal: controller.signal })
  const reading = response.text()
  controller.abort()
  await reading
  expect(server.requests.every(row => row.method !== "DELETE")).toBe(true)
  expect(server.sessions.size).toBe(1)
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
