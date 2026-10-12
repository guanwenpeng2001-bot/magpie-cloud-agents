import { test, expect, beforeAll, afterAll } from "bun:test"
import { makeCursorCloud, _internal } from "./cursor-cloud.mjs"
import { startFakeCloud } from "../scripts/fake-cloud.mjs"

const originalFetch = globalThis.fetch
beforeAll(() => { globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input)
  if (url.hostname !== "127.0.0.1") throw new Error("test blocked a non-loopback fetch")
  return originalFetch(input, init)
} })
afterAll(() => { globalThis.fetch = originalFetch })

const AUTH = { type: "api", key: "FAKE-CURSOR-TEST-KEY" }
const CHAT_URL = "https://cursor-cloud.cloud-agents.invalid/v1/chat/completions"
const AGENT_ID_SHAPE = /^bc-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const messages = [{ role: "user", content: "Fix the failing test" }]

async function harness(scenario, options = {}, getAuth = () => AUTH) {
  const server = startFakeCloud({ scenario })
  const plugin = makeCursorCloud({ apiBase: { "cursor-cloud": server.url + "/cursor" }, ...options })
  const loader = await plugin.auth.loader(getAuth)
  return { server, plugin, loader, fetch: loader.fetch, stop: () => server.stop() }
}

async function withHarness(scenario, run, options = {}, getAuth = () => AUTH) {
  const h = await harness(scenario, options, getAuth)
  try { return await run(h) } finally { h.stop() }
}

const chat = (fetcher, body = {}, init = {}) =>
  fetcher(CHAT_URL, { method: "POST", body: JSON.stringify({ model: "composer-2", messages, ...body }), ...init })
const withSession = { headers: { "x-magpie-cloud-agents-session": "conversation-test" } }

const frames = text => text.trim().split("\n\n").map(frame => frame.slice(6)).map(frame => frame === "[DONE]" ? frame : JSON.parse(frame))
const streamed = async response => {
  const events = frames(await response.text())
  return { events, content: events.flatMap(event => event.choices?.[0]?.delta?.content ?? []).join("") }
}
const vendor = ({ agentId = "bc-scenario", run, stream, ...routes } = {}) => {
  run = { id: "run-1", ...run }
  const agent = { id: agentId, status: "IDLE", url: "placeholder", latestRunId: run.id }
  return async ({ request, url, body }) => {
    for (const [pattern, handler] of Object.entries(routes)) if (url.pathname.endsWith(pattern)) return handler({ request, url, body })
    if (url.pathname.endsWith("/v1/agents") && request.method === "POST")
      return Response.json({ agent: { ...agent, url: `${url.origin}/cursor/agents/${body?.agentId ?? agentId}` }, run })
    if (url.pathname.endsWith("/stream")) return stream ? stream({ request, url }) : new Response("no stream in this scenario", { status: 503 })
    if (url.pathname.includes("/runs/")) return Response.json(run)
    return undefined
  }
}
const sse = rows => new Response(rows.map(([event, id, data]) => `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } })

test("create sends Basic auth, the folded prompt, model id, deterministic agentId and name", async () => {
  const calls = []
  await withHarness(({ request, url, body }) => {
    if (url.pathname.endsWith("/v1/agents") && request.method === "POST") calls.push({ headers: Object.fromEntries(request.headers), body })
  }, async ({ fetch }) => { await chat(fetch, {}, withSession) })
  expect(calls).toHaveLength(1)
  expect(calls[0].headers.authorization).toBe("Basic " + Buffer.from(AUTH.key + ":").toString("base64"))
  expect(calls[0].headers["content-type"]).toBe("application/json")
  expect(calls[0].body.prompt.text).toContain("Current request:")
  expect(calls[0].body.prompt.text).toContain("Fix the failing test")
  expect(calls[0].body.model).toEqual({ id: "composer-2" })
  expect(calls[0].body.agentId).toMatch(AGENT_ID_SHAPE)
  expect(calls[0].body.name).toStartWith("magpie: ")
})

test("the agentId is deterministic for a fixed session key and absent without one", async () => {
  const ids = []
  for (let attempt = 0; attempt < 2; attempt++) {
    await withHarness(undefined, async ({ fetch, server }) => {
      await chat(fetch, {}, withSession)
      ids.push(server.requests.find(call => call.body?.prompt).body.agentId)
    })
  }
  expect(ids[0]).toMatch(AGENT_ID_SHAPE)
  expect(ids[1]).toBe(ids[0])
  await withHarness(undefined, async ({ fetch, server }) => {
    await chat(fetch)
    expect(server.requests.find(call => call.body?.prompt).body.agentId).toBeUndefined()
  })
})

test("cursorCloud.repos passes through to the create body", async () => {
  const repos = [{ url: "https://github.com/org/repo", startingRef: "main" }]
  await withHarness(undefined, async ({ fetch, server }) => {
    await chat(fetch)
    expect(server.requests.find(call => call.body?.prompt).body.repos).toEqual(repos)
  }, { cursorCloud: { repos } })
})

test("409 agent_id_conflict converts to attach-by-GET and still answers", async () => {
  await withHarness(async ({ request, url }) => {
    if (request.method === "POST" && url.pathname.endsWith("/v1/agents")) return new Response(JSON.stringify({ error: "agent_id_conflict" }), { status: 409 })
    const agentId = url.pathname.split("/").at(-1)
    if (request.method === "GET" && /^bc-/.test(agentId)) return Response.json({ id: agentId, status: "IDLE", latestRunId: "run-newer", url: url.origin + "/cursor/agents/" + agentId })
    if (url.pathname.endsWith("/runs")) return Response.json({ items: [{ id: "run-1", createdAt: "2026-01-01T00:00:00Z" }, { id: "run-newer", createdAt: "2026-01-02T00:00:00Z" }] })
    if (url.pathname.includes("/runs/")) return Response.json({ id: url.pathname.split("/").at(-1), agentId: url.pathname.split("/")[4], prompt: { text: url.pathname.endsWith("run-1") ? "Current request:\nFix the failing test" : "Another request" }, status: "FINISHED", result: url.pathname.endsWith("run-1") ? "Reattached answer" : "Wrong newer answer" })
  }, async ({ fetch, server }) => {
    const body = await (await chat(fetch, {}, withSession)).json()
    expect(body.choices[0].message.content).toBe("Reattached answer")
    expect(server.requests.some(call => call.method === "GET" && /\/v1\/agents\/bc-/.test(call.path))).toBe(true)
  })
})

test("the SSE path streams progress and answers from the verified result field", async () => {
  await withHarness(undefined, async ({ fetch, server }) => {
    const response = await chat(fetch, { stream: true })
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const { events, content } = await streamed(response)
    expect(content).toBe("Synthetic Cursor answer")
    expect(events.at(-1)).toBe("[DONE]")
    expect(events.some(event => event.choices?.[0].delta.reasoning_content?.includes("/cursor/agents/"))).toBe(true)
    expect(server.requests.some(call => call.path.endsWith("/stream"))).toBe(true)
    expect(server.requests.some(call => call.method === "GET" && /\/runs\/run-\d+$/.test(call.path))).toBe(true)
  })
})

test("SSE reconnects carry Last-Event-ID after a mid-stream disconnect", async () => {
  const streams = []
  await withHarness(async ({ request, url, body }) => {
    if (url.pathname.endsWith("/stream")) {
      streams.push(Object.fromEntries(request.headers))
      if (streams.length === 1) return new Response('id: evt-1\nevent: status\ndata: {"status":"RUNNING"}\n\n', { headers: { "Content-Type": "text/event-stream" } })
      return sse([["done", null, { status: "FINISHED" }]])
    }
    if (url.pathname.includes("/runs/")) return Response.json({ id: "run-1", status: "FINISHED", result: "Resumed answer" })
    if (url.pathname.endsWith("/v1/agents")) return Response.json({ agent: { id: body.agentId ?? "bc-resume", status: "IDLE", url: url.origin + "/cursor/agents/resume" }, run: { id: "run-1", status: "CREATING" } })
  }, async ({ fetch }) => {
    const { content } = await streamed(await chat(fetch, { stream: true }))
    expect(content).toBe("Resumed answer")
    expect(streams).toHaveLength(2)
    expect(streams[1]["last-event-id"]).toBe("evt-1")
  })
})

test("poll fallback walks the run to a terminal status", async () => {
  let gets = 0
  await withHarness(async ({ request, url, body }) => {
    if (url.pathname.endsWith("/v1/agents") && request.method === "POST")
      return Response.json({ agent: { id: body.agentId ?? "bc-poll", status: "IDLE", url: `${url.origin}/cursor/agents/poll` }, run: { id: "run-1", status: "CREATING" } })
    if (url.pathname.endsWith("/stream")) return new Response("stream unavailable", { status: 503 })
    if (url.pathname.includes("/runs/")) {
      gets++
      return gets === 1 ? Response.json({ id: "run-1", status: "RUNNING" }) : Response.json({ id: "run-1", status: "FINISHED", result: "Answer after polling" })
    }
  }, async ({ fetch }) => {
    expect(await (await chat(fetch)).json()).toEqual(expect.objectContaining({ object: "chat.completion" }))
    expect(gets).toBeGreaterThanOrEqual(2)
  })
}, 15000)

test.each([
  ["FINISHED", { status: "FINISHED", result: "" }, 200, "without writing a reply"],
  ["ERROR with partial result", { status: "ERROR", result: "Partial work finished before the fault" }, 200, "⚠ run ended ERROR"],
  ["ERROR without result", { status: "ERROR", result: "" }, 502, "run failed"],
  ["CANCELLED", { status: "CANCELLED", result: "" }, 502, "run failed"],
  ["EXPIRED", { status: "EXPIRED", result: "" }, 502, "expired before finishing"],
])("terminal %s maps to status %s", async (_name, run, expected, fragment) => {
  await withHarness(vendor({ run }), async ({ fetch }) => {
    const response = await chat(fetch)
    expect(response.status).toBe(expected)
    const body = await response.json()
    if (expected === 200) expect(body.choices[0].message.content).toContain(fragment)
    else {
      expect(body.error.message).toContain(fragment)
      expect(response.headers.get("X-Magpie-Sign-In")).toBe("kept")
    }
  })
})

test("git.branches lines are appended when non-empty", async () => {
  await withHarness(vendor({
    run: { id: "run-1", status: "FINISHED", result: "Shipped the fix", git: { branches: [{ repoUrl: "github.com/org/repo", branch: "cursor/fix-thing", prUrl: "https://github.com/org/repo/pull/9" }] } },
  }), async ({ fetch }) => {
    const body = await (await chat(fetch)).json()
    const content = body.choices[0].message.content
    expect(content).toContain("Shipped the fix")
    expect(content).toContain("github.com/org/repo")
    expect(content).toContain("cursor/fix-thing")
    expect(content).toContain("https://github.com/org/repo/pull/9")
  })
})

test("follow-up reuses the agent through POST runs", async () => {
  await withHarness(undefined, async ({ fetch, server }) => {
    expect((await chat(fetch, {}, withSession)).status).toBe(200)
    const next = [...messages, { role: "assistant", content: "Synthetic Cursor answer" }, { role: "user", content: "Next instruction" }]
    expect((await chat(fetch, { messages: next }, withSession)).status).toBe(200)
    const follow = server.requests.filter(call => call.method === "POST" && call.path.endsWith("/runs"))
    expect(follow).toHaveLength(1)
    expect(follow[0].body.prompt.text).toBe("Next instruction")
    expect(server.requests.filter(call => call.path.endsWith("/v1/agents"))).toHaveLength(1)
  })
})

test("a busy agent returns the 409 message instead of queueing", async () => {
  await withHarness(async ({ request, url }) => {
    if (url.pathname.endsWith("/runs") && request.method === "POST") return new Response(JSON.stringify({ error: "agent_busy" }), { status: 409 })
  }, async ({ fetch }) => {
    expect((await chat(fetch, {}, withSession)).status).toBe(200)
    const next = [...messages, { role: "assistant", content: "Synthetic Cursor answer" }, { role: "user", content: "Next instruction" }]
    const response = await chat(fetch, { messages: next }, withSession)
    expect(response.status).toBe(409)
    expect(response.headers.get("X-Magpie-Sign-In")).toBe("kept")
    expect((await response.json()).error.message).toContain("still working on the previous request")
  })
})

test("a 404 follow-up starts a fresh create with the full fold", async () => {
  await withHarness(async ({ request, url }) => {
    if (url.pathname.endsWith("/runs") && request.method === "POST") return new Response("not found", { status: 404 })
  }, async ({ fetch, server }) => {
    expect((await chat(fetch, {}, withSession)).status).toBe(200)
    const next = [...messages, { role: "assistant", content: "Synthetic Cursor answer" }, { role: "user", content: "Next instruction" }]
    expect((await chat(fetch, { messages: next }, withSession)).status).toBe(200)
    expect(server.requests.filter(call => call.method === "POST" && call.path.endsWith("/v1/agents"))).toHaveLength(2)
  })
})

test("abort posts the cancel endpoint and tolerates run_not_cancellable", async () => {
  const controller = new AbortController()
  let cancelled
  const received = new Promise(resolve => { cancelled = resolve })
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    if (path.endsWith("/cancel")) {
      expect(request.method).toBe("POST")
      expect(await request.text()).toBe("")
      cancelled(path)
      return Response.json({ error: "run_not_cancellable" }, { status: 409 })
    }
    if (path.endsWith("/v1/agents")) return Response.json({ agent: { id: "bc-cancel" }, run: { id: "run-1" } })
    return new Response(new ReadableStream({ start(output) { output.enqueue(new TextEncoder().encode('event: status\ndata: {"status":"RUNNING"}\n\n')) } }), { headers: { "Content-Type": "text/event-stream" } })
  } })
  try {
    const loader = await makeCursorCloud({ apiBase: { "cursor-cloud": server.url.origin } }).auth.loader(() => AUTH)
    const response = await chat(loader.fetch, { stream: true }, { signal: controller.signal })
    const reading = response.text()
    controller.abort()
    await reading
    expect(await received).toBe("/v1/agents/bc-cancel/runs/run-1/cancel")
  } finally { server.stop(true) }
})

test("grok_ keys are rejected before any vendor call", async () => {
  await withHarness(undefined, async ({ fetch, server }) => {
    const response = await chat(fetch)
    expect(response.status).toBe(403)
    expect(response.headers.get("X-Magpie-Sign-In")).toBe("kept")
    expect((await response.json()).error.message).toContain("key_not_supported")
    expect(server.requests).toHaveLength(0)
  }, {}, () => ({ type: "api", key: "grok_unsupported" }))
})

test.each([
  ["create", 401, "invalid api key", 401, "expired"],
  ["create", 429, "slow down", 429, "kept"],
])("vendor %s failure %s carries the wording and marker %s/%s", async (_where, status, wording, expected, marker) => {
  await withHarness(async () => new Response(wording, { status }), async ({ fetch }) => {
    const response = await chat(fetch)
    expect(response.status).toBe(expected)
    expect(response.headers.get("X-Magpie-Sign-In")).toBe(marker)
    const message = (await response.json()).error.message
    expect(message).toContain(wording)
    if (marker === "expired") expect(message).toContain("magpie plugin login cursor-cloud")
  })
})

test("an unreachable vendor is a 502 kept", async () => {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const port = listener.port
  listener.stop(true)
  await withHarness(undefined, async ({ fetch }) => {
    const response = await chat(fetch)
    expect(response.status).toBe(502)
    expect(response.headers.get("X-Magpie-Sign-In")).toBe("kept")
  }, { apiBase: { "cursor-cloud": `http://127.0.0.1:${port}` } })
})

test("the run cap returns 504 while keeping the run attached", async () => {
  await withHarness(vendor({ run: { id: "run-1", status: "RUNNING" } }), async ({ fetch }) => {
    const response = await chat(fetch)
    expect(response.status).toBe(504)
    expect((await response.json()).error.message).toContain("is still running after")
  }, { maxRunMinutes: 0.01 })
})

test("auth vanished mid-session marks the account expired", async () => {
  let current = AUTH
  await withHarness(undefined, async ({ fetch }) => {
    expect((await chat(fetch)).status).toBe(200)
    current = null
    const response = await chat(fetch)
    expect(response.status).toBe(401)
    expect(response.headers.get("X-Magpie-Sign-In")).toBe("expired")
    expect((await response.json()).error.message).toContain("isn't signed in")
  }, {}, () => current)
})

test("the loader stays out of the way when not signed in", async () => {
  const loader = await makeCursorCloud().auth.loader(async () => null)
  expect(loader).toEqual({})
})

test("first published Cursor model is vendor-recognised while the rejected floor remains", async () => {
  const recognised = "claude-sonnet-4-5"
  await withHarness(vendor({
    run: { status: "FINISHED", result: "recognised model completed" },
    "/v1/models": () => Response.json({ models: [{ id: recognised, name: "Live Sonnet" }] }),
    "/v1/agents": ({ body }) => body.model.id === recognised
      ? Response.json({ agent: { id: "accepted-agent" }, run: { id: "run-1" } })
      : Response.json({ message: `Model '${body.model.id}' is not available or invalid.` }, { status: 400 }),
  }), async ({ plugin, fetch }) => {
    const rejected = await chat(fetch)
    expect(rejected.status).toBe(400)
    expect(await rejected.text()).toContain("Model 'composer-2' is not available or invalid.")
    const config = {}; await plugin.config(config)
    const models = await plugin.provider.models(config.provider["cursor-cloud"], { auth: AUTH })
    const first = Object.keys(models)[0]
    expect(first).toBe(recognised)
    expect(models["composer-2"]).toBeDefined()
    expect(models[first].name).toBe("Live Sonnet")
    const accepted = await chat(fetch, { model: first })
    expect(accepted.status).toBe(200)
    expect(await accepted.text()).toContain("recognised model completed")
  })
})

test("models parse accepts the wrapped and bare shapes and falls back to the floor", async () => {
  const floor = { "composer-2": { name: "Composer 2" }, "claude-sonnet-4-5": { name: "Claude Sonnet 4.5" } }
  const check = (scenario, probe) => withHarness(scenario, async ({ plugin }) => {
    const models = await plugin.provider.models({ models: floor }, { auth: AUTH })
    probe(models)
  })
  await check(({ url }) => {
    if (url.pathname.endsWith("/v1/models")) return Response.json({ models: [{ id: "composer-2", name: "Composer 2" }, { id: "composer-3", name: "Composer 3" }] })
  }, models => {
    expect(models["composer-2"]).toMatchObject({ name: "Composer 2", capabilities: { toolcall: false, reasoning: false } })
    expect(models["composer-3"]).toMatchObject({ name: "Composer 3", capabilities: { toolcall: false, reasoning: false } })
    expect(models["claude-sonnet-4-5"]).toEqual({ name: "Claude Sonnet 4.5" })
  })
  await check(({ url }) => {
    if (url.pathname.endsWith("/v1/models")) return Response.json([{ model: "composer-4" }])
  }, models => expect(models["composer-4"]).toMatchObject({ name: "composer-4", capabilities: { toolcall: false, reasoning: false } }))
  await check(({ url }) => {
    if (url.pathname.endsWith("/v1/models")) return Response.json({ unexpected: true })
  }, models => expect(Object.keys(models).sort()).toEqual(["claude-sonnet-4-5", "composer-2"]))
  await withHarness(async ({ url }) => {
    if (url.pathname.endsWith("/v1/models")) return new Response("bad key", { status: 401 })
  }, async ({ plugin }) => {
    let thrown
    try { await plugin.provider.models({ models: floor }, { auth: AUTH }) }
    catch (error) { thrown = error }
    expect(thrown?.status).toBe(401)
    expect(thrown?.signIn).toBe("expired")
  })
})

test("models parse accepts the vendor's measured items envelope, surfaces displayName, and keeps the floor", async () => {
  // Transcribed verbatim (a representative subset of rows, real field structure
  // preserved) from the sweep's captured vendor response:
  // runs/cloud-agent-providers/evidence/live-acceptance-sweep/probe-cursor-models.txt
  //   GET https://api.cursor.com/v1/models -> HTTP 200  {"items":[ ... ]}
  const floor = { "composer-2": { name: "Composer 2" }, "claude-sonnet-4-5": { name: "Claude Sonnet 4.5" } }
  const probe = {
    items: [
      { "id":"default","displayName":"Auto","aliases":["auto"],"variants":[{"params":[],"displayName":"Auto","isDefault":true}] },
      { "id":"composer-2.5","displayName":"Composer 2.5","aliases":["composer-latest","composer","composer-2-5"],"parameters":[{"id":"fast","displayName":"Fast","values":[{"value":"false"},{"value":"true","displayName":"Fast"}]}],"variants":[{"params":[{"id":"fast","value":"true"}],"displayName":"Composer 2.5","isDefault":true},{"params":[{"id":"fast","value":"false"}],"displayName":"Composer 2.5"}] },
      { "id":"gemini-3.1-pro","displayName":"Gemini 3.1 Pro","aliases":["gemini-latest","gemini-pro-latest","gemini","gemini-pro"],"variants":[{"params":[],"displayName":"Gemini 3.1 Pro","isDefault":true}] },
      { "id":"claude-sonnet-4-5","displayName":"Claude Sonnet 4.5","aliases":["sonnet","sonnet-4.5","sonnet-4-5"],"parameters":[{"id":"thinking","displayName":"Thinking","values":[{"value":"false"},{"value":"true"}]},{"id":"context","displayName":"Context","values":[{"value":"200k","displayName":"200K"}]}],"variants":[{"params":[{"id":"thinking","value":"false"},{"id":"context","value":"200k"}],"displayName":"Claude Sonnet 4.5"},{"params":[{"id":"thinking","value":"true"},{"id":"context","value":"200k"}],"displayName":"Claude Sonnet 4.5","isDefault":true}] },
      { "id":"kimi-k3","displayName":"Kimi K3","parameters":[{"id":"reasoning","displayName":"Reasoning","values":[{"value":"low","displayName":"Low"},{"value":"high","displayName":"High"},{"value":"max","displayName":"Max"}]}],"variants":[{"params":[{"id":"reasoning","value":"low"}],"displayName":"Kimi K3"},{"params":[{"id":"reasoning","value":"high"}],"displayName":"Kimi K3"},{"params":[{"id":"reasoning","value":"max"}],"displayName":"Kimi K3","isDefault":true}] },
    ],
  }
  await withHarness(({ url }) => {
    if (url.pathname.endsWith("/v1/models")) return Response.json(probe)
  }, async ({ plugin }) => {
    const models = await plugin.provider.models({ models: floor }, { auth: AUTH })
    expect(Object.keys(models).sort()).toEqual(["claude-sonnet-4-5", "composer-2", "composer-2.5", "default", "gemini-3.1-pro", "kimi-k3"])
    expect(models["default"]).toMatchObject({ name: "Auto", capabilities: { toolcall: false, reasoning: false } })
    expect(models["composer-2.5"]).toMatchObject({ name: "Composer 2.5", capabilities: { toolcall: false, reasoning: false } })
    expect(models["gemini-3.1-pro"]).toMatchObject({ name: "Gemini 3.1 Pro", capabilities: { toolcall: false, reasoning: false } })
    expect(models["kimi-k3"]).toMatchObject({ name: "Kimi K3", capabilities: { toolcall: false, reasoning: false } })
    expect(models["claude-sonnet-4-5"]).toMatchObject({ name: "Claude Sonnet 4.5" })
    expect(models["composer-2"]).toMatchObject({ name: "Composer 2" })
  })
})

test("the chat.headers hook sets the session only for this provider and real sessions", async () => {
  const plugin = makeCursorCloud()
  const set = async (input, sessionID) => {
    const output = { headers: {} }
    await plugin["chat.headers"]({ ...input, sessionID }, output)
    return output.headers
  }
  expect(await set({ model: { providerID: "cursor-cloud" } }, "conv-1")).toEqual({ "x-magpie-cloud-agents-session": "conv-1" })
  expect(await set({ model: { providerID: "cursor-cloud" } }, "magpie-0123456789abcdef01234567")).toEqual({})
  expect(await set({ model: { providerID: "other" } }, "conv-1")).toEqual({})
  expect(await set({ provider: { info: { id: "cursor-cloud" } } }, "conv-2")).toEqual({ "x-magpie-cloud-agents-session": "conv-2" })
})

test("non-chat paths and garbage bodies are answered before credentials", async () => {
  await withHarness(undefined, async ({ fetch }) => {
    expect((await fetch("https://cursor-cloud.cloud-agents.invalid/v1/models")).status).toBe(404)
    expect((await fetch(CHAT_URL, { method: "POST", body: "{" })).status).toBe(400)
  })
})

test("config declares the provider with the static floor and prose-only models", async () => {
  const plugin = makeCursorCloud()
  const cfg = { provider: {} }
  await plugin.config(cfg)
  const declared = cfg.provider["cursor-cloud"]
  expect(declared.name).toBe("Cursor Cloud Agents")
  expect(declared.npm).toBe("@ai-sdk/openai-compatible")
  expect(declared.api).toContain(".invalid")
  expect(declared.models["composer-2"]).toMatchObject({ name: "Composer 2", tool_call: false })
  expect(declared.models["claude-sonnet-4-5"].tool_call).toBe(false)
})

test("403 authentication wording and 404 not-found carry through", async () => {
  const responses = { "/v1/agents": [new Response("invalid api key", { status: 403 }), new Response("not found", { status: 404 })] }
  await withHarness(async ({ url }) => {
    const next = responses["/" + url.pathname.split("/").slice(-2).join("/")] ?? responses["/" + url.pathname.split("/").pop()]
    return next?.shift()
  }, async ({ fetch }) => {
    const first = await chat(fetch)
    expect(first.status).toBe(401)
    expect(first.headers.get("X-Magpie-Sign-In")).toBe("expired")
    expect((await first.json()).error.message).toContain("sign in again with magpie plugin login cursor-cloud")
    const second = await chat(fetch)
    expect(second.status).toBe(404)
    expect(second.headers.get("X-Magpie-Sign-In")).toBe("kept")
  })
})

test("429 rate limiting surfaces the vendor wording with Retry-After", async () => {
  await withHarness(async () => new Response("quota exceeded", { status: 429, headers: { "Retry-After": "7" } }), async ({ fetch }) => {
    const response = await chat(fetch)
    expect(response.status).toBe(429)
    expect(response.headers.get("X-Magpie-Sign-In")).toBe("kept")
    expect(response.headers.get("Retry-After")).toBe("7")
    expect((await response.json()).error.message).toContain("quota exceeded — rate limited — try again after 7")
  })
})

test("each account's deterministic agentId is distinct", async () => {
  const other = { type: "api", key: "FAKE-CURSOR-OTHER-KEY" }
  const ids = []
  for (const auth of [() => AUTH, () => other]) {
    await withHarness(undefined, async ({ fetch, server }) => {
      await chat(fetch, {}, withSession)
      ids.push(server.requests.find(call => call.body?.prompt).body.agentId)
    }, {}, auth)
  }
  expect(ids[0]).toMatch(AGENT_ID_SHAPE)
  expect(ids[1]).toMatch(AGENT_ID_SHAPE)
  expect(ids[0]).not.toBe(ids[1])
})

test("edited history submits a different agent with the edited full fold", async () => {
  await withHarness(undefined, async ({ fetch, server }) => {
    expect((await chat(fetch, {}, withSession)).status).toBe(200)
    expect((await chat(fetch, { messages: [{ role: "user", content: "Edited instruction" }] }, withSession)).status).toBe(200)
    const creates = server.requests.filter(call => call.method === "POST" && call.path.endsWith("/v1/agents"))
    expect(creates).toHaveLength(2)
    expect(creates[0].body.agentId).not.toBe(creates[1].body.agentId)
    expect(creates[1].body.prompt.text).toBe("Current request:\nEdited instruction")
    expect(server.requests.some(call => call.method === "GET" && /\/v1\/agents\/[^/]+$/.test(call.path))).toBe(false)
    expect(server.sessions.size).toBe(2)
    const follow = server.requests.filter(call => call.method === "POST" && call.path.endsWith("/runs"))
    expect(follow).toHaveLength(0)
  })
})

test("an archived agent rejects the follow-up and fresh creates", async () => {
  await withHarness(async ({ request, url, body }) => {
    if (url.pathname.endsWith("/runs") && request.method === "POST") return new Response(JSON.stringify({ error: "too many active runs" }), { status: 409 })
    const id = url.pathname.split("/").at(-1)
    if (request.method === "GET" && /^bc-/.test(id)) return Response.json({ id, status: "ARCHIVED", latestRunId: "run-1", url: url.origin + "/cursor/agents/archived" })
    if (url.pathname.includes("/runs/")) return Response.json({ id: "run-1", status: "FINISHED", result: "Fresh answer" })
    if (url.pathname.endsWith("/v1/agents")) return Response.json({ agent: { id: body.agentId ?? "bc-archived", status: "ACTIVE", url: url.origin + "/cursor/agents/x" }, run: { id: "run-1" } })
  }, async ({ fetch, server }) => {
    expect((await chat(fetch, {}, withSession)).status).toBe(200)
    const next = [...messages, { role: "assistant", content: "Synthetic Cursor answer" }, { role: "user", content: "Next instruction" }]
    expect((await chat(fetch, { messages: next }, withSession)).status).toBe(200)
    expect(server.requests.filter(call => call.method === "POST" && call.path.endsWith("/v1/agents"))).toHaveLength(2)
  })
})

test("archived conflict escalates once; recovery retries attach at generation one", async () => {
  const ids = []
  const server = startFakeCloud({ scenario: ({ request, url, body, sessions }) => {
    if (request.method === "POST" && url.pathname.endsWith("/v1/agents")) ids.push(body.agentId)
    if (request.method === "GET" && /\/v1\/agents\/[^/]+$/.test(url.pathname)) {
      const stored = sessions.get(url.pathname.split("/").at(-1))
      if (stored) return Response.json({ ...stored.agent, latestRunId: stored.run.id })
    }
  } })
  const driver = _internal.makeDriver({ apiBase: { "cursor-cloud": server.url + "/cursor" } })
  const submission = { model: "composer-2", prompt: "hello", identity: { sessionKey: "recover" } }
  try {
    const first = await driver.create(AUTH, submission)
    expect((await driver.create(AUTH, submission)).ref).toBe(first.ref)
    server.sessions.get(first.ref).agent.status = "ARCHIVED"
    const recovered = await driver.create(AUTH, submission)
    expect(recovered.ref).not.toBe(first.ref)
    expect((await driver.create(AUTH, submission)).ref).toBe(recovered.ref)
    expect(server.sessions.size).toBe(2)
    expect(ids).toEqual([first.ref, first.ref, first.ref, recovered.ref, recovered.ref])
  } finally { server.stop() }
})

test("404 follow-up advances the deterministic generation and preserves recovery dedup", async () => {
  const server = startFakeCloud({ scenario: ({ request, url }) => {
    if (request.method === "POST" && url.pathname.endsWith("/runs")) return new Response("agent not found", { status: 404 })
  } })
  const driver = _internal.makeDriver({ apiBase: { "cursor-cloud": server.url + "/cursor" } })
  const submission = { model: "composer-2", prompt: "hello", identity: { sessionKey: "missing" } }
  try {
    const first = await driver.create(AUTH, submission)
    await expect(driver.followUp(AUTH, first, ["next"])).rejects.toMatchObject({ name: "FollowupRejected" })
    const recovered = await driver.create(AUTH, submission)
    expect(recovered.ref).not.toBe(first.ref)
    expect((await driver.create(AUTH, submission)).ref).toBe(recovered.ref)
    expect(server.sessions.size).toBe(2)
  } finally { server.stop() }
})

test("ERROR with branches but no result remains a failure", async () => {
  await withHarness(vendor({ run: { status: "ERROR", result: "", git: { branches: [{ branch: "old-work" }] } } }), async ({ fetch }) => {
    expect((await chat(fetch)).status).toBe(502)
  })
})

test.each([401, 429])("poll vendor %s retains its status and sign-in marker", async status => {
  await withHarness(({ url }) => {
    if (url.pathname.endsWith("/stream")) return new Response("unavailable", { status: 503 })
    if (/\/runs\/[^/]+$/.test(url.pathname)) return new Response("poll rejected", { status })
  }, async ({ fetch }) => {
    const response = await chat(fetch)
    expect(response.status).toBe(status)
    expect(response.headers.get("X-Magpie-Sign-In")).toBe(status === 401 ? "expired" : "kept")
    expect((await response.json()).error.message).toContain("poll rejected")
  })
})

test("repos-required 400 is surfaced verbatim", async () => {
  await withHarness(() => new Response("repos is required", { status: 400 }), async ({ fetch }) => {
    const response = await chat(fetch)
    expect(response.status).toBe(400)
    expect(response.headers.get("X-Magpie-Sign-In")).toBe("kept")
    expect((await response.json()).error.message).toBe("repos is required")
  })
})

test("the escalated conflict surfaces verbatim without another generation", async () => {
  let creates = 0
  const server = startFakeCloud({ scenario: ({ request, url }) => {
    if (request.method === "POST") { creates++; return new Response("agent_id_conflict", { status: 409 }) }
    return Response.json({ id: url.pathname.split("/").at(-1), status: "ARCHIVED", latestRunId: "old" })
  } })
  try {
    const driver = _internal.makeDriver({ apiBase: { "cursor-cloud": server.url + "/cursor" } })
    await expect(driver.create(AUTH, { model: "composer-2", prompt: "hello", identity: { sessionKey: "bounded" } })).rejects.toMatchObject({ status: 409, message: "agent_id_conflict" })
    expect(creates).toBe(2)
  } finally { server.stop() }
})

test("SSE unrecognized payload falls back to run polling after two reconnects", async () => {
  await withHarness(({ url }) => {
    if (url.pathname.endsWith("/stream")) return sse([["status", "resume", { undocumented: "value" }]])
  }, async ({ fetch, server }) => {
    expect((await (await chat(fetch)).json()).choices[0].message.content).toBe("Synthetic Cursor answer")
    expect(server.requests.filter(call => call.path.endsWith("/stream"))).toHaveLength(3)
  })
})

test("model endpoint failure and malformed JSON use static models", async () => {
  for (const response of [new Response("unavailable", { status: 503 }), new Response("{")]) {
    await withHarness(() => response, async ({ plugin }) => {
      const config = {}; await plugin.config(config)
      expect(await plugin.provider.models(config.provider["cursor-cloud"], { auth: AUTH })).toBe(config.provider["cursor-cloud"].models)
    })
  }
})

test("create retries once only when the supplied identity makes the POST idempotent", async () => {
  const nativeFetch = globalThis.fetch
  for (const sessionKey of ["retry", null]) {
    const server = startFakeCloud()
    let creates = 0
    const ids = []
    globalThis.fetch = async (input, init) => {
      if (init?.method === "POST") {
        creates++
        ids.push(JSON.parse(init.body).agentId)
        if (creates === 1) throw new Error("synthetic connection reset")
      }
      return nativeFetch(input, init)
    }
    try {
      const driver = _internal.makeDriver({ apiBase: { "cursor-cloud": server.url + "/cursor" } })
      const pending = driver.create(AUTH, { model: "composer-2", prompt: "hello", identity: { sessionKey, textsHash: "stable" } })
      if (sessionKey) { expect((await pending).ref).toBe(ids[0]); expect(ids[1]).toBe(ids[0]); expect(creates).toBe(2) }
      else { await expect(pending).rejects.toThrow("can't reach"); expect(creates).toBe(1) }
    } finally { globalThis.fetch = nativeFetch; server.stop() }
  }
})

test("poll transport failures use three attempts before returning 502 kept", async () => {
  const server = startFakeCloud()
  const driver = _internal.makeDriver({ apiBase: { "cursor-cloud": server.url + "/cursor" } })
  const run = await driver.create(AUTH, { model: "composer-2", prompt: "hello" })
  server.stop()
  const timers = { now: () => 0, random: () => 0.5, setTimeout: (fn, delay) => setTimeout(fn, delay >= 15000 ? delay : 0), clearTimeout }
  const nativeFetch = globalThis.fetch
  let attempts = 0
  globalThis.fetch = (...args) => { attempts++; return nativeFetch(...args) }
  try {
    const { pollWithBackoff } = await import("../lib/http.mjs")
    const { errorResponse } = await import("../lib/errors.mjs")
    let failure
    try { await pollWithBackoff(() => driver.poll(AUTH, run), { timers }) } catch (error) { failure = error }
    const response = errorResponse(failure, driver)
    expect(attempts).toBe(3)
    expect(response.status).toBe(502)
    expect(response.headers.get("X-Magpie-Sign-In")).toBe("kept")
    expect((await response.json()).error.message).toContain("can't reach 127.0.0.1")
  } finally { globalThis.fetch = nativeFetch }
})

function restartFixture({ firstStatus = "FINISHED", recon = false, active = false, listing = rows => ({ items: rows }), recordPrompt = true, progress = true } = {}) {
  const agents = new Map(), runs = new Map(), calls = []
  const server = startFakeCloud({ scenario: ({ request, url, body }) => {
    calls.push({ method: request.method, path: url.pathname, body })
    const mint = (agent, prompt) => {
      const run = { id: "owned-" + (runs.size + 1), agentId: agent.id, createdAt: new Date(runs.size * 1000).toISOString(), status: runs.size ? "FINISHED" : firstStatus, result: prompt.includes("Second question") ? "answer-2" : "answer-1" }
      if (run.status !== "FINISHED") run.result = ""
      if (recordPrompt) run.prompt = { text: prompt }
      run.url = server.url + "/cursor/agents/" + agent.id + "/runs/" + run.id
      runs.set(run.id, run); agent.latestRunId = run.id; return run
    }
    if (url.pathname.endsWith("/v1/agents") && request.method === "POST") {
      if (agents.has(body.agentId)) return new Response("agent_id_conflict", { status: 409 })
      const agent = { id: body.agentId, status: active ? "ACTIVE" : "IDLE" }
      agents.set(agent.id, agent)
      return Response.json({ agent, run: mint(agent, body.prompt.text) })
    }
    const id = url.pathname.split("/")[4], agent = agents.get(id)
    if (!agent) return undefined
    if (url.pathname.endsWith("/stream")) return new Response("offline", { status: 503 })
    if (url.pathname.endsWith("/runs")) {
      if (request.method === "POST") return Response.json({ run: mint(agent, body.prompt.text) })
      return Response.json(listing([...runs.values()].filter(run => run.agentId === id).reverse()))
    }
    if (url.pathname.includes("/runs/")) {
      const run = runs.get(url.pathname.split("/").at(-1))
      return run ? Response.json(run) : new Response("run not found", { status: 404 })
    }
    return Response.json(recon ? { id, status: agent.status, name: "agent" } : agent)
  } })
  return { server, agents, runs, calls, loader: () => makeCursorCloud({ apiBase: { "cursor-cloud": server.url + "/cursor" }, progress }).auth.loader(() => AUTH) }
}

test.each([
  ["markerless creation dropped", rows => ({ items: rows.filter(row => row.id !== "owned-1") })],
  ["cursor partial page", rows => ({ items: rows.slice(0, 1), cursor: "page-2" })],
  ["single newest row", rows => [rows[0]]],
])("ownership recovery never answers another question: %s", async (_name, listing) => {
  const fixture = restartFixture({ listing })
  try {
    const loader = await fixture.loader()
    const original = [{ role: "user", content: "First question" }]
    await chat(loader.fetch, { messages: original }, withSession)
    let history = [...original, { role: "assistant", content: "answer-1" }]
    for (let index = 0; index < 3; index++) {
      history.push({ role: "user", content: "Second question " + index })
      await chat(loader.fetch, { messages: history }, withSession)
      history.push({ role: "assistant", content: "answer-2" })
    }
    const response = await chat((await fixture.loader()).fetch, { messages: original }, withSession)
    expect(response.status).toBe(200)
    const content = (await response.json()).choices[0].message.content
    expect(content).toContain("answer-1")
    expect(content).not.toContain("answer-2")
    expect(fixture.runs.size).toBe(5)
    expect(fixture.runs.get("owned-5").prompt.text).toBe("Current request:\nFirst question")
  } finally { fixture.server.stop() }
})

test("ownership recovery discloses billable run and URL in user-visible progress", async () => {
  const fixture = restartFixture({ listing: () => ({ items: [] }) })
  try {
    await chat((await fixture.loader()).fetch, {}, withSession)
    const response = await chat((await fixture.loader()).fetch, { stream: true }, withSession)
    const { events } = await streamed(response)
    const progress = events.flatMap(event => event.choices?.[0]?.delta?.reasoning_content ?? []).join("\n")
    expect(progress).toContain("previous run cannot be recovered")
    expect(progress).toContain("new billable run")
    expect(progress).toContain(fixture.runs.get("owned-2").url)
  } finally { fixture.server.stop() }
})

test.each([
  ["missing creation", rows => ({ items: rows.slice(0, 1) }), true],
  ["tied timestamps", rows => ({ items: rows.map(row => ({ ...row, createdAt: "2026-01-01T00:00:00Z" })) }), false],
  ["foreign earliest", rows => ({ items: [{ id: "foreign", createdAt: "2000-01-01T00:00:00Z" }, ...rows] }), false],
  ["markerless complete", rows => ({ items: rows }), false],
  ["unknown cursor", rows => ({ items: rows.slice(0, 1), cursor: "more" }), true],
  ["invalid timestamp", rows => ({ items: rows.map(row => ({ ...row, createdAt: "invalid" })) }), false],
  ["empty", () => ({ items: [] }), true],
  ["unknown envelope", rows => ({ data: rows }), true],
  ["hasMore with owned run", rows => ({ items: rows, hasMore: true }), false],
  ["null cursor", rows => ({ items: rows, nextCursor: null }), false],
  ["truncated markerless", rows => ({ runs: rows.slice(0, 1) }), true],
  ["single owned row", rows => [rows.at(-1)], false],
])("ownership constructed listing %s", async (_name, listing, recovery) => {
  const fixture = restartFixture({ listing })
  const input = { model: "composer-2", prompt: "First question", identity: { sessionKey: "listing", textsHash: "same" } }
  const driver = () => _internal.makeDriver({ apiBase: { "cursor-cloud": fixture.server.url + "/cursor" } })
  try {
    const first = driver()
    const created = await first.create(AUTH, input)
    await first.followUp(AUTH, created, ["Second question"])
    const attached = await driver().create(AUTH, input)
    expect(attached.runId).toBe(recovery ? "owned-3" : created.runId)
    expect(fixture.runs.size).toBe(recovery ? 3 : 2)
  } finally { fixture.server.stop() }
})

test.each([
  ["no prompt", rows => ({ items: rows })],
  ["single no prompt", rows => [rows[0]]],
  ["explicit end marker without prompt", rows => ({ items: rows, hasMore: false, nextCursor: null })],
  ["tied unknown prompts", rows => ({ items: rows.map(row => ({ ...row, createdAt: "same" })) })],
])("ownership cannot be inferred from %s", async (_name, listing) => {
  const fixture = restartFixture({ listing, recordPrompt: false })
  const input = { model: "composer-2", prompt: "First question", identity: { sessionKey: "unknown", textsHash: "same" } }
  const driver = () => _internal.makeDriver({ apiBase: { "cursor-cloud": fixture.server.url + "/cursor" } })
  try {
    const first = await driver().create(AUTH, input)
    const recovered = await driver().create(AUTH, input)
    expect(recovered.runId).not.toBe(first.runId)
    expect(fixture.runs.size).toBe(2)
  } finally { fixture.server.stop() }
})

test("ownership matching list prompt cannot override a different run GET prompt", async () => {
  const fixture = restartFixture({ listing: rows => ({ items: rows.slice(0, 1).map(row => ({ ...row, prompt: { text: "First question" } })) }) })
  const input = { model: "composer-2", prompt: "First question", identity: { sessionKey: "conflicting", textsHash: "same" } }
  const driver = () => _internal.makeDriver({ apiBase: { "cursor-cloud": fixture.server.url + "/cursor" } })
  try {
    const first = driver(), created = await first.create(AUTH, input)
    await first.followUp(AUTH, created, ["Second question"])
    expect((await driver().create(AUTH, input)).runId).toBe("owned-3")
  } finally { fixture.server.stop() }
})

test.each([true, false])("ownership recovery final answer discloses spend with progress=%s", async progress => {
  const fixture = restartFixture({ listing: () => ({ items: [] }), progress })
  try {
    await chat((await fixture.loader()).fetch, {}, withSession)
    const content = (await (await chat((await fixture.loader()).fetch, {}, withSession)).json()).choices[0].message.content
    expect(content).toContain("previous run cannot be recovered")
    expect(content).toContain("new billable run was started for this message")
    expect(content).toContain(fixture.runs.get("owned-2").url)
    expect(content).toContain("answer-1")
  } finally { fixture.server.stop() }
})

test("ownership memory keeps in-flight duplicates attached without listing evidence", async () => {
  const fixture = restartFixture({ firstStatus: "RUNNING", active: true, recordPrompt: false, listing: () => ({ items: [] }) })
  const driver = _internal.makeDriver({ apiBase: { "cursor-cloud": fixture.server.url + "/cursor" } })
  const input = { model: "composer-2", prompt: "First question", identity: { sessionKey: "memory", textsHash: "same" } }
  try {
    const first = await driver.create(AUTH, input)
    expect((await driver.create(AUTH, input)).runId).toBe(first.runId)
    expect(fixture.runs.size).toBe(1)
    expect(fixture.calls.some(call => call.method === "GET" && call.path.endsWith("/runs"))).toBe(false)
  } finally { fixture.server.stop() }
})

test("ownership unknown ACTIVE run refuses before billable recovery", async () => {
  const fixture = restartFixture({ active: true, recordPrompt: false })
  const driver = () => _internal.makeDriver({ apiBase: { "cursor-cloud": fixture.server.url + "/cursor" } })
  const input = { model: "composer-2", prompt: "First question", identity: { sessionKey: "active", textsHash: "same" } }
  try {
    const first = await driver().create(AUTH, input)
    await expect(driver().create(AUTH, input)).rejects.toMatchObject({ status: 409, message: expect.stringContaining(first.ref) })
    expect(fixture.runs.size).toBe(1)
  } finally { fixture.server.stop() }
})

test("ownership recovered prompt reattaches after another restart without extra spend", async () => {
  const fixture = restartFixture({ firstStatus: "ERROR" })
  const driver = () => _internal.makeDriver({ apiBase: { "cursor-cloud": fixture.server.url + "/cursor" } })
  const input = { model: "composer-2", prompt: "First question", identity: { sessionKey: "recovered", textsHash: "same" } }
  try {
    await driver().create(AUTH, input)
    const recovered = await driver().create(AUTH, input)
    expect((await driver().create(AUTH, input)).runId).toBe(recovered.runId)
    expect(fixture.runs.size).toBe(2)
  } finally { fixture.server.stop() }
})

test("ownership recovery poll alone carries disclosure without stream", async () => {
  const fixture = restartFixture({ listing: () => ({ items: [] }) })
  const input = { model: "composer-2", prompt: "First question", identity: { sessionKey: "poll-only", textsHash: "same" } }
  const driver = () => _internal.makeDriver({ apiBase: { "cursor-cloud": fixture.server.url + "/cursor" } })
  try {
    await driver().create(AUTH, input)
    const restarted = driver(), run = await restarted.create(AUTH, input)
    expect((await restarted.poll(AUTH, run)).text).toContain("new billable run")
  } finally { fixture.server.stop() }
})

test("F1 older transcript after restart never receives the newer run answer", async () => {
  const fixture = restartFixture()
  try {
    const first = await fixture.loader()
    const original = [{ role: "user", content: "First question" }]
    expect((await (await chat(first.fetch, { messages: original }, withSession)).json()).choices[0].message.content).toBe("answer-1")
    const next = [...original, { role: "assistant", content: "answer-1" }, { role: "user", content: "Second question" }]
    expect((await (await chat(first.fetch, { messages: next }, withSession)).json()).choices[0].message.content).toBe("answer-2")
    const restarted = await fixture.loader()
    expect((await (await chat(restarted.fetch, { messages: original }, withSession)).json()).choices[0].message.content).toBe("answer-1")
    expect(fixture.runs.size).toBe(2)
  } finally { fixture.server.stop() }
})
test.each(["ERROR", "CANCELLED", "EXPIRED"])("F1 %s can recover on identical re-ask after restart", async firstStatus => {
  const fixture = restartFixture({ firstStatus })
  try {
    expect((await chat((await fixture.loader()).fetch, {}, withSession)).status).toBe(502)
    const response = await chat((await fixture.loader()).fetch, {}, withSession)
    expect(response.status).toBe(200)
    expect((await response.json()).choices[0].message.content).toEndWith("\n\nanswer-1")
    expect(fixture.agents.size).toBe(1)
    expect(fixture.runs.size).toBe(2)
  } finally { fixture.server.stop() }
})
test("F2 recon agent GET and in-flight duplicate attach without another run", async () => {
  const fixture = restartFixture({ recon: true, firstStatus: "RUNNING", active: true })
  const input = { model: "composer-2", prompt: "First question", identity: { sessionKey: "inflight", textsHash: "same" } }
  try {
    const make = () => _internal.makeDriver({ apiBase: { "cursor-cloud": fixture.server.url + "/cursor" } })
    const first = await make().create(AUTH, input)
    const retry = await make().create(AUTH, input)
    expect(retry.runId).toBe(first.runId)
    expect(fixture.agents.size).toBe(1)
    expect(fixture.runs.size).toBe(1)
  } finally { fixture.server.stop() }
})
test.each([[[]], [[{ role: "system", content: "Private instructions" }]]])("F3 name uses current user request with system=%j", async prefix => {
  await withHarness(undefined, async ({ fetch, server }) => {
    await chat(fetch, { messages: [...prefix, { role: "user", content: "Specific request" }] })
    expect(server.requests[0].body.name).toBe("magpie: Specific request")
  })
})
test("F5 live floor model retains declared reasoning and tool_call flags", async () => {
  await withHarness(undefined, async ({ plugin }) => {
    const config = {}; await plugin.config(config)
    const models = await plugin.provider.models(config.provider["cursor-cloud"], { auth: AUTH })
    expect(models["composer-2"].reasoning).toBe(false)
    expect(models["composer-2"].tool_call).toBe(false)
  })
})

test.each(["IDLE", "ACTIVE"])("F2 unavailable run list safely degrades for %s agent", async status => {
  let posts = 0
  await withHarness(({ request, url, body }) => {
    if (url.pathname.endsWith("/v1/agents")) return new Response("agent_id_conflict", { status: 409 })
    if (url.pathname.endsWith("/runs")) {
      if (request.method === "GET") return Response.json({ unexpected: true })
      posts++
      expect(body.prompt.text).toBe("Current request:\nFix the failing test")
      return Response.json({ run: { id: "fresh-run" } })
    }
    if (url.pathname.endsWith("/stream")) return new Response("offline", { status: 503 })
    if (url.pathname.includes("/runs/")) return Response.json({ status: "FINISHED", result: "new answer for requested prompt" })
    return Response.json({ id: url.pathname.split("/").at(-1), status })
  }, async ({ fetch }) => {
    const response = await chat(fetch, {}, withSession)
    expect(response.status).toBe(status === "IDLE" ? 200 : 409)
    expect(posts).toBe(status === "IDLE" ? 1 : 0)
    if (status === "IDLE") expect((await response.json()).choices[0].message.content).toEndWith("\n\nnew answer for requested prompt")
  })
})
test("F4 two archived generations remain bounded at four create POSTs", async () => {
  const fixture = restartFixture()
  const driver = _internal.makeDriver({ apiBase: { "cursor-cloud": fixture.server.url + "/cursor" } })
  const input = { model: "composer-2", prompt: "hello", identity: { sessionKey: "bound", textsHash: "same" } }
  try {
    const first = await driver.create(AUTH, input)
    fixture.agents.get(first.ref).status = "ARCHIVED"
    const second = await driver.create(AUTH, input)
    fixture.agents.get(second.ref).status = "ARCHIVED"
    await expect(driver.create(AUTH, input)).rejects.toMatchObject({ status: 409, message: "agent_id_conflict" })
    expect(fixture.agents.size).toBe(2)
    expect(fixture.calls.filter(call => call.method === "POST" && call.path.endsWith("/v1/agents"))).toHaveLength(4)
  } finally { fixture.server.stop() }
})
