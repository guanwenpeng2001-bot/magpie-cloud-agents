import { expect, test } from "bun:test"
import { makeDotsDriver } from "./dots.mjs"
import { createDotsApp, findChatGptApp, connectCdp, SEND_BUTTON_MATCH, DOTS_APP_ERRORS } from "./dots-app.mjs"

import { readFile } from "node:fs/promises"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"

const marker = { type: "oauth", access: "app-local", refresh: "dots-app-cdp", accountId: "dots-app", mechanism: "app-drive" }
const messages = DOTS_APP_ERRORS
const DOTS_ROUTE = "app://-/index.html?initialRoute=%2Fdots"

async function expectFailure(operation, key, status = 502, signIn = "kept") {
  let error
  try { await operation() } catch (caught) { error = caught }
  expect(error?.message).toBe(messages[key])
  const response = (await import("../lib/errors.mjs")).errorResponse(error)
  expect(response.status).toBe(status)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe(signIn)
}

function fixture(settings = {}) {
  const frames = [], spawns = [], timers = new Map(), managedRows = [], stoppedRows = []
  let timestamp = 0, nextTimer = 0, clients = []
  const state = { previous: true, reattach: true, sidebar: true, route: DOTS_ROUTE, composer: true, sendButton: true, rows: [], replies: [], ...settings }
  const auto = new Set([200, 250])
  const timerApi = {
    now: () => timestamp,
    setTimeout(callback, delay) {
      const timer = { id: ++nextTimer, unref() {} }
      if (auto.has(delay)) { timestamp += delay; queueMicrotask(callback) }
      else timers.set(timer, { callback, delay })
      return timer
    },
    clearTimeout(timer) { timers.delete(timer) }, random: () => 0.5,
  }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { if (server.upgrade(request, { data: { path: new URL(request.url).pathname } })) return; return new Response(null, { status: 404 }) },
    websocket: {
      open(socket) { clients.push(socket) },
      message(socket, data) {
        const frame = JSON.parse(String(data)); frames.push({ path: socket.data?.path, ...frame })
        const expression = frame.params?.expression ?? ""
        const shell = (socket.data?.path ?? "").endsWith("/shell")
        let value
        let error
        if (expression.includes("新聊天")) value = state.sidebar && shell
        else if (expression.includes("location.assign")) { state.route = DOTS_ROUTE; state.composer = true }
        else if (expression.includes("location.href")) value = { href: state.route, composer: state.composer }
        else if (expression.includes("message-row")) value = state.rows
        else if (expression.includes("发送")) {
          let clicked = false
          const button = { getAttribute: () => "发送", innerText: "", textContent: "", getBoundingClientRect: () => ({ left: 1141, top: 764, width: 28, height: 28 }), click() { clicked = true } }
          const document = {
            querySelector: () => ({ getBoundingClientRect: () => ({ left: 482, top: 760, width: 600, height: 36 }) }),
            querySelectorAll: () => state.sendButton && shell ? [button] : [],
          }
          value = new Function("document", `return ${expression}`)(document)
          if (clicked) {
            state.sendClicks = (state.sendClicks ?? 0) + 1
            if (state.onSubmit) state.onSubmit(state)
            else {
              state.rows.push({ id: `user-${state.rows.length}`, self: true, text: "" })
              if (state.replies.length) state.rows.push({ id: `assistant-${state.rows.length}`, self: false, text: state.replies.shift() })
            }
          }
        }
        else if (expression.includes("composer.focus()") || expression.includes("ProseMirror")) value = state.composer
        socket.send(JSON.stringify(error ? { id: frame.id, result: { exceptionDetails: { exception: { description: error } } } } : { id: frame.id, result: frame.method === "Runtime.evaluate" ? { result: { value } } : {} }))
      },
    },
  })
  const dependencies = {
    env: { LOCALAPPDATA: "C:\\Local" }, exists: async () => !state.missing, appx: async () => ["C:\\Packages\\OpenAI.Codex"],
    processes: async () => [
      ...(state.previous ? [{ pid: 42, port: state.reattach ? server.port : undefined }] : []),
      ...managedRows,
    ],
    freePort: async () => server.port,
    stopManaged: async row => { stoppedRows.push(row) },
    spawn(exe, argv, options) {
      const tag = argv.find(flag => flag.startsWith("--magpie-dots-managed="))?.split("=")[1]
      const pid = 100 + spawns.length
      const child = { pid, exitCode: state.exited ? 0 : null, once(name, callback) { if (name === "error" && state.spawnError) queueMicrotask(() => callback(new Error(state.spawnError))) } }
      if (tag) managedRows.push({ pid, executable: exe, created: "spawned", managedTag: tag })
      spawns.push({ exe, argv, options })
      return child
    },
    fetch: async url => {
      if (state.unreachable) throw new Error("unreachable")
      if (String(url).endsWith("/json/version")) return Response.json({ Browser: "Chrome/148.0" })
      const ws = `ws://127.0.0.1:${server.port}/devtools/page/`
      return Response.json([
        ...(state.decoys ? [
          { type: "page", url: "app://-/index.html", webSocketDebuggerUrl: ws + "avatar-overlay" },
          { type: "page", url: "app://-/detached-window.html", webSocketDebuggerUrl: ws + "detached" },
        ] : []),
        { type: "page", url: "app://-/index.html", webSocketDebuggerUrl: ws + "shell" },
      ])
    },
    timers: state.realTimers ? { now: Date.now, setTimeout, clearTimeout } : timerApi,
  }
  const driver = createDotsApp({ keepAliveMinutes: 0.01, launchTimeoutMs: 1200, stableMs: 0, ...(settings.driverOptions ?? {}) }, dependencies)
  return { state, frames, spawns, dependencies, driver, endpoint: `ws://127.0.0.1:${server.port}/devtools/page/shell`, managedRows, stoppedRows,
    expireIdle() { for (const [timer, job] of [...timers]) if (job.delay === 600) { timers.delete(timer); job.callback() } },
    close() { driver.dispose(); server.stop(true) },
  }
}
const send = fixture => fixture.driver.create(marker, { prompt: "hello" })

test("real production teardown guard terminates only the identified tagged process under Windows PowerShell", async () => {
  if (process.platform !== "win32") return
  const source = await readFile(new URL("./dots-app.mjs", import.meta.url), "utf8")
  const guard = source.match(/const script = (`[^`]+`)/)[1]
  const script = new Function(`return ${guard}`)()
  const projection = source.match(/Select-Object ProcessId,CommandLine,ExecutablePath,([^\n]+?)\) \| ConvertTo-Json/)[1]
  const tag = `${process.pid}:${randomUUID()}`
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", `--magpie-dots-managed=${tag}`], { stdio: "ignore" })
  const execute = promisify(execFile)
  const alive = () => { try { process.kill(child.pid, 0); return true } catch { return false } }
  async function stop(row) {
    await new Promise((resolve, reject) => {
      const command = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 5000, windowsHide: true }, error => error ? reject(error) : resolve())
      command.stdin.end(JSON.stringify(row))
    })
  }
  try {
    const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-CimInstance Win32_Process -Filter "ProcessId=${child.pid}" | Select-Object ProcessId,CommandLine,ExecutablePath,${projection} | ConvertTo-Json -Compress`])
    const observed = JSON.parse(stdout)
    const row = { pid: observed.ProcessId, executable: observed.ExecutablePath, created: observed.CreationDate, managedTag: tag }
    for (const changed of [{ created: "0" }, { executable: "C:\\not-the-executable.exe" }, { managedTag: "" }, { managedTag: tag.slice(0, -1) }, { managedTag: `${process.pid}:${randomUUID()}` }]) {
      await stop({ ...row, ...changed })
      expect(alive()).toBe(true)
    }
    await stop(row)
    expect(alive()).toBe(false)
  } finally { if (alive()) child.kill() }
}, 30000)

test("failed conversation reset releases the slot for a fresh ask", async () => {
  const fake = fixture()
  try {
    const run = await send(fake)
    await fake.driver.poll(marker, run)
    fake.state.rows = []
    expect((await fake.driver.poll(marker, run)).state).toBe("failed")
    const fresh = await send(fake)
    expect(fresh.prompt).toBe("hello")
  } finally { fake.close() }
})

test("discovery resolves the exe under the app\\ subdirectory and at the install root", async () => {
  const underApp = await findChatGptApp({ appx: async () => ["C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0"], exists: async path => path === "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe" })
  expect(underApp).toBe("C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe")
  const atRoot = await findChatGptApp({ appx: async () => ["C:\\Packages\\OpenAI.Codex"], exists: async path => path === "C:\\Packages\\OpenAI.Codex\\ChatGPT.exe" })
  expect(atRoot).toBe("C:\\Packages\\OpenAI.Codex\\ChatGPT.exe")
  await expect(findChatGptApp({ appx: async () => [], exists: async () => false })).rejects.toThrow(messages.missing)
})

test("CDP client rejects remote websocket endpoints", async () => { await expect(connectCdp("ws://example.invalid:9333/devtools/page/1")).rejects.toThrow(messages.debug) })

test("send control is matched by accessible name without inner text, and geometry still applies", () => {
  const match = (0, eval)(SEND_BUTTON_MATCH)
  const box = { left: 482, top: 760, width: 600, height: 36 }
  const iconButton = { getAttribute: () => "发送", innerText: "", textContent: "", getBoundingClientRect: () => ({ left: 1141, top: 764, width: 28, height: 28 }) }
  expect(match(iconButton, box)).toBe(true)
  expect(match({ ...iconButton, getAttribute: () => "复制" }, box)).toBe(false)
  expect(match({ ...iconButton, getBoundingClientRect: () => ({ left: 10, top: 764, width: 28, height: 28 }) }, box)).toBe(false)
  expect(match({ getAttribute: () => "", innerText: "发送", textContent: "发送", getBoundingClientRect: () => ({ left: 1141, top: 764, width: 28, height: 28 }) }, box)).toBe(true)
})

test("a surface with no send control fails with the changed-UI error", async () => {
  const fake = fixture({ sendButton: false })
  try { await expectFailure(() => send(fake), "changed") } finally { fake.close() }
})

test("launch binds debug argv to loopback, clears and types into the Dot surface, then clicks send", async () => {
  const fake = fixture({ replies: ["收到"] })
  try {
    const run = await send(fake)
    expect(fake.spawns).toHaveLength(0)
    const inserted = fake.frames.filter(frame => frame.method === "Input.insertText")
    expect(inserted).toHaveLength(1)
    expect(inserted[0].params.text).toBe(run.prompt)
    expect(fake.frames.filter(frame => frame.method === "Input.dispatchKeyEvent").map(frame => frame.params.windowsVirtualKeyCode)).toEqual([65, 65, 8, 8])
    expect(fake.state.sendClicks).toBe(1)
    expect(fake.frames.filter(frame => frame.params.expression?.includes("发送"))).toHaveLength(1)
    expect((await fake.driver.poll(marker, run)).state).toBe("running")
    expect(await fake.driver.poll(marker, run)).toEqual({ state: "succeeded", text: "收到" })
  } finally { fake.close() }
})

test("navigates to the Dot surface when the shell is on another route", async () => {
  const fake = fixture({ route: "app://-/index.html", composer: false })
  try {
    await send(fake)
    expect(fake.frames.some(frame => frame.params.expression?.includes("location.assign"))).toBe(true)
    expect(fake.state.route).toBe(DOTS_ROUTE)
  } finally { fake.close() }
})

test("attach skips the avatar-overlay and detached-window pages and only drives the shell", async () => {
  const fake = fixture({ decoys: true, replies: ["answer"] })
  try {
    await send(fake)
    const driven = fake.frames.filter(frame => frame.params.expression?.includes("composer.focus()") || frame.params.expression?.includes("发送"))
    expect(driven.length).toBeGreaterThan(0)
    expect(driven.every(frame => frame.path.endsWith("/shell"))).toBe(true)
  } finally { fake.close() }
})

test("stale assistant rows from a previous conversation are never reported as the answer", async () => {
  const fake = fixture({ rows: [{ id: "old", self: false, text: "old answer" }] })
  try {
    const run = await send(fake)
    const first = await fake.driver.poll(marker, run)
    expect(first.state).toBe("running")
    expect(first.partial).toBeUndefined()
    fake.state.rows.push({ id: "new", self: false, text: "fresh answer" })
    const second = await fake.driver.poll(marker, run)
    expect(second).toEqual({ state: "running", progress: expect.any(String), partial: "fresh answer" })
    expect(await fake.driver.poll(marker, run)).toEqual({ state: "succeeded", text: "fresh answer" })
  } finally { fake.close() }
})

test("progressive reply text surfaces as cumulative content before the run completes", async () => {
  const fake = fixture({ realTimers: true, driverOptions: { keepAliveMinutes: 60, stableMs: 300, streamIntervalMs: 20 }, replies: [] })
  try {
    const run = await send(fake)
    const events = []
    const pending = fake.driver.stream(marker, run, event => events.push(event))
    await Bun.sleep(60)
    fake.state.rows.push({ id: "assistant", self: false, text: "收到" })
    await Bun.sleep(120)
    expect(events.some(event => event?.content === "收到")).toBe(true)
    expect(events.some(event => event?.content === "收到，这是完整回答")).toBe(false)
    fake.state.rows.at(-1).text = "收到，这是完整回答"
    const outcome = await pending
    expect(outcome).toEqual({ state: "succeeded", text: "收到，这是完整回答" })
    expect(events.some(event => event?.content === "收到，这是完整回答")).toBe(true)
  } finally { fake.close() }
})

test("conversation reset after the turn was seen fails instead of hanging", async () => {
  const fake = fixture()
  try {
    const run = await send(fake)
    expect((await fake.driver.poll(marker, run)).state).toBe("running")
    fake.state.rows = []
    expect(await fake.driver.poll(marker, run)).toEqual({ state: "failed", progress: messages.reset })
  } finally { fake.close() }
})

test("second concurrent turn on the same Dot is refused, not interleaved", async () => {
  const fake = fixture()
  try {
    const results = await Promise.allSettled([send(fake), send(fake)])
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
    expect(results.find(result => result.status === "rejected").reason.status).toBe(409)
    expect(fake.state.sendClicks).toBe(1)
    expect(fake.frames.filter(frame => frame.params.expression?.includes("发送"))).toHaveLength(1)
  } finally { fake.close() }
})

test("cancel frees the turn slot", async () => {
  const fake = fixture({ replies: ["first", "second"] })
  try {
    const run = await send(fake)
    await fake.driver.cancel(marker, run)
    const next = await send(fake)
    expect(next.prompt).toBe("hello")
    const keys = fake.frames.filter(frame => frame.method === "Input.insertText").map(frame => frame.params.text)
    expect(keys).toEqual(["hello", "hello"])
  } finally { fake.close() }
})

test("followUp sends the suffix as a new turn with an incremented index", async () => {
  const fake = fixture({ replies: ["first", "second"] })
  try {
    const run = await send(fake)
    expect((await fake.driver.poll(marker, run)).state).toBe("running")
    expect(await fake.driver.poll(marker, run)).toEqual({ state: "succeeded", text: "first" })
    const next = await fake.driver.followUp(marker, run, ["again"])
    expect(next.turnIndex).toBe(run.turnIndex + 1)
    expect(fake.frames.filter(frame => frame.method === "Input.insertText").at(-1).params.text).toBe("again")
    expect((await fake.driver.poll(marker, next)).state).toBe("running")
    expect(await fake.driver.poll(marker, next)).toEqual({ state: "succeeded", text: "second" })
  } finally { fake.close() }
})

test("liveModels reports the Dot from the app shell", async () => {
  const fake = fixture()
  try { expect(await fake.driver.liveModels(marker)).toEqual({ dot: { name: "ChatGPT Dot", tool_call: false } }) }
  finally { fake.close() }
})

test("no reachable debug port launches the installed app with debug flags and no separate profile", async () => {
  const fake = fixture({ previous: false, reattach: false, replies: ["回答"] })
  try {
    expect((await (await fake.driver.authorize()).callback()).type).toBe("success")
    expect(fake.spawns).toHaveLength(1)
    const launched = fake.spawns[0]
    expect(launched.exe).toBe("C:\\Packages\\OpenAI.Codex\\ChatGPT.exe")
    expect(launched.argv).toContain(`--remote-debugging-port=${Number(new URL(fake.endpoint).port)}`)
    expect(launched.argv).toContain("--remote-debugging-address=127.0.0.1")
    expect(launched.argv.some(flag => /^--magpie-dots-managed=\d+:[0-9a-f-]{36}$/.test(flag))).toBe(true)
    expect(launched.argv.some(flag => flag.startsWith("--user-data-dir"))).toBe(false)
    const run = await send(fake)
    expect((await fake.driver.poll(marker, run)).state).toBe("running")
    expect(await fake.driver.poll(marker, run)).toEqual({ state: "succeeded", text: "回答" })
  } finally { fake.close() }
  await Bun.sleep(10)
  const tag = fake.spawns[0].argv.find(flag => flag.startsWith("--magpie-dots-managed="))?.split("=")[1]
  expect(fake.stoppedRows).toHaveLength(1)
  expect(fake.stoppedRows[0].managedTag).toBe(tag)
})

for (const entry of ["checkDrivable", "liveModels", "create"]) {
  test(`cold launch waits for the shell before ${entry}`, async () => {
    const fake = fixture({ previous: false, decoys: true })
    const driver = createDotsApp({}, { ...fake.dependencies, connect: async url => ({
      open: true,
      async evaluate(expression) {
        if (expression.includes("新聊天")) return url.endsWith("/shell") && fake.dependencies.timers.now() >= 1000
        if (expression.includes("location.href")) return { composer: true }
        if (expression.includes("message-row")) return []
        return true
      },
      async call() {}, close() {},
    }) })
    try {
      const result = entry === "create" ? await driver.create(marker, { prompt: "hello" }) : await driver[entry](marker)
      expect(fake.dependencies.timers.now()).toBe(1000)
      expect(fake.spawns).toHaveLength(1)
      if (entry === "liveModels") expect(result).toHaveProperty("dot.name", "ChatGPT Dot")
      if (entry === "create") expect(result.prompt).toBe("hello")
    } finally { driver.dispose(); fake.close() }
  })
}

for (const appBootMs of [undefined, 750]) {
  test(`cold launch preserves signedOut after the ${appBootMs ?? "default"} boot window`, async () => {
    const fake = fixture({ previous: false, sidebar: false, driverOptions: { appBootMs } })
    try {
      await expectFailure(() => fake.driver.checkDrivable(), "signedOut", 401, "expired")
      expect(fake.dependencies.timers.now()).toBe(appBootMs ?? 15000)
    } finally { fake.close() }
  })
}

test.each(["30s", NaN, Infinity, -Infinity, {}, -1, null, 0])("cold launch bounds malformed or zero appBootMs %p", async appBootMs => {
  const fake = fixture({ previous: false })
  const timers = fake.dependencies.timers
  const driver = createDotsApp({ appBootMs }, { ...fake.dependencies,
    timers: { ...timers, setTimeout(callback, delay) {
      if (!Number.isFinite(delay) || delay < 0 || timers.now() > 15000) throw new Error("invalid or unbounded boot wait")
      return timers.setTimeout(callback, delay)
    } },
    connect: async () => ({ open: true, evaluate: async () => false, close() {} }),
  })
  try {
    await expectFailure(() => driver.checkDrivable(), "signedOut", 401, "expired")
    expect(timers.now()).toBe(appBootMs === 0 ? 0 : 15000)
  } finally { driver.dispose(); fake.close() }
})

test("attach closes each unsuccessful candidate before opening another and at the deadline", async () => {
  const fake = fixture({ previous: false, decoys: true })
  const events = []
  const driver = createDotsApp({ appBootMs: 250 }, { ...fake.dependencies,
    connect: async url => {
      events.push(["open", url])
      return { open: true, evaluate: async () => false, close() { events.push(["close", url]) } }
    },
  })
  try {
    await expectFailure(() => driver.checkDrivable(), "signedOut", 401, "expired")
    const opened = events.filter(([event]) => event === "open").map(([, url]) => url)
    expect(opened).toHaveLength(6)
    expect(events).toEqual(opened.flatMap(url => [["open", url], ["close", url]]))
    expect(fake.dependencies.timers.now()).toBe(250)
  } finally { driver.dispose(); fake.close() }
})

for (const previous of [false, true]) {
  test(`an already-live shell adds no delay on ${previous ? "reattach" : "launch"}`, async () => {
    const fake = fixture({ previous })
    try {
      await fake.driver.checkDrivable()
      expect(fake.dependencies.timers.now()).toBe(0)
      expect(fake.spawns).toHaveLength(previous ? 0 : 1)
    } finally { fake.close() }
  })
}

test("a launched instance that later exits on its own is not force-stopped", async () => {
  const fake = fixture({ previous: false, reattach: false, replies: ["回答"] })
  try {
    const run = await send(fake)
    expect((await fake.driver.poll(marker, run)).state).toBe("running")
    expect(await fake.driver.poll(marker, run)).toEqual({ state: "succeeded", text: "回答" })
    await fake.driver.liveModels(marker)
    fake.managedRows.length = 0
    fake.expireIdle()
    await Bun.sleep(10)
    expect(fake.stoppedRows).toHaveLength(0)
  } finally { fake.close() }
  await Bun.sleep(10)
  expect(fake.stoppedRows).toHaveLength(0)
})

test("idle teardown of a launched instance terminates only the tagged instance, never the pre-existing one", async () => {
  const fake = fixture({ previous: true, reattach: false, replies: ["回答"] })
  try {
    const run = await send(fake)
    expect((await fake.driver.poll(marker, run)).state).toBe("running")
    expect(await fake.driver.poll(marker, run)).toEqual({ state: "succeeded", text: "回答" })
    await fake.driver.liveModels(marker)
    expect(fake.spawns).toHaveLength(1)
    fake.expireIdle()
    await Bun.sleep(10)
    expect(fake.stoppedRows).toHaveLength(1)
    expect(fake.stoppedRows[0].pid).not.toBe(42)
    expect(fake.stoppedRows[0].managedTag).toBe(fake.spawns[0].argv.find(flag => flag.startsWith("--magpie-dots-managed="))?.split("=")[1])
  } finally { fake.close() }
})

test("launch teardown stops its own spawned child, never a same-tag same-exe foreign row", async () => {
  const fake = fixture({ previous: false, reattach: false })
  try {
    await send(fake)
    expect(fake.spawns).toHaveLength(1)
    // A row this plugin instance never launched, listed before the child, carrying the identical
    // tag and executable path: the teardown must still stop the spawned pid only.
    const tag = fake.spawns[0].argv.find(flag => flag.startsWith("--magpie-dots-managed="))?.split("=")[1]
    fake.managedRows.unshift({ pid: 777, executable: fake.spawns[0].exe, created: "spawned", managedTag: tag })
  } finally { fake.close() }
  await Bun.sleep(10)
  expect(fake.stoppedRows).toHaveLength(1)
  expect(fake.stoppedRows[0].pid).toBe(100)
  expect(fake.stoppedRows.some(row => row.pid === 777)).toBe(false)
})

test("launch hands off to an already running instance without a port and fails without killing anything", async () => {
  const fake = fixture({ previous: true, reattach: false, unreachable: true, exited: true })
  try { await expectFailure(() => send(fake), "running", 409) } finally { fake.close() }
  expect(fake.spawns).toHaveLength(1)
  await Bun.sleep(10)
  // The fake's process table still lists the exited child, so the teardown may stop that child
  // (pid 100, this launch's own spawn) — but nothing else, and never the pre-existing pid 42.
  expect(fake.stoppedRows.map(row => row.pid)).toEqual([100])
  expect(fake.stoppedRows.some(row => row.pid === 42)).toBe(false)
})

test("launched app that exits immediately without a running instance fails with a dedicated message", async () => {
  const fake = fixture({ previous: false, reattach: false, unreachable: true, exited: true })
  try { await expectFailure(() => send(fake), "launch") } finally { fake.close() }
})

test("a spawn failure surfaces the underlying reason instead of a generic error", async () => {
  const fake = fixture({ previous: false, reattach: false, unreachable: true, spawnError: "spawn ChatGPT.exe ENOENT" })
  let error
  try {
    try { await send(fake) } catch (caught) { error = caught }
    expect(error?.message).toContain("failed to start the ChatGPT desktop app")
    expect(error?.message).toContain("spawn ChatGPT.exe ENOENT")
  } finally { fake.close() }
})

test("waiting for the launched app's debug port is bounded and reports the debug error on timeout", async () => {
  const fake = fixture({ previous: false, reattach: false, unreachable: true })
  try { await expectFailure(() => send(fake), "debug") } finally { fake.close() }
})

test("a slow handoff alongside a pre-existing instance reports the running error on timeout, not the debug error", async () => {
  const fake = fixture({ previous: true, reattach: false, unreachable: true })
  try { await expectFailure(() => send(fake), "running", 409) } finally { fake.close() }
  await Bun.sleep(10)
  expect(fake.stoppedRows.some(row => row.pid === 42)).toBe(false)
})

test("sign-in instructions describe the launch behaviour instead of manual debug flags", async () => {
  const fake = fixture()
  try {
    const instructions = (await fake.driver.authorize()).instructions
    expect(instructions).toContain("launches")
    expect(instructions).not.toContain("--remote-debugging-port")
  } finally { fake.close() }
})

test("sign-in without an installation fails with the missing error and never launches", async () => {
  const fake = fixture({ missing: true })
  try {
    expect(await (await fake.driver.authorize()).callback()).toEqual({ type: "failed", error: messages.missing })
    expect(fake.spawns).toHaveLength(0)
  } finally { fake.close() }
})

test("reattaching to a running app with a debug port never launches or terminates anything", async () => {
  const fake = fixture({ previous: true, reattach: true })
  try {
    expect((await (await fake.driver.authorize()).callback()).type).toBe("success")
    expect(fake.spawns).toHaveLength(0)
    fake.expireIdle()
  } finally { fake.close() }
  await Bun.sleep(10)
  expect(fake.stoppedRows).toHaveLength(0)
})

test("idle teardown disconnects without terminating an untagged app", async () => {
  const fake = fixture({ replies: ["answer"] })
  try {
    const run = await send(fake)
    fake.expireIdle()
    expect(fake.stoppedRows).toHaveLength(0)
    await fake.driver.poll(marker, run)
    await fake.driver.poll(marker, run)
    fake.expireIdle()
    await Bun.sleep(10)
    expect(fake.stoppedRows).toHaveLength(0)
  } finally { fake.close() }
})

test("orphan managed instance is adopted and identity revalidated before stop", async () => {
  const fake = fixture()
  let stopped = 0
  const driver = createDotsApp({ keepAliveMinutes: 0.01 }, { ...fake.dependencies, processes: async () => [{ pid: 42, port: Number(new URL(fake.endpoint).port), executable: "C:\\Packages\\OpenAI.Codex\\ChatGPT.exe", created: "start", managedTag: "999999:12345678-1234-4234-8234-123456789abc" }], parentAlive: () => false, stopManaged: async () => { stopped++ } })
  try { await driver.liveModels(marker); driver.dispose(); await Bun.sleep(10); expect(stopped).toBe(1) } finally { driver.dispose(); fake.close() }
})

test("factory exposes two methods, app-drive live models, and the loader dispatches on the stored mechanism", async () => {
  const fake = fixture({ replies: ["app answer"] })
  const plugin = makeDotsDriver({}, { dotsApp: { stableMs: 0 } }, { app: fake.dependencies })
  try {
    expect(plugin.auth.methods).toHaveLength(2)
    expect(plugin.auth.methods[0].label).toContain("ChatGPT")
    expect(plugin.auth.methods[1].label).toContain("tunnel")
    const result = await (await plugin.auth.methods[0].authorize()).callback()
    expect(result).toEqual({ type: "success", refresh: "dots-app-cdp", access: "app-local", expires: 0, accountId: "dots-app", mechanism: "app-drive" })
    const loader = await plugin.auth.loader(async () => marker)
    const response = await loader.fetch("https://dots.cloud-agents.invalid/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "dot", messages: [{ role: "user", content: "hi" }] }) })
    expect(response.status).toBe(200)
    expect((await response.json()).choices[0].message.content).toBe("app answer")
    fake.expireIdle()
    const models = await plugin.provider.models({ models: { dot: { name: "floor" } } }, { auth: marker })
    expect(models.dot.name).toBe("ChatGPT Dot")
    const tunnelLoader = await plugin.auth.loader(async () => ({ type: "oauth", access: "dots-local", refresh: "dots-tunnel", accountId: "dot", dot_token: "x".repeat(32) }))
    await expect(tunnelLoader.fetch("https://dots.cloud-agents.invalid/v1/chat/completions", { method: "POST", body: "{}" })).resolves.toHaveProperty("status")
  } finally { await plugin._internal.close(); fake.close() }
})
