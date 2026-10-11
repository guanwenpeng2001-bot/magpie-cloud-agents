import { expect, test } from "bun:test"
import { makeGrokBotDriver } from "./grok-bot.mjs"
import { createGrokBotCdp, findGrokBot, connectCdp } from "./grok-bot-cdp.mjs"
import { errorResponse } from "../lib/errors.mjs"
import { SESSION_HEADER } from "../lib/sessions.mjs"

const marker = { type: "oauth", access: "app-local", mechanism: "cdp" }
const messages = {
  missing: "Grok Bot desktop isn't installed — install it from xAI and sign in once, then retry",
  signedOut: "Grok Bot desktop isn't signed in — open it and sign in once; Magpie will drive it after that",
  running: "Grok Bot is already running and Magpie can't attach to it — close Grok Bot (or pick the direct-protocol sign-in) and retry",
  changed: "Grok Bot changed its UI; the provider needs an update",
  crashed: "Grok Bot closed mid-answer — your prompt may still be answered in the app; ask again to re-attach",
  debug: "Grok Bot didn't open its debug interface — another security tool may be blocking it",
}
async function expectFailure(operation, key, status = 502, signIn = "kept") {
  let error
  try { await operation() } catch (caught) { error = caught }
  expect(error?.message).toBe(messages[key])
  const response = errorResponse(error)
  expect(response.status).toBe(status)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe(signIn)
}
function fixture(settings = {}) {
  const frames = [], spawns = [], timers = new Map()
  let timestamp = 0, nextTimer = 0, kills = 0, clients = []
  const state = { signedIn: true, tail: [], bridgeMissing: false, composer: true, transcriptFallback: false, autoAnswer: false, ...settings }
  const timerApi = {
    now: () => timestamp,
    setTimeout(callback, delay) {
      const timer = { id: ++nextTimer, unref() {} }
      if (delay === 200) { timestamp += delay; queueMicrotask(callback) }
      else timers.set(timer, { callback, delay })
      return timer
    },
    clearTimeout(timer) { timers.delete(timer) }, random: () => 0.5,
  }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response(null, { status: 404 }) },
    websocket: {
      open(socket) { clients.push(socket) },
      message(socket, data) {
        const frame = JSON.parse(String(data)); frames.push(frame)
        const expression = frame.params?.expression ?? ""
        let value
        let error
        if (expression.includes("cursorAccount")) value = state.signedIn
        else if (expression.includes("Promise.allSettled")) value = [["bot-id"], { agents: [{ agentId: "bot-id", name: "My bot" }, { id: "second", name: "Other bot" }] }]
        else if (expression.includes("readTranscriptStoreTail")) {
          if (state.transcriptFallback) error = "edge/invalid-args"
          else value = { entries: state.tail }
        } else if (expression.includes("const region")) value = { entries: state.tail }
        else if (expression.includes("desktopMount.mount(")) { if (state.bridgeMissing) error = "mount is not a function" }
        else if (expression.includes("desktopMount.submitPrompt(")) {
          const prompt = JSON.parse(expression.slice(expression.indexOf("(") + 1, -1)).prompt
          state.tail.push({ id: `user-${state.tail.length}`, role: "user", text: prompt })
          if (state.autoAnswer) state.tail.push({ id: `assistant-${state.tail.length}`, role: "assistant", text: "answer" })
        } else if (expression.includes("const composer")) value = state.composer
        else if (expression.includes("const mounted")) value = "bot-id"
        socket.send(JSON.stringify(error ? { id: frame.id, result: { exceptionDetails: { exception: { description: error } } } } : { id: frame.id, result: frame.method === "Runtime.evaluate" ? { result: { value } } : {} }))
      },
    },
  })
  const dependencies = {
    env: { ProgramFiles: "C:\\Programs", LOCALAPPDATA: "C:\\Local", PATH: "C:\\Tools" }, exists: async () => !state.missing,
    processes: async () => state.previous ? [{ pid: 42, port: state.reattach ? server.port : undefined }] : [],
    freePort: async () => server.port,
    spawn(exe, argv, options) { const child = { exitCode: state.exited ? 0 : null, kill() { kills++ }, once() {} }; spawns.push({ exe, argv, options }); return child },
    fetch: async url => {
      if (state.unreachable) throw new Error("unreachable")
      return Response.json(String(url).endsWith("/json/version") ? { Browser: "Chrome/148.0", "User-Agent": "GrokBot/0.68.1 Electron/42" } : [{ type: "page", url: "file:///C:/Grok%20Bot/resources/app.asar/dist/renderer/index.html", webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/page/fake` }])
    }, timers: timerApi,
  }
  const driver = createGrokBotCdp({ keepAliveMinutes: 0.01, launchTimeoutMs: 400 }, dependencies)
  return { state, frames, spawns, dependencies, driver, endpoint: `ws://127.0.0.1:${server.port}/devtools/page/fake`,
    get kills() { return kills },
    expireIdle() { for (const [timer, job] of [...timers]) if (job.delay === 600) { timers.delete(timer); job.callback() } },
    disconnect() { for (const client of clients) client.close(); clients = [] },
    close() { driver.dispose(); server.stop(true) },
  }
}
const send = fixture => fixture.driver.create(marker, { model: "bot-id", prompt: "hello" })

test("discovery uses ProgramFiles, LOCALAPPDATA, then PATH in order", async () => {
  const visited = []
  const found = await findGrokBot({ env: { ProgramFiles: "C:\\Global", LOCALAPPDATA: "C:\\Local", PATH: "C:\\Tools;C:\\More" }, exists: async path => { visited.push(path); return path === "C:\\Tools\\Grok Bot.exe" } })
  expect(visited).toEqual(["C:\\Global\\Grok Bot\\Grok Bot.exe", "C:\\Local\\Programs\\Grok Bot\\Grok Bot.exe", "C:\\Tools\\Grok Bot.exe"])
  expect(found).toBe(visited[2])
})

test("missing installation reports exact 502 kept", async () => { await expectFailure(() => findGrokBot({ env: {}, exists: async () => false }), "missing") })

test("launch binds debug argv to loopback and mounts before submit with server-tail read", async () => {
  const fake = fixture()
  try {
    await send(fake)
    expect(fake.spawns[0].argv).toEqual([`--remote-debugging-port=${new URL(fake.endpoint).port}`, "--remote-debugging-address=127.0.0.1"])
    const expressions = fake.frames.map(frame => frame.params.expression).filter(Boolean)
    expect(expressions.findIndex(text => text.includes("desktopMount.mount("))).toBeLessThan(expressions.findIndex(text => text.includes("desktopMount.submitPrompt(")))
    expect(expressions.some(text => text.includes('"reason":"server-tail"'))).toBe(true)
    expect(expressions.some(text => text.includes('"agentId":"bot-id"'))).toBe(true)
  } finally { fake.close() }
})

test("reattach to GrokBot User-Agent uses existing app and never kills it", async () => {
  const fake = fixture({ previous: true, reattach: true })
  try { expect(await fake.driver.liveModels(marker)).toEqual({ "bot-id": { name: "My bot", tool_call: false }, second: { name: "Other bot", tool_call: false } }); fake.expireIdle(); expect(fake.spawns).toHaveLength(0); expect(fake.kills).toBe(0) }
  finally { fake.close() }
  expect(fake.kills).toBe(0)
})

test("already-running handoff without debug endpoint reports exact 409 kept", async () => {
  const fake = fixture({ previous: true, exited: true, unreachable: true })
  try { await expectFailure(() => send(fake), "running", 409); fake.expireIdle(); expect(fake.kills).toBe(0) } finally { fake.close() }
})

test("debug startup failure reports exact 502 kept", async () => {
  const fake = fixture({ unreachable: true })
  try { await expectFailure(() => send(fake), "debug") } finally { fake.close() }
})

test("signed-out probe reports exact 401 expired", async () => {
  const fake = fixture({ signedIn: false })
  try { await expectFailure(() => send(fake), "signedOut", 401, "expired") } finally { fake.close() }
})

test("UI fallback switches bot, inserts prompt and sends Enter with exact progress", async () => {
  const fake = fixture({ bridgeMissing: true })
  try {
    const run = await send(fake)
    expect(run.progress).toBe("Grok Bot updated and its automation bridge changed — falling back to UI input; if this repeats, the provider needs an update")
    expect(fake.frames.find(frame => frame.method === "Input.insertText").params.text).toBe("hello")
    expect(fake.frames.filter(frame => frame.method === "Input.dispatchKeyEvent").map(frame => frame.params.type)).toEqual(["keyDown", "keyUp"])
    expect(fake.frames.some(frame => frame.params.expression?.includes("desktopMount.switchTo("))).toBe(true)
  } finally { fake.close() }
})

test("missing automation and composer reports exact UI-changed 502 kept", async () => {
  const fake = fixture({ bridgeMissing: true, composer: false })
  try { await expectFailure(() => send(fake), "changed") } finally { fake.close() }
})

test("unchanged old replies and unstable equal-length tails cannot finish a turn", async () => {
  const fake = fixture({ tail: [{ id: "old", role: "assistant", text: "old answer" }] })
  try {
    const run = await send(fake)
    expect((await fake.driver.poll(marker, run)).state).toBe("running")
    expect((await fake.driver.poll(marker, run)).state).toBe("running")
    fake.state.tail.push({ id: "new", role: "assistant", text: "draft" })
    expect((await fake.driver.poll(marker, run)).state).toBe("running")
    fake.state.tail.at(-1).text = "final"
    expect((await fake.driver.poll(marker, run)).state).toBe("running")
    expect(await fake.driver.poll(marker, run)).toEqual({ state: "succeeded", text: "final" })
  } finally { fake.close() }
})

test("invalid-args transcript bridge uses DOM tail with the same stability rule", async () => {
  const fake = fixture({ transcriptFallback: true, autoAnswer: true })
  try { const run = await send(fake); expect((await fake.driver.poll(marker, run)).state).toBe("running"); expect((await fake.driver.poll(marker, run)).text).toBe("answer") } finally { fake.close() }
})

test("idle teardown stops only owned app and never while a turn is active", async () => {
  const fake = fixture({ autoAnswer: true })
  try { const run = await send(fake); fake.expireIdle(); expect(fake.kills).toBe(0); await fake.driver.poll(marker, run); await fake.driver.poll(marker, run); fake.expireIdle(); expect(fake.kills).toBe(1) } finally { fake.close() }
})

test("crash recovers once without resending prompt, then reports exact 502 kept", async () => {
  const fake = fixture()
  try {
    const run = await send(fake)
    fake.disconnect(); await Bun.sleep(5)
    expect((await fake.driver.poll(marker, run)).state).toBe("running")
    expect(fake.frames.filter(frame => frame.params.expression?.includes("desktopMount.submitPrompt(")).length).toBe(1)
    fake.disconnect(); await Bun.sleep(5)
    await expectFailure(() => fake.driver.poll(marker, run), "crashed")
  } finally { fake.close() }
})

test("factory preserves floor and enumerates named bot models", async () => {
  const fake = fixture()
  const plugin = makeGrokBotDriver({}, {}, { cdp: fake.dependencies })
  try { const models = await plugin.provider.models({ models: {} }, { auth: marker }); expect(models["app-bot"]).toBeDefined(); expect(models["bot-id"].name).toBe("My bot"); fake.expireIdle() } finally { fake.close() }
})

test("factory direct import is lazy and broken/missing driver gives setup error without breaking CDP", async () => {
  for (const load of [async () => { throw new Error("missing module") }, async () => ({}), async () => ({ makeGrokBotDirect: () => ({}) })]) {
    let imports = 0
    const plugin = makeGrokBotDriver({}, { grokBot: { dependencies: { exists: async () => true } } }, { importDirect: async () => { imports++; return load() } })
    expect(imports).toBe(0)
    expect(plugin.auth.methods[0].label).toContain("default")
    expect((await (await plugin.auth.methods[0].authorize()).callback()).type).toBe("success")
    expect(imports).toBe(0)
    expect((await (await plugin.auth.methods[1].authorize()).callback()).type).toBe("failed")
    const loader = await plugin.auth.loader(async () => ({ ...marker, mechanism: "direct" }))
    const response = await loader.fetch("http://local/chat/completions")
    expect(response.status).toBe(502)
    expect(response.headers.get("X-Magpie-Sign-In")).toBe("kept")
  }
})

test("multi-turn loader sends only splitSuffix texts to the bot transcript", async () => {
  const fake = fixture({ autoAnswer: true })
  const quickTimers = { now: Date.now, random: () => 0.5, setTimeout: (callback, delay) => setTimeout(callback, delay >= 1600 && delay <= 10000 ? 0 : delay), clearTimeout }
  const plugin = makeGrokBotDriver({}, { progress: false }, { cdp: fake.dependencies, timers: quickTimers })
  try {
    const loader = await plugin.auth.loader(async () => marker)
    const request = history => loader.fetch(loader.baseURL + "/chat/completions", { method: "POST", headers: { [SESSION_HEADER]: "test-session" }, body: JSON.stringify({ model: "bot-id", messages: history, stream: false }) })
    const history = [{ role: "user", content: "first" }]
    expect((await request(history)).status).toBe(200)
    expect((await request([...history, { role: "assistant", content: "answer" }, { role: "user", content: "second" }])).status).toBe(200)
    const prompts = fake.frames.filter(frame => frame.params.expression?.includes("desktopMount.submitPrompt(")).map(frame => JSON.parse(frame.params.expression.slice(frame.params.expression.indexOf("(") + 1, -1)).prompt)
    expect(prompts).toEqual(["Current request:\nfirst", "second"])
    fake.expireIdle()
  } finally { fake.close() }
})

test("cancel releases idle ownership without interrupting the bot", async () => {
  const fake = fixture()
  try { const run = await send(fake); await fake.driver.cancel(marker, run); fake.expireIdle(); expect(fake.kills).toBe(1); expect(fake.frames.some(frame => /interrupt/i.test(frame.params.expression ?? ""))).toBe(false) } finally { fake.close() }
})

test("concurrent sends to one bot cannot both submit", async () => {
  const fake = fixture()
  try { const results = await Promise.allSettled([send(fake), send(fake)]); expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1); expect(fake.frames.filter(frame => frame.params.expression?.includes("desktopMount.submitPrompt("))).toHaveLength(1) } finally { fake.close() }
})

test("CDP client rejects remote websocket endpoints", async () => { await expect(connectCdp("ws://example.invalid:9333/devtools/page/1")).rejects.toThrow(messages.debug) })

test("CDP sign-in verifies installation and saves only a local marker without launching", async () => {
  const plugin = makeGrokBotDriver({}, { grokBot: { dependencies: { exists: async () => true, spawn: () => { throw new Error("must not launch") } } } })
  const flow = await plugin.auth.methods[0].authorize()
  expect(await flow.callback()).toEqual({ type: "success", refresh: "grok-bot-cdp", access: "app-local", expires: 0, accountId: "grok-bot-cdp", mechanism: "cdp" })
})
