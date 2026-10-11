import { createHash, randomUUID } from "node:crypto"
import { access } from "node:fs/promises"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { win32 } from "node:path"
import { createServer } from "node:net"
import { chatError } from "../lib/errors.mjs"
import { clock, fetchWithTimeout, sleep, withTimeout } from "../lib/http.mjs"

export const CDP_ERRORS = {
  missing: "Grok Bot desktop isn't installed — install it from xAI and sign in once, then retry",
  signedOut: "Grok Bot desktop isn't signed in — open it and sign in once; Magpie will drive it after that",
  running: "Grok Bot is already running and Magpie can't attach to it — close Grok Bot (or pick the direct-protocol sign-in) and retry",
  fallback: "Grok Bot updated and its automation bridge changed — falling back to UI input; if this repeats, the provider needs an update",
  changed: "Grok Bot changed its UI; the provider needs an update",
  crashed: "Grok Bot closed mid-answer — your prompt may still be answered in the app; ask again to re-attach",
  debug: "Grok Bot didn't open its debug interface — another security tool may be blocking it",
}
const failure = key => chatError(key === "signedOut" ? 401 : key === "running" ? 409 : 502, CDP_ERRORS[key])
const execute = promisify(execFile)

async function processes() {
  const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "@(Get-CimInstance Win32_Process -Filter \"Name='Grok Bot.exe'\" | Select-Object ProcessId,CommandLine,ExecutablePath,CreationDate) | ConvertTo-Json -Compress"], { windowsHide: true, timeout: 5000 })
  const rows = JSON.parse(stdout || "[]")
  return (Array.isArray(rows) ? rows : [rows]).map(row => ({ pid: row.ProcessId, executable: row.ExecutablePath, created: row.CreationDate, managedTag: row.CommandLine?.match(/--magpie-grok-managed=([0-9]+:[0-9a-f-]+)/)?.[1], port: Number(row.CommandLine?.match(/--remote-debugging-port[= ](\d+)/)?.[1]) || undefined }))
}
function parentAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== "ESRCH" }
}
async function stopManaged(row) {
  const script = `$expected = [Console]::In.ReadToEnd() | ConvertFrom-Json; $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($expected.pid)"; if ($process -and $process.ExecutablePath -eq $expected.executable -and $process.CreationDate -eq $expected.created -and $process.CommandLine.Contains("--magpie-grok-managed=$($expected.managedTag)")) { Invoke-CimMethod -InputObject $process -MethodName Terminate | Out-Null }`
  const child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 5000 })
  child.stdin.end(JSON.stringify(row))
  await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(failure("debug"))) })
}
async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

export async function findGrokBot({ env = process.env, exists = path => access(path).then(() => true, () => false) } = {}) {
  const roots = [env.ProgramFiles && win32.join(env.ProgramFiles, "Grok Bot"), env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, "Programs", "Grok Bot"), ...(env.PATH ?? env.Path ?? "").split(";").filter(Boolean)]
  for (const root of roots.filter(Boolean)) {
    const candidate = win32.join(root.replace(/^"|"$/g, ""), "Grok Bot.exe")
    if (await exists(candidate)) return candidate
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

const botList = value => {
  const list = Array.isArray(value) ? value : value?.agents ?? value?.agentIds ?? value?.pinnedAgents ?? []
  return Array.isArray(list) ? list.flatMap(row => {
    const id = typeof row === "string" ? row : row?.agentId ?? row?.agent_id ?? row?.id
    return typeof id === "string" && id ? [{ id, name: row?.name ?? row?.title ?? id, markSvgDataUrl: row?.markSvgDataUrl ?? "" }] : []
  }) : []
}
const entriesOf = value => {
  const entries = Array.isArray(value) ? value : value?.entries ?? value?.tail?.entries
  if (!Array.isArray(entries)) throw failure("changed")
  return entries.map(entry => {
    let body = entry.body ?? entry.payload ?? entry
    if (typeof body === "string") { try { body = JSON.parse(body) } catch { body = { text: body } } }
    return { id: String(entry.messageId ?? entry.message_id ?? entry.id ?? entry.seq ?? entry.sequence ?? ""), role: String(entry.role ?? body.role ?? entry.type ?? body.type ?? "").toLowerCase(), text: typeof body.content === "string" ? body.content : String(body.text ?? entry.text ?? "") }
  })
}
const probe = `(async () => {
  const status = await window.desktop?.cursorAccount?.getStatus?.();
  if (typeof status?.signedIn === "boolean") return status.signedIn;
  if (typeof status?.isSignedIn === "boolean") return status.isSignedIn;
  if (typeof status?.authenticated === "boolean") return status.authenticated;
  const text = document.body.innerText;
  if (/sign in|log in/i.test(text) && !/sign out|log out/i.test(text)) return false;
  try { const pinned = await window.desktop.agent.getPinnedAgents(); return Array.isArray(pinned) || Array.isArray(pinned?.agents) || Array.isArray(pinned?.agentIds); } catch { return false; }
})()`
const domTail = `(() => {
  const region = document.querySelector('[data-testid="transcript"], [role="log"], [class*="transcript" i]');
  if (!region) throw new Error("transcript region missing");
  return { entries: [...region.querySelectorAll('[data-message-role], [data-role], [data-testid="assistant-message"], [data-testid="user-message"]')].map(el => ({ id: el.dataset.messageId || el.id, role: el.dataset.messageRole || el.dataset.role || (el.dataset.testid === "assistant-message" ? "assistant" : "user"), text: el.innerText })) };
})()`

export function createGrokBotCdp(options = {}, dependencies = options.dependencies ?? {}) {
  const deps = { env: process.env, spawn, processes, parentAlive, stopManaged, freePort, fetch: globalThis.fetch, timers: clock, connect: connectCdp, ...dependencies }
  const timers = deps.timers
  let connection, connecting, owned, idleTimer
  const active = new Map()
  const launchErrors = new WeakSet()
  const touch = () => { timers.clearTimeout(idleTimer) }
  function release(run) {
    run.signal?.removeEventListener("abort", run.onAbort)
    if (active.get(run.bot.id) === run) active.delete(run.bot.id)
  }
  function idle() {
    touch()
    if (active.size) return
    idleTimer = timers.setTimeout(() => {
      connection?.close(); connection = undefined
      if (owned) { const child = owned; owned = undefined; if (child.exitCode == null && !launchErrors.has(child)) child.kill() }
    }, (options.keepAliveMinutes ?? 15) * 60000)
    idleTimer?.unref?.()
  }
  async function version(port, signal) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false
    try {
      const response = await fetchWithTimeout(`http://127.0.0.1:${port}/json/version`, { signal, redirect: "error" }, { fetch: deps.fetch, timeoutMs: 800 })
      return /GrokBot\//.test((await response.json())["User-Agent"] ?? "")
    } catch { signal?.throwIfAborted(); return false }
  }
  async function attach(port, signal) {
    const response = await fetchWithTimeout(`http://127.0.0.1:${port}/json/list`, { signal, redirect: "error" }, { fetch: deps.fetch, timeoutMs: 2000 })
    const list = await response.json()
    const page = Array.isArray(list) && list.find(target => target.type === "page" && /^file:\/\//.test(target.url ?? "") && /\/dist\/renderer\//.test(target.url ?? "") && /app\.asar/.test(target.url ?? ""))
    if (!page) throw failure("debug")
    const endpoint = new URL(page.webSocketDebuggerUrl)
    if (endpoint.hostname !== "127.0.0.1" || Number(endpoint.port) !== port) throw failure("debug")
    return deps.connect(endpoint.href, { timers, WebSocket: deps.WebSocket }, signal)
  }
  async function runningProcesses() {
    try { return await deps.processes() } catch { throw failure("debug") }
  }
  async function reattach(previous, signal) {
    for (const port of [...new Set([...(options.reattachPorts ?? []), ...previous.map(row => row.port)])]) {
      if (await version(port, signal)) return { port, client: await attach(port, signal) }
    }
  }
  async function checkDrivable() {
    await findGrokBot(deps)
    if (connection?.open) return
    const previous = await runningProcesses()
    const attached = await reattach(previous)
    if (attached) attached.client.close()
    else if (previous.length) throw failure("running")
  }
  async function start(signal) {
    const executable = await findGrokBot(deps)
    const previous = await runningProcesses()
    const attached = await reattach(previous, signal)
    if (attached) {
      const { port, client } = attached
      const row = previous.find(row => row.port === port && row.created && row.executable?.toLowerCase() === executable.toLowerCase() && /^[1-9]\d*:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.managedTag ?? ""))
      if (row && !deps.parentAlive(Number(row.managedTag.split(":")[0]))) owned = { exitCode: null, kill: () => {
        void deps.processes().then(rows => {
          if (rows.some(current => current.pid === row.pid && current.created === row.created && current.executable === row.executable && current.managedTag === row.managedTag) && !deps.parentAlive(Number(row.managedTag.split(":")[0]))) return deps.stopManaged(row)
        }).catch(() => {})
      } }
      return client
    }
    const port = await deps.freePort()
    const child = deps.spawn(executable, [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", `--magpie-grok-managed=${process.pid}:${randomUUID()}`], { stdio: "ignore", windowsHide: false })
    child.once?.("error", () => launchErrors.add(child))
    if (!previous.length) owned = child
    const started = timers.now()
    while (timers.now() - started < (options.launchTimeoutMs ?? 10000)) {
      signal?.throwIfAborted()
      if (await version(port, signal)) return attach(port, signal)
      if (launchErrors.has(child)) break
      await sleep(200, signal, timers)
    }
    if (previous.length && child.exitCode != null) throw failure("running")
    throw failure("debug")
  }
  async function ensure(signal) {
    touch()
    if (connection?.open) return connection
    if (!connecting) connecting = start(signal).then(value => connection = value).catch(error => { signal?.throwIfAborted(); if (error.status) throw error; throw failure("debug") }).finally(() => { connecting = undefined; idle() })
    return connecting
  }
  async function signedIn(client, signal) {
    try { if (!await client.evaluate(probe, signal)) throw failure("signedOut") }
    catch (error) { signal?.throwIfAborted(); if (error.bridge) throw failure("changed"); throw error }
  }
  async function bots(client, signal) {
    const value = await client.evaluate(`(async () => { const agent = window.desktop.agent; const rows = await Promise.allSettled([agent.getPinnedAgents(), agent.listGrokBotTeamAgents?.({})]); return rows.map(row => row.status === "fulfilled" ? row.value : null); })()`, signal)
    return [...new Map((Array.isArray(value) ? value : [value]).flatMap(botList).map(bot => [bot.id, bot])).values()]
  }
  async function tail(client, agentId, signal) {
    try { return entriesOf(await client.evaluate(`window.desktop.agent.readTranscriptStoreTail(${JSON.stringify({ agentId, limit: 50, reason: "server-tail" })})`, signal)) }
    catch (error) {
      if (!error.bridge) throw error
      if (!/invalid-args/.test(error.message)) throw failure("changed")
      try { return entriesOf(await client.evaluate(domTail, signal)) }
      catch (fallback) { if (!client.open) throw failure("crashed"); throw failure("changed") }
    }
  }
  async function send(client, bot, prompt, signal) {
    try {
      await client.evaluate(`window.desktopMount.mount(${JSON.stringify({ agentId: bot.id, name: bot.name, markSvgDataUrl: bot.markSvgDataUrl ?? "" })})`, signal)
    } catch (error) {
      if (!error.bridge) throw error
      return uiSend(client, bot, prompt, signal)
    }
    try { await client.evaluate(`window.desktopMount.submitPrompt(${JSON.stringify({ prompt })})`, signal) }
    catch (error) {
      // A lost response may have submitted already; only contract failures can safely retry input.
      if (!error.bridge) throw error
      if (!/invalid-args|not a function|not mounted|undefined/.test(error.message)) throw failure("changed")
      return uiSend(client, bot, prompt, signal)
    }
    return ""
  }
  async function uiSend(client, bot, prompt, signal) {
    try {
      await client.evaluate(`window.desktopMount.switchTo(${JSON.stringify({ agentId: bot.id })})`, signal)
      const ready = await client.evaluate(`(() => { const composer = document.querySelector('textarea, [contenteditable="true"][role="textbox"]'); if (!composer) return false; composer.focus(); return true; })()`, signal)
      if (!ready) throw failure("changed")
      await client.call("Input.insertText", { text: prompt }, signal)
      await client.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, signal)
      await client.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, signal)
      return CDP_ERRORS.fallback
    } catch { signal?.throwIfAborted(); if (!client.open) throw failure("crashed"); throw failure("changed") }
  }
  async function create(credential, request, signal) {
    const client = await ensure(signal)
    let run
    try {
      await signedIn(client, signal)
      let bot
      if (request.model && request.model !== "app-bot") bot = { id: request.model, name: request.model }
      else {
        const selected = await client.evaluate(`(async () => { const mounted = await window.desktopMount?.read?.(); return mounted?.agentId ?? mounted?.mounted?.agentId ?? document.querySelector('[data-agent-id][aria-selected="true"]')?.dataset.agentId ?? null; })()`, signal)
        if (!selected) throw chatError(400, "Grok Bot has no selected bot — select a bot in the app or pick a named bot model")
        bot = { id: selected, name: selected }
      }
      if (active.has(bot.id)) throw chatError(409, "Grok Bot already has an active turn for this bot — wait for its answer before sending another")
      const turnIndex = request.identity?.turnIndex ?? request.turnIndex ?? 0
      const sessionKey = request.identity?.sessionKey ?? request.sessionKey ?? ""
      const messageId = createHash("sha256").update(JSON.stringify([bot.id, sessionKey, turnIndex, request.prompt])).digest("hex").slice(0, 24)
      run = { ref: bot.id, view: bot.name, bot, messageId, turnIndex, sessionKey, prompt: `${request.prompt}\n\n[Magpie turn: ${messageId}]`, baseline: [], lastTail: null, signal }
      run.onAbort = () => { release(run); idle() }
      active.set(bot.id, run)
    } catch (error) { if (error.bridge) throw failure("changed"); throw error }
    finally { idle() }
    signal?.addEventListener("abort", run.onAbort, { once: true })
    try { signal?.throwIfAborted(); run.baseline = await tail(client, run.bot.id, signal); if (!run.baseline.some(entry => entry.role === "user" && entry.text.includes(`[Magpie turn: ${run.messageId}]`))) run.progress = await send(client, run.bot, run.prompt, signal) }
    catch (error) { release(run); throw error }
    finally { idle() }
    return run
  }
  async function poll(credential, run, signal) {
    touch()
    let client = connection
    try {
      let entries
      try {
        if (!client?.open) throw failure("crashed")
        await signedIn(client, signal)
        entries = await tail(client, run.bot.id, signal)
      } catch (error) {
        if (error.status === 401 || error.bridge || error.message === CDP_ERRORS.changed || signal?.aborted) throw error
        connection?.close(); connection = undefined
        try { client = await ensure(signal); await signedIn(client, signal); entries = await tail(client, run.bot.id, signal) }
        catch (recovery) { if (recovery.status === 401 || recovery.message === CDP_ERRORS.changed || signal?.aborted) throw recovery; throw failure("crashed") }
      }
      const signature = JSON.stringify(entries)
      const stable = signature === run.lastTail
      run.lastTail = signature
      const matches = entries.flatMap((entry, index) => entry.role === "user" && entry.text.includes(`[Magpie turn: ${run.messageId}]`) ? [index] : [])
      const userIndex = matches.length === 1 ? matches[0] : -1
      const nextUser = entries.findIndex((entry, index) => index > userIndex && entry.role === "user")
      const replies = userIndex < 0 ? [] : entries.slice(userIndex + 1, nextUser < 0 ? undefined : nextUser)
      const last = replies.findLast(entry => ["assistant", "error", "refusal"].includes(entry.role))
      let running = false
      try {
        const value = await client.evaluate(`window.desktop.agent.listGrokBotAgentStatuses(${JSON.stringify({ agentIds: [run.bot.id] })})`, signal)
        const rows = value?.statuses
        const row = Array.isArray(rows) && rows.find(row => row?.agentId === run.bot.id)
        running = row?.status === "running"
      } catch { signal?.throwIfAborted() }
      if (last && stable && !running) {
        release(run)
        return { state: ["error", "refusal"].includes(last.role) ? "failed" : "succeeded", text: last.text }
      }
      return { state: "running", progress: run.progress || `waiting for ${run.bot.name}` }
    } catch (error) { release(run); throw error }
    finally { idle() }
  }
  return {
    id: "grok-bot", name: "Grok Bot",
    async authorize() {
      return { url: "", method: "auto", instructions: "Keep Grok Bot signed in; Magpie will open and drive it when you chat. Sending a turn brings the app window to the front. No credential leaves the app. A unique Magpie turn identifier is appended to each submitted prompt for reply correlation. If the app status bridge is unavailable or unreadable, a paused answer may be delivered as final after two unchanged transcript reads.", callback: async () => {
        try { await checkDrivable(); return { type: "success", refresh: "grok-bot-cdp", access: "app-local", expires: 0, accountId: "grok-bot-cdp", mechanism: "cdp" } }
        catch (error) { return { type: "failed", error: error.message } }
      } }
    },
    async liveModels(credential, signal) {
      try { const client = await ensure(signal); await signedIn(client, signal); return Object.fromEntries((await bots(client, signal)).map(bot => [bot.id, { name: bot.name, tool_call: false }])) }
      catch (error) { if (error.status === 401) throw error; return {} }
      finally { idle() }
    },
    create, poll,
    cancel(credential, run) { if (active.get(run.bot.id) === run) release(run); idle() },
    followUp(credential, run, texts, signal) { return create(credential, { model: run.bot.id, prompt: texts.join("\n"), turnIndex: run.turnIndex + 1, sessionKey: run.sessionKey }, signal) },
    dispose() { touch(); connection?.close(); connection = undefined; if (owned) { if (owned.exitCode == null && !launchErrors.has(owned)) owned.kill(); owned = undefined } },
  }
}
