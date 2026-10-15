import { expect, test } from "bun:test"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { readFile } from "node:fs/promises"
import { makeGrokBotDriver } from "./grok-bot.mjs"
import { createGrokBotCdp, findGrokBot, connectCdp } from "./grok-bot-cdp.mjs"
import { errorResponse } from "../lib/errors.mjs"
import { SESSION_HEADER } from "../lib/sessions.mjs"

test.skipIf(process.platform !== "win32")("real PowerShell teardown preserves exact process identity through JSON", async () => {
  const execute = promisify(execFile)
  const source = await readFile(new URL("./grok-bot-cdp.mjs", import.meta.url), "utf8")
  const enumeration = JSON.parse(source.match(/await execute\("powershell.exe", \["-NoProfile", "-NonInteractive", "-Command", ("(?:\\.|[^"\\])*")/)[1])
  const stopScript = source.match(/const script = `([^`]+)`/)[1].replace(/\\\\/g, "\\")
  const tag = "999999:12345678-1234-4234-8234-123456789abc"
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", `--magpie-grok-managed=${tag}`], { stdio: "ignore" })
  const exited = new Promise(resolve => child.once("exit", resolve))
  async function stop(row) {
    await new Promise((resolve, reject) => {
      const command = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", stopScript], { timeout: 10000 }, error => error ? reject(error) : resolve())
      command.stdin.end(JSON.stringify(row))
    })
  }
  try {
    const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", enumeration.replace("Name='Grok Bot.exe'", `ProcessId=${child.pid}`)])
    const parsed = JSON.parse(stdout)
    const observed = Array.isArray(parsed) ? parsed[0] : parsed
    const row = { pid: child.pid, executable: observed.ExecutablePath, created: observed.CreationDate, managedTag: tag }
    for (const mismatch of [{ executable: "C:\\not-the-process.exe" }, { created: (BigInt(row.created) + 1n).toString() }, { managedTag: tag.slice(0, -1) }, { managedTag: "" }]) {
      await stop({ ...row, ...mismatch })
      expect(child.exitCode).toBeNull()
      expect(() => process.kill(child.pid, 0)).not.toThrow()
    }
    await stop(row)
    const terminated = await Promise.race([exited.then(() => true), Bun.sleep(1000).then(() => false)])
    expect(terminated).toBe(true)
  } finally { if (child.exitCode == null) child.kill(); await exited }
}, 30000)

test("managed profile explains separate sign-in and recovers after the user signs in", async () => {
  const fake = fixture({ previous: true, signedIn: false })
  try {
    const flow = await fake.driver.authorize()
    expect(flow.instructions).toContain("separate profile")
    await expect(send(fake)).rejects.toThrow("Sign in in the Grok Bot window opened by Magpie")
    expect(fake.frames.some(frame => frame.params.expression?.includes("submitPrompt"))).toBe(false)
    fake.state.signedIn = true
    expect((await send(fake)).ref).toBe("bot-id")
    expect(fake.spawns).toHaveLength(1)
  } finally { fake.close() }
})

const marker = { type: "oauth", access: "app-local", mechanism: "cdp" }
const messages = {
  missing: "Grok Bot desktop isn't installed — install it from xAI and sign in once, then retry",
  signedOut: "Grok Bot isn't signed in in the connected window. Sign in in the Grok Bot window opened by Magpie (or the existing debug-enabled window), then retry. Magpie's separate profile does not inherit your usual app's sign-in; your usual app can stay open.",
  running: "Magpie couldn't start its own Grok Bot instance — the launch exited before its debug interface opened; retry the sign-in",
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
  const frames = [], spawns = [], stops = [], timers = new Map()
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
        if (expression.includes("cursorAccount")) { value = state.signedIn; error = state.probeError }
        else if (expression.includes("listGrokBotAgentStatuses")) value = state.statuses
        else if (expression.includes("Promise.allSettled")) value = [["bot-id"], { agents: [{ agentId: "bot-id", name: "My bot" }, { id: "second", name: "Other bot" }] }]
        else if (expression.includes("readTranscriptStoreTail")) {
          if (state.tailError) error = state.tailError
          else if (state.transcriptFallback) error = "edge/invalid-args"
          else value = { entries: state.tail }
        } else if (expression.includes("const region")) value = { entries: state.tail }
        else if (expression.includes("desktopMount.mount(")) { if (state.bridgeMissing) error = "mount is not a function" }
        else if (expression.includes("desktopMount.submitPrompt(")) {
          const prompt = JSON.parse(expression.slice(expression.indexOf("(") + 1, -1)).prompt
          if (state.onSubmit) state.onSubmit(state, prompt)
          else {
            state.tail.push({ id: `user-${state.tail.length}`, role: "user", text: prompt })
            if (state.autoAnswer) state.tail.push({ id: `assistant-${state.tail.length}`, role: "assistant", text: "answer" })
          }
        } else if (expression.includes("const composer")) value = state.composer
        else if (expression.includes("const mounted")) value = "bot-id"
        socket.send(JSON.stringify(error ? { id: frame.id, result: { exceptionDetails: { exception: { description: error } } } } : { id: frame.id, result: frame.method === "Runtime.evaluate" ? { result: { value } } : {} }))
        if (state.quitAfterSubmit && expression.includes("desktopMount.submitPrompt(")) { state.unreachable = true; queueMicrotask(() => socket.close()) }
      },
    },
  })
  const dependencies = {
    env: { ProgramFiles: "C:\\Programs", LOCALAPPDATA: "C:\\Local", PATH: "C:\\Tools" }, exists: async () => !state.missing,
    processes: async () => [
      ...(state.previous ? [{ pid: 42, port: state.reattach ? server.port : undefined }] : []),
      ...(state.exited ? [] : spawns.flatMap((spawned, index) => {
        const managedTag = spawned.argv?.find(arg => arg.startsWith("--magpie-grok-managed="))?.split("=")[1]
        return managedTag ? [{ pid: 100 + index, executable: spawned.exe, created: `t${index}`, managedTag }] : []
      })),
    ],
    freePort: async () => server.port,
    spawn(exe, argv, options) { const child = { exitCode: state.exited ? 0 : null, kill() { kills++ }, once() {} }; spawns.push({ exe, argv, options }); return child },
    stopManaged: async row => { stops.push(row) },
    fetch: async url => {
      if (state.unreachable) throw new Error("unreachable")
      return Response.json(String(url).endsWith("/json/version") ? { Browser: "Chrome/148.0", "User-Agent": "GrokBot/0.68.1 Electron/42" } : [{ type: "page", url: "file:///C:/Grok%20Bot/resources/app.asar/dist/renderer/index.html", webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/page/fake` }])
    }, timers: timerApi,
  }
  const driver = createGrokBotCdp({ keepAliveMinutes: 0.01, launchTimeoutMs: 400 }, dependencies)
  return { state, frames, spawns, dependencies, driver, endpoint: `ws://127.0.0.1:${server.port}/devtools/page/fake`,
    get kills() { return kills },
    get stops() { return stops },
    get connections() { return clients.length },
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
    expect(fake.spawns[0].argv.slice(0, 2)).toEqual([`--remote-debugging-port=${new URL(fake.endpoint).port}`, "--remote-debugging-address=127.0.0.1"])
    expect(fake.spawns[0].argv[2]).toMatch(/^--magpie-grok-managed=\d+:[0-9a-f-]{36}$/)
    expect(fake.spawns[0].argv[3]).toBe("--user-data-dir=C:\\Local\\Magpie\\grok-bot-managed-profile")
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

test("failed managed launch reports 409 without telling the user to close the app", async () => {
  const fake = fixture({ previous: true, exited: true, unreachable: true })
  try {
    await expectFailure(() => send(fake), "running", 409)
    expect(messages.running).not.toMatch(/close/i)
    fake.expireIdle(); await Bun.sleep(5)
    expect(fake.stops).toHaveLength(0)
    expect(fake.kills).toBe(0)
  } finally { fake.close() }
})

test("unmanaged running app drives through a managed instance instead of refusing", async () => {
  const fake = fixture({ previous: true, autoAnswer: true })
  try {
    const run = await send(fake)
    expect(fake.spawns).toHaveLength(1)
    expect((await fake.driver.poll(marker, run)).state).toBe("running")
    expect(await fake.driver.poll(marker, run)).toEqual({ state: "succeeded", text: "answer" })
    fake.expireIdle(); await Bun.sleep(5)
    expect(fake.stops).toHaveLength(1)
    expect(fake.stops[0].pid).not.toBe(42)
    expect(fake.stops[0].managedTag).toBe(fake.spawns[0].argv[2].split("=")[1])
  } finally { fake.close() }
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
    expect(fake.frames.find(frame => frame.method === "Input.insertText").params.text).toBe(run.prompt)
    expect(run.prompt).toMatch(/^hello\n\n\[Magpie turn: [0-9a-f]{24}\]$/)
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
  try {
    const run = await send(fake); fake.expireIdle(); await Bun.sleep(5); expect(fake.stops).toHaveLength(0)
    await fake.driver.poll(marker, run); await fake.driver.poll(marker, run)
    fake.expireIdle(); await Bun.sleep(5)
    expect(fake.stops).toHaveLength(1)
    expect(fake.stops[0].managedTag).toBe(fake.spawns[0].argv[2].split("=")[1])
    expect(fake.kills).toBe(0)
  } finally { fake.close() }
})

test("crash recovers once without resending prompt, then reports exact 502 kept", async () => {
  const fake = fixture()
  try {
    const run = await send(fake)
    fake.disconnect(); await Bun.sleep(5)
    expect((await fake.driver.poll(marker, run)).state).toBe("running")
    expect(fake.frames.filter(frame => frame.params.expression?.includes("desktopMount.submitPrompt(")).length).toBe(1)
    fake.disconnect(); fake.state.unreachable = true; await Bun.sleep(5)
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
    const plugin = makeGrokBotDriver({}, { grokBot: { dependencies: { processes: async () => [], exists: async () => true } } }, { importDirect: async () => { imports++; return load() } })
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
    expect(prompts.map(prompt => prompt.replace(/\n\n\[Magpie turn: [0-9a-f]{24}\]$/, ""))).toEqual(["Current request:\nfirst", "second"])
    expect(prompts.every(prompt => /\[Magpie turn: [0-9a-f]{24}\]$/.test(prompt))).toBe(true)
    fake.expireIdle()
  } finally { fake.close() }
})

test("cancel releases idle ownership without interrupting the bot", async () => {
  const fake = fixture()
  try { const run = await send(fake); await fake.driver.cancel(marker, run); fake.expireIdle(); await Bun.sleep(5); expect(fake.stops).toHaveLength(1); expect(fake.frames.some(frame => /interrupt/i.test(frame.params.expression ?? ""))).toBe(false) } finally { fake.close() }
})

test("concurrent sends to one bot cannot both submit", async () => {
  const fake = fixture()
  try { const results = await Promise.allSettled([send(fake), send(fake)]); expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1); expect(fake.frames.filter(frame => frame.params.expression?.includes("desktopMount.submitPrompt("))).toHaveLength(1) } finally { fake.close() }
})

test("review F1 headers remain scoped to Grok Bot", async () => {
  const plugin = makeGrokBotDriver({})
  for (const request of [{ model: { providerID: "grok-bot" } }, { provider: { info: { id: "grok-bot" } } }]) {
    const output = { headers: {} }; await plugin["chat.headers"]({ ...request, sessionID: "session" }, output); expect(output.headers[SESSION_HEADER]).toBe("session")
  }
  const output = { headers: {} }; await plugin["chat.headers"]({ model: { providerID: "foreign" }, sessionID: "session" }, output); expect(output.headers).toEqual({})
})
for (const [probe, dom] of [["A", true], ["U", false]]) test(`review ${probe} repeated idless prompt cannot return previous answer`, async () => {
  const fake = fixture({ transcriptFallback: dom, tail: [{ role: "user", text: "hello" }, { role: "assistant", text: "OLD ANSWER" }], onSubmit() {} })
  try { const run = await send(fake); await fake.driver.poll(marker, run); expect((await fake.driver.poll(marker, run)).state).toBe("running") } finally { fake.close() }
})
for (const [probe, dom] of [["D", true], ["V", false]]) test(`review ${probe} interjection cannot answer our turn`, async () => {
  const fake = fixture({ transcriptFallback: dom, onSubmit(state, prompt) { state.tail.push({ id: "ours", role: "user", text: prompt }, { id: "other", role: "user", text: "time?" }, { id: "answer", role: "assistant", text: "3pm" }) } })
  try { const run = await send(fake); await fake.driver.poll(marker, run); expect((await fake.driver.poll(marker, run)).state).toBe("running") } finally { fake.close() }
})
test("review F4 readable running status prevents paused answer completion", async () => {
  const fake = fixture({ autoAnswer: true, statuses: { statuses: [{ agentId: "bot-id", status: "running" }] } })
  try { const run = await send(fake); await fake.driver.poll(marker, run); expect((await fake.driver.poll(marker, run)).state).toBe("running"); fake.state.statuses.statuses[0].status = "idle"; expect((await fake.driver.poll(marker, run)).state).toBe("succeeded") } finally { fake.close() }
})
test("review AH recovery remains available after two disconnected polls", async () => {
  const fake = fixture()
  try { const run = await send(fake); for (let attempt = 0; attempt < 3; attempt++) { fake.disconnect(); await Bun.sleep(5); expect((await fake.driver.poll(marker, run)).state).toBe("running") } } finally { fake.close() }
})
for (const field of ["probeError", "tailError"]) test(`review F7 maps ${field} to exact changed row`, async () => {
  const fake = fixture({ [field]: "object is not a function" }); try { await expectFailure(() => send(fake), "changed") } finally { fake.close() }
})
test("review F6 dispose never kills exited child", async () => {
  const fake = fixture({ exited: true }); await send(fake); fake.close(); await Bun.sleep(5); expect(fake.kills).toBe(0); expect(fake.stops).toHaveLength(0)
})
test("review F9 missing verify and dispose rejects direct seam", async () => {
  const plugin = makeGrokBotDriver({}, {}, { importDirect: async () => ({ makeGrokBotDirect: () => ({ create() {}, authorize() { return { callback: async () => ({ type: "success" }) } } }) }) })
  expect((await (await plugin.auth.methods[1].authorize()).callback()).type).toBe("failed")
})

test("managed stop revalidates tag, executable and creation time and refuses a mismatch", async () => {
  const executable = "C:\\Programs\\Grok Bot\\Grok Bot.exe"
  for (const [mutate, expected] of [
    [() => {}, 1],
    [row => { delete row.managedTag }, 0],
    [row => { row.executable = "C:\\Users\\me\\AppData\\Local\\Programs\\Grok Bot\\Grok Bot.exe" }, 0],
    [row => { row.created = undefined }, 0],
  ]) {
    const row = { pid: 4242, executable, created: "t0", managedTag: "" }
    const stops = []
    const fake = fixture({ unreachable: true, exited: true })
    const driver = createGrokBotCdp({}, { ...fake.dependencies, processes: async () => [row], stopManaged: async value => { stops.push(value) } })
    try {
      await expectFailure(() => driver.create(marker, { model: "bot-id", prompt: "hello" }), "running", 409)
      row.managedTag = fake.spawns[0].argv[2].split("=")[1]
      mutate(row)
      driver.dispose(); await Bun.sleep(5)
      expect(stops).toHaveLength(expected)
      if (expected) expect(stops[0]).toMatchObject({ pid: 4242, executable, created: "t0", managedTag: row.managedTag })
    } finally { driver.dispose(); fake.close() }
  }
})

test("review F7 process enumeration errors map to debug row", async () => {
  const fake = fixture(); const driver = createGrokBotCdp({}, { ...fake.dependencies, processes: async () => { throw new Error("powershell unavailable") } })
  try { await expectFailure(() => driver.create(marker, { model: "bot-id", prompt: "hello" }), "debug") } finally { driver.dispose(); fake.close() }
})
test("review F8 tagged orphan is adopted and identity revalidated before stop", async () => {
  const fake = fixture(); let stopped = 0
  const row = { pid: 42, port: Number(new URL(fake.endpoint).port), executable: "C:\\Programs\\Grok Bot\\Grok Bot.exe", created: "start", managedTag: "999999:12345678-1234-4234-8234-123456789abc" }
  const driver = createGrokBotCdp({ keepAliveMinutes: 0.01 }, { ...fake.dependencies, processes: async () => [row], parentAlive: () => false, stopManaged: async () => { stopped++ } })
  try { await driver.liveModels(marker); fake.expireIdle(); await Bun.sleep(5); expect(stopped).toBe(1) } finally { driver.dispose(); fake.close() }
})

test("review AJ identical loader retries reconnect twice without resubmission", async () => {
  const fake = fixture({ quitAfterSubmit: true })
  const quick = { now: Date.now, random: () => 0.5, setTimeout: (callback, delay) => setTimeout(callback, delay >= 1600 && delay <= 10000 ? 0 : delay), clearTimeout }
  const plugin = makeGrokBotDriver({}, { progress: false }, { cdp: fake.dependencies, timers: quick })
  try {
    const loader = await plugin.auth.loader(async () => marker)
    const ask = () => loader.fetch(loader.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: "bot-id", messages: [{ role: "user", content: "same" }] }) })
    expect((await ask()).status).toBe(502)
    fake.state.quitAfterSubmit = false
    fake.disconnect(); await Bun.sleep(5); fake.state.unreachable = true
    expect((await ask()).status).toBe(502)
    const attempts = fake.spawns.length
    expect((await ask()).status).toBe(502)
    expect(fake.spawns.length).toBeGreaterThan(attempts)
    fake.state.unreachable = false
    fake.state.tail.push({ role: "assistant", text: "recovered answer" })
    const response = await ask(); expect(response.status).toBe(200)
    expect((await response.json()).choices[0].message.content).toBe("recovered answer")
    expect(fake.frames.filter(frame => frame.params.expression?.includes("desktopMount.submitPrompt("))).toHaveLength(1)
    fake.expireIdle()
  } finally { fake.close() }
})

test("review F2 implemented gate distinguishes missing installation from scaffold", async () => {
  const gate = Bun.spawn([process.execPath, "scripts/check.mjs", "--stubs"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, MAGPIE_CLOUD_AGENTS_DEBUG: "0", ProgramFiles: "Z:\\missing", LOCALAPPDATA: "Z:\\missing", PATH: "Z:\\missing" } })
  const output = await new Response(gate.stdout).text(); const errors = await new Response(gate.stderr).text()
  expect({ code: await gate.exited, errors }).toEqual({ code: 0, errors: "" })
  expect(output).toContain("implemented: grok-bot; scaffold: 5")
})

test("CDP client rejects remote websocket endpoints", async () => { await expect(connectCdp("ws://example.invalid:9333/devtools/page/1")).rejects.toThrow(messages.debug) })

test("CDP sign-in succeeds while the user's own app runs without a debug endpoint", async () => {
  const fake = fixture({ previous: true, unreachable: true })
  try {
    expect(await (await fake.driver.authorize()).callback()).toEqual({ type: "success", refresh: "grok-bot-cdp", access: "app-local", expires: 0, accountId: "grok-bot-cdp", mechanism: "cdp" })
    expect(fake.spawns).toHaveLength(0)
  } finally { fake.close() }
})

for (const scenario of ["closed", "running", "attachable", "orphan", "configured"]) test(`CDP sign-in ${scenario} never launches or terminates the app`, async () => {
  const fake = fixture({ unreachable: scenario === "running" })
  let stopped = 0, attached = 0, detached = 0, enumerated = 0
  const port = Number(new URL(fake.endpoint).port)
  const row = { pid: 42, executable: "C:\\Programs\\Grok Bot\\Grok Bot.exe", created: "start", managedTag: "999999:12345678-1234-4234-8234-123456789abc", port: scenario === "running" ? undefined : port }
  const driver = createGrokBotCdp({ reattachPorts: scenario === "configured" ? [port] : [] }, {
    ...fake.dependencies,
    processes: async () => { enumerated++; return ["closed", "configured"].includes(scenario) ? [] : [row] },
    parentAlive: () => scenario !== "orphan",
    stopManaged: async () => { stopped++ },
    connect: async () => { attached++; return { close() { detached++ } } },
  })
  try {
    const result = await (await driver.authorize()).callback()
    expect(result.type).toBe("success")
    expect(enumerated).toBe(1)
    expect(attached).toBe(["closed", "running"].includes(scenario) ? 0 : 1)
    expect(detached).toBe(attached)
    fake.expireIdle()
  } finally { driver.dispose(); fake.close() }
  await Bun.sleep(5)
  expect(fake.spawns).toHaveLength(0)
  expect(fake.kills).toBe(0)
  expect(stopped).toBe(0)
})

test("CDP sign-in attaches through the real client without launching", async () => {
  const fake = fixture({ previous: true, reattach: true })
  try {
    expect((await (await fake.driver.authorize()).callback()).type).toBe("success")
    expect(fake.connections).toBe(1)
    expect(fake.spawns).toHaveLength(0)
  } finally { fake.close() }
  expect(fake.kills).toBe(0)
})

test("CDP sign-in rejects a verified endpoint whose renderer cannot attach", async () => {
  const fake = fixture({ previous: true, reattach: true })
  const driver = createGrokBotCdp({}, { ...fake.dependencies, connect: async () => { throw new Error(messages.debug) } })
  try { expect(await (await driver.authorize()).callback()).toEqual({ type: "failed", error: messages.debug }); expect(fake.spawns).toHaveLength(0) }
  finally { driver.dispose(); fake.close() }
})

test("CDP sign-in reports process enumeration failure", async () => {
  const fake = fixture()
  const driver = createGrokBotCdp({}, { ...fake.dependencies, processes: async () => { throw new Error("unavailable") } })
  try { expect(await (await driver.authorize()).callback()).toEqual({ type: "failed", error: messages.debug }) }
  finally { driver.dispose(); fake.close() }
})

test("CDP sign-in verifies installation and saves only a local marker without launching", async () => {
  const plugin = makeGrokBotDriver({}, { grokBot: { dependencies: { processes: async () => [], exists: async () => true, spawn: () => { throw new Error("must not launch") } } } })
  const flow = await plugin.auth.methods[0].authorize()
  expect(await flow.callback()).toEqual({ type: "success", refresh: "grok-bot-cdp", access: "app-local", expires: 0, accountId: "grok-bot-cdp", mechanism: "cdp" })
})
