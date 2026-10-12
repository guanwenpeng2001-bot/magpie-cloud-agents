import { createHash, randomUUID } from "node:crypto"
import { access } from "node:fs/promises"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { createServer } from "node:net"
import { win32 } from "node:path"
import { chatError } from "../lib/errors.mjs"
import { clock, fetchWithTimeout, sleep, withTimeout } from "../lib/http.mjs"

export const DOTS_APP_ERRORS = {
  missing: "ChatGPT desktop isn't installed — install the OpenAI ChatGPT app from the Microsoft Store and sign in once, then retry",
  signedOut: "ChatGPT desktop isn't signed in — open it and sign in once; Magpie will drive the Dot after that",
  running: "ChatGPT is already running without a debug port, so Magpie's launch handed off to that instance and no debug interface opened. Quit the running ChatGPT and retry — Magpie will start it with debugging on its own. The bundled-tunnel sign-in also still works.",
  launch: "Magpie launched the ChatGPT desktop app but it exited immediately without opening a debug port — open ChatGPT once manually to check for an error dialog, then retry; the bundled-tunnel sign-in also still works",
  changed: "ChatGPT changed its UI; the dots provider needs an update",
  crashed: "ChatGPT closed mid-answer — your prompt may still be answered in the app; ask again to re-attach",
  reset: "The Dot conversation was reset — asking again sends it as a new task",
  debug: "ChatGPT didn't open its debug interface — another security tool may be blocking it",
}
const failure = key => chatError(key === "signedOut" ? 401 : key === "running" ? 409 : 502, DOTS_APP_ERRORS[key])
const launchFailed = reason => chatError(502, `Magpie failed to start the ChatGPT desktop app (${reason}) — install or repair the OpenAI ChatGPT app and retry; the bundled-tunnel sign-in also still works`)
const execute = promisify(execFile)

const SHELL_PAGE = "app://-/index.html"
const DOTS_ROUTE = "app://-/index.html?initialRoute=%2Fdots"

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function processes() {
  const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "@(Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe'\" | Select-Object ProcessId,CommandLine,ExecutablePath,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().Ticks.ToString()}}) | ConvertTo-Json -Compress"], { windowsHide: true, timeout: 5000 })
  const rows = JSON.parse(stdout || "[]")
  return (Array.isArray(rows) ? rows : [rows]).map(row => ({ pid: row.ProcessId, executable: row.ExecutablePath, created: row.CreationDate, managedTag: row.CommandLine?.match(/--magpie-dots-managed=([0-9]+:[0-9a-f-]+)/)?.[1], port: Number(row.CommandLine?.match(/--remote-debugging-port[= ](\d+)/)?.[1]) || undefined }))
}
function parentAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== "ESRCH" }
}
async function stopManaged(row) {
  const script = `$expected = [Console]::In.ReadToEnd() | ConvertFrom-Json; $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($expected.pid)"; if ($process -and $process.ExecutablePath -eq $expected.executable -and $process.CreationDate.ToUniversalTime().Ticks.ToString() -ceq $expected.created -and $expected.managedTag -cmatch '^[1-9][0-9]*:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -and $process.CommandLine -cmatch ('(?:^|\\s)--magpie-dots-managed=' + [regex]::Escape($expected.managedTag) + '(?=\\s|$)')) { Invoke-CimMethod -InputObject $process -MethodName Terminate | Out-Null }`
  const child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 5000 })
  child.stdin.end(JSON.stringify(row))
  await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(failure("debug"))) })
}
async function readAppxLocations() {
  try {
    const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "@(Get-AppxPackage -Name OpenAI.Codex | Select-Object -ExpandProperty InstallLocation) | ConvertTo-Json -Compress"], { windowsHide: true, timeout: 10000 })
    const value = JSON.parse(stdout || "[]")
    return (Array.isArray(value) ? value : [value]).filter(Boolean)
  } catch { return [] }
}

export async function findChatGptApp({ env = process.env, exists = path => access(path).then(() => true, () => false), appx = readAppxLocations } = {}) {
  for (const location of await appx()) {
    const root = String(location).replace(/^"|"$/g, "")
    // The MSIX layout moved the exe under app\ (OpenAI.Codex 26.1007.x); older builds keep it at the install root.
    for (const candidate of [win32.join(root, "ChatGPT.exe"), win32.join(root, "app", "ChatGPT.exe")]) {
      if (await exists(candidate)) return candidate
    }
  }
  throw failure("missing")
}

export async function connectCdp(url, { WebSocket: Socket = globalThis.WebSocket, timers = clock, timeoutMs = 10000 } = {}, signal) {
  const address = new URL(url)
  if (address.protocol !== "ws:" || address.hostname !== "127.0.0.1" || address.username || address.password) throw failure("debug")
  const socket = new Socket(url)
  let sequence = 0
  const pending = new Map()
  const disconnected = () => { for (const job of pending.values()) job.reject(failure("crashed")); pending.clear() }
  socket.addEventListener("close", disconnected)
  socket.addEventListener("error", disconnected)
  socket.addEventListener("message", event => {
    let frame
    try { frame = JSON.parse(String(event.data)) } catch { return }
    const job = pending.get(frame.id)
    if (!job) return
    pending.delete(frame.id)
    if (frame.error || frame.result?.exceptionDetails) {
      const description = frame.error?.message ?? frame.result.exceptionDetails.exception?.description ?? frame.result.exceptionDetails.text
      job.reject(Object.assign(new Error(String(description)), { bridge: true }))
    } else job.resolve(frame.result)
  })
  try {
    await withTimeout(() => new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true })
      socket.addEventListener("error", () => reject(failure("debug")), { once: true })
      socket.addEventListener("close", () => reject(failure("debug")), { once: true })
    }), signal, timeoutMs, timers)
  } catch (error) { socket.close(); throw error }
  async function call(method, params, callSignal) {
    const id = ++sequence
    try {
      return await withTimeout(() => new Promise((resolve, reject) => {
        if (socket.readyState !== 1) return reject(failure("crashed"))
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      }), callSignal, timeoutMs, timers)
    } finally { pending.delete(id) }
  }
  return {
    get open() { return socket.readyState === 1 },
    call,
    async evaluate(expression, callSignal) { return (await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, callSignal))?.result?.value },
    close() { disconnected(); socket.close() },
  }
}

// Hidden Dot renderers support CDP input without bringing the window to the foreground.
const shellProbe = `(() => { const text = document.body?.innerText ?? ""; return text.includes("新聊天") || text.includes("插件"); })()`
const surfaceProbe = `(() => ({ href: location.href, composer: !!document.querySelector('div.ProseMirror[contenteditable="true"]') }))()`
const composerProbe = `(() => !!document.querySelector('div.ProseMirror[contenteditable="true"]'))()`
const focusProbe = `(() => { const composer = document.querySelector('div.ProseMirror[contenteditable="true"]'); if (!composer) return false; composer.focus(); return true; })()`
const transcriptRead = `(() => [...document.querySelectorAll('.messages-scroll article.message-row')].map(row => ({ id: row.dataset.messageId || "", self: /(^|\\s)self/.test(row.className || ""), text: ((row.querySelector('.message-text, .message-body') || row).innerText || "") })))()`
// The send control is an icon button with no inner text; its accessible name carries 发送.
// Exported so tests evaluate the exact predicate string the page runs.
export const SEND_BUTTON_MATCH = `((candidate, box) => {
  const area = candidate.getBoundingClientRect();
  const name = (candidate.getAttribute("aria-label") || candidate.innerText || candidate.textContent || "").trim();
  return name === "发送" && area.left > box.left && Math.abs((area.top + area.height / 2) - (box.top + box.height / 2)) < 80;
})`
const sendProbe = `(() => {
  const composer = document.querySelector('div.ProseMirror[contenteditable="true"]');
  if (!composer) return false;
  const box = composer.getBoundingClientRect();
  const button = [...document.querySelectorAll("button")].find(candidate => ${SEND_BUTTON_MATCH}(candidate, box));
  if (!button) return false;
  button.click();
  return true;
})()`
const CLEAR_KEYS = [
  { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 },
  { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 },
  { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
]

export function createDotsApp(options = {}, dependencies = options.dependencies ?? {}) {
  const deps = { env: process.env, processes, parentAlive, stopManaged, exists: path => access(path).then(() => true, () => false), appx: readAppxLocations, fetch: globalThis.fetch, timers: clock, connect: connectCdp, spawn, freePort, ...dependencies }
  const timers = deps.timers
  let connection, connecting, owned, idleTimer
  const active = new Map()
  const touch = () => { timers.clearTimeout(idleTimer) }
  function release(run) {
    run.signal?.removeEventListener("abort", run.onAbort)
    if (active.get("dot") === run) active.delete("dot")
  }
  function idle() {
    touch()
    if (active.size) return
    idleTimer = timers.setTimeout(() => {
      connection?.close(); connection = undefined
      if (owned) { const child = owned; owned = undefined; if (child.exitCode == null) child.kill() }
    }, (options.keepAliveMinutes ?? 15) * 60000)
    idleTimer?.unref?.()
  }
  async function version(port, signal) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false
    try {
      const response = await fetchWithTimeout(`http://127.0.0.1:${port}/json/version`, { signal, redirect: "error" }, { fetch: deps.fetch, timeoutMs: 800 })
      return Boolean((await response.json())["Browser"])
    } catch { signal?.throwIfAborted(); return false }
  }
  async function attach(port, signal) {
    const response = await fetchWithTimeout(`http://127.0.0.1:${port}/json/list`, { signal, redirect: "error" }, { fetch: deps.fetch, timeoutMs: 2000 })
    const list = await response.json()
    const pages = (Array.isArray(list) ? list : []).filter(target => target.type === "page" && /^app:\/\/-/.test(target.url ?? "") && target.webSocketDebuggerUrl)
    pages.sort((a, b) => Number(b.url.startsWith(SHELL_PAGE)) - Number(a.url.startsWith(SHELL_PAGE)))
    let lastError
    for (const page of pages) {
      const endpoint = new URL(page.webSocketDebuggerUrl)
      if (endpoint.hostname !== "127.0.0.1" || Number(endpoint.port) !== port) continue
      const client = await deps.connect(endpoint.href, { timers, WebSocket: deps.WebSocket }, signal)
      try {
        if (await client.evaluate(shellProbe, signal)) return client
      } catch (error) { lastError = error; if (!client.open) throw error }
      client.close()
    }
    throw lastError ?? failure("signedOut")
  }
  async function runningProcesses() {
    try { return await deps.processes() } catch { throw failure("debug") }
  }
  async function reattach(previous, signal) {
    let lastError
    for (const port of [...new Set([...(options.reattachPorts ?? []), ...previous.map(row => row.port)])]) {
      if (!await version(port, signal)) continue
      try { return { port, client: await attach(port, signal) } }
      catch (error) { lastError = error }
    }
    if (lastError) throw lastError
  }
  async function adopt(previous, port, executable) {
    const row = previous.find(row => row.port === port && row.created && row.executable?.toLowerCase() === executable.toLowerCase() && /^[1-9]\d*:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.managedTag ?? ""))
    if (row && !deps.parentAlive(Number(row.managedTag.split(":")[0]))) owned = { exitCode: null, kill: () => {
      void deps.processes().then(rows => {
        if (rows.some(current => current.pid === row.pid && current.created === row.created && current.executable === row.executable && current.managedTag === row.managedTag) && !deps.parentAlive(Number(row.managedTag.split(":")[0]))) return deps.stopManaged(row)
      }).catch(() => {})
    } }
  }
  async function launch(executable, previous, signal) {
    // No --user-data-dir on purpose: the ChatGPT app cannot be signed in on a fresh profile,
    // so a separate profile would produce a signed-OUT instance. The app's own profile is the
    // only signed-in one, and is required for the Dot to be usable.
    const port = await deps.freePort()
    const managedTag = `${process.pid}:${randomUUID()}`
    const child = deps.spawn(executable, [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", `--magpie-dots-managed=${managedTag}`], { stdio: "ignore", windowsHide: false })
    const spawnErrors = new Set()
    child.once?.("error", error => spawnErrors.add(error))
    owned = { exitCode: null, kill: () => {
      // Identity is pinned to the child this instance spawned, as adopt() does: the pid comes
      // from the spawn return, the creation stamp is read back for that pid, and the same pid +
      // tag + executable + stamp must still be listed on a fresh read before stopManaged runs.
      void deps.processes().then(rows => {
        const stamp = rows.find(current => current.pid === child.pid && current.managedTag === managedTag && current.executable?.toLowerCase() === executable.toLowerCase() && current.created)
        if (!stamp) return
        return deps.processes().then(latest => {
          const row = latest.find(current => current.pid === stamp.pid && current.created === stamp.created && current.executable === stamp.executable && current.managedTag === stamp.managedTag)
          if (row) return deps.stopManaged(row)
        })
      }).catch(() => {})
    } }
    const started = timers.now()
    while (timers.now() - started < (options.launchTimeoutMs ?? 10000)) {
      signal?.throwIfAborted()
      if (await version(port, signal)) return { port, client: await attach(port, signal) }
      if (spawnErrors.size) throw launchFailed([...spawnErrors][0].message)
      if (child.exitCode != null) break
      await sleep(200, signal, timers)
    }
    if (child.exitCode != null) {
      // A single-instance app hands the second launch off to the existing instance and ignores
      // the debug flags, so an exit alongside a pre-existing instance means the user's ChatGPT
      // is running normally without a port; never escalate to killing it.
      if (previous.length) throw failure("running")
      throw failure("launch")
    }
    // Same handoff discrimination as the exit branch above: at the bound, a pre-existing
    // instance is the likeliest cause of a slow handoff, so point the user at quitting
    // ChatGPT rather than at a security tool.
    if (previous.length) throw failure("running")
    throw failure("debug")
  }
  async function start(signal) {
    const executable = await findChatGptApp(deps)
    const previous = await runningProcesses()
    const attached = await reattach(previous, signal)
    if (attached) {
      await adopt(previous, attached.port, executable)
      return attached.client
    }
    return (await launch(executable, previous, signal)).client
  }
  async function ensure(signal) {
    touch()
    if (connection?.open) return connection
    if (!connecting) connecting = start(signal).then(value => connection = value).catch(error => { signal?.throwIfAborted(); if (error.status) throw error; throw failure("debug") }).finally(() => { connecting = undefined; idle() })
    return connecting
  }
  async function checkDrivable() {
    await findChatGptApp(deps)
    if (connection?.open) return
    await ensure()
  }
  async function openSurface(client, signal) {
    const state = await client.evaluate(surfaceProbe, signal)
    if (state?.composer) return
    if (!state || !String(state.href ?? "").startsWith(DOTS_ROUTE)) await client.evaluate(`location.assign(${JSON.stringify(DOTS_ROUTE)})`, signal)
    const started = timers.now()
    while (timers.now() - started < (options.surfaceTimeoutMs ?? 15000)) {
      signal?.throwIfAborted()
      if (await client.evaluate(composerProbe, signal)) return
      await sleep(200, signal, timers)
    }
    throw failure("changed")
  }
  async function readTurn(run, signal) {
    let client = connection
    let rows
    try {
      if (!client?.open) throw failure("crashed")
      rows = await client.evaluate(transcriptRead, signal)
    } catch (error) {
      if (signal?.aborted || error.status === 401) throw error
      connection?.close(); connection = undefined
      try { client = await ensure(signal); rows = await client.evaluate(transcriptRead, signal) }
      catch { throw failure("crashed") }
    }
    const list = Array.isArray(rows) ? rows : []
    const fresh = list.filter(row => row.id && !run.baseline.has(row.id))
    if (fresh.length) run.sawTurn = true
    if (run.sawTurn && !fresh.length) { release(run); return { state: "failed", progress: DOTS_APP_ERRORS.reset } }
    const reply = [...fresh].reverse().find(row => !row.self)
    const text = reply ? String(reply.text ?? "") : ""
    if (reply && text.trim() && text === run.lastText && timers.now() - run.lastTextAt >= (options.stableMs ?? 3000)) {
      release(run)
      return { state: "succeeded", text }
    }
    if (reply && text !== run.lastText) { run.lastText = text; run.lastTextAt = timers.now() }
    const elapsed = Math.floor((timers.now() - run.createdAt) / 1000)
    return { state: "running", progress: reply ? `the Dot is writing (${elapsed} s)` : `waiting for the Dot (${elapsed} s)`, ...(text.trim() ? { partial: text } : {}) }
  }
  async function create(credential, request, signal) {
    const client = await ensure(signal)
    let run
    try {
      if (!(await client.evaluate(shellProbe, signal))) throw failure("signedOut")
      await openSurface(client, signal)
      if (active.size) throw chatError(409, "The Dot already has an active turn — wait for its answer before sending another")
      const turnIndex = request.identity?.turnIndex ?? request.turnIndex ?? 0
      const sessionKey = request.identity?.sessionKey ?? request.sessionKey ?? ""
      const turnId = createHash("sha256").update(JSON.stringify(["dot", sessionKey, turnIndex, request.prompt])).digest("hex").slice(0, 24)
      run = { ref: `dot-app-${turnId}`, view: "ChatGPT Dot (app-drive)", turnIndex, sessionKey, prompt: request.prompt, baseline: new Set(), lastText: null, lastTextAt: 0, sawTurn: false, createdAt: timers.now(), signal }
      run.onAbort = () => { release(run); idle() }
      active.set("dot", run)
    } catch (error) { if (run) release(run); else idle(); throw error }
    finally { idle() }
    signal?.addEventListener("abort", run.onAbort, { once: true })
    try {
      signal?.throwIfAborted()
      const rows = await client.evaluate(transcriptRead, signal)
      run.baseline = new Set((Array.isArray(rows) ? rows : []).map(row => row.id).filter(Boolean))
      if (!(await client.evaluate(focusProbe, signal))) throw failure("changed")
      for (const event of CLEAR_KEYS) await client.call("Input.dispatchKeyEvent", event, signal)
      await client.call("Input.insertText", { text: run.prompt }, signal)
      if (!(await client.evaluate(sendProbe, signal))) throw failure("changed")
    } catch (error) { release(run); throw error }
    finally { idle() }
    return run
  }
  async function poll(credential, run, signal) {
    touch()
    try { return await readTurn(run, signal) }
    catch (error) { release(run); throw error }
    finally { idle() }
  }
  async function stream(credential, run, onEvent, signal) {
    let lastProgress = ""
    try {
      while (true) {
        signal?.throwIfAborted()
        const outcome = await readTurn(run, signal)
        if (outcome.state !== "running") return outcome
        if (outcome.progress && outcome.progress !== lastProgress) { lastProgress = outcome.progress; onEvent(lastProgress) }
        if (outcome.partial) onEvent({ content: outcome.partial })
        await sleep(options.streamIntervalMs ?? 250, signal, timers)
      }
    } catch (error) { release(run); throw error }
    finally { idle() }
  }
  return {
    id: "dots", name: "ChatGPT Dot (app-drive)",
    async authorize() {
      return { url: "", method: "auto", instructions: `Magpie finds the installed ChatGPT desktop app and, when no loopback debug endpoint is reachable, launches it itself with its normal signed-in profile and a loopback-only debug port, then attaches; an app already started with a debug port is used as-is. If ChatGPT is already running without a debug port, quit it first so Magpie's launch can take effect. No MCP connector, bearer token, developer mode or tunnel is needed. A hidden renderer works; the process must remain alive. Completion is inferred after ${options.stableMs ?? 3000} ms of unchanged reply text; a longer pause mid-answer can truncate the result. Configure dotsApp.stableMs to increase that interval.`, callback: async () => {
        try { await checkDrivable(); return { type: "success", refresh: "dots-app-cdp", access: "app-local", expires: 0, accountId: "dots-app", mechanism: "app-drive" } }
        catch (error) { return { type: "failed", error: error.message } }
      } }
    },
    async liveModels(credential, signal) {
      try {
        const client = await ensure(signal)
        if (!(await client.evaluate(shellProbe, signal))) throw failure("signedOut")
        return { dot: { name: "ChatGPT Dot", tool_call: false } }
      } catch (error) { if (error.status === 401) throw error; return {} }
      finally { idle() }
    },
    create, poll, stream,
    cancel(credential, run) { if (active.get("dot") === run) release(run); idle() },
    followUp(credential, run, texts, signal) { return create(credential, { prompt: texts.join("\n"), turnIndex: run.turnIndex + 1, sessionKey: run.sessionKey }, signal) },
    dispose() { touch(); connection?.close(); connection = undefined; if (owned) { if (owned.exitCode == null) owned.kill(); owned = undefined } },
    checkDrivable,
  }
}
