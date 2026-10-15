import { createHash } from "node:crypto"
import { access } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { win32 } from "node:path"
import { chatError } from "../lib/errors.mjs"
import { sleep } from "../lib/http.mjs"
import { createCdpApp, connectCdp as connectAppCdp } from "../lib/cdp-app.mjs"

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

export const connectCdp = (url, options, signal) => connectAppCdp(url, { ...options, failure }, signal)

// Hidden Dot renderers support CDP input without bringing the window to the foreground.
export const shellProbe = `(() => !!document.querySelector('[data-app-shell-header-slot], .messages-scroll, div.ProseMirror[contenteditable="true"]'))()`
const surfaceProbe = `(() => ({ href: location.href, composer: !!document.querySelector('div.ProseMirror[contenteditable="true"]') }))()`
const composerProbe = `(() => !!document.querySelector('div.ProseMirror[contenteditable="true"]'))()`
const focusProbe = `(() => { const composer = document.querySelector('div.ProseMirror[contenteditable="true"]'); if (!composer) return false; composer.focus(); return true; })()`
const transcriptRead = `(() => [...document.querySelectorAll('.messages-scroll article.message-row')].map(row => ({ id: row.dataset.messageId || "", self: /(^|\\s)self/.test(row.className || ""), text: ((row.querySelector('.message-text, .message-body') || row).innerText || "") })))()`
export const SEND_BUTTON_MATCH = `((candidate, box) => {
  const area = candidate.getBoundingClientRect();
  return candidate.matches("button.bg-composer-primary") && !candidate.disabled && candidate.getAttribute("aria-disabled") !== "true" && area.width > 0 && area.height > 0 && area.left > box.left && Math.abs((area.top + area.height / 2) - (box.top + box.height / 2)) < 80;
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
  const active = new Map()
  const app = createCdpApp({
    failure, find: findChatGptApp, processName: "ChatGPT.exe", flag: "magpie-dots-managed",
    version: value => Boolean(value.Browser),
    pages: list => list.filter(target => target.type === "page" && /^app:\/\/-/.test(target.url ?? "") && target.webSocketDebuggerUrl).sort((a, b) => Number(b.url.startsWith(SHELL_PAGE)) - Number(a.url.startsWith(SHELL_PAGE))),
    probe: shellProbe, boot: true, authorizeLaunch: true,
    launchError: ({ spawnError, child, previous }) => spawnError ? launchFailed(spawnError.message) : failure(previous.length ? "running" : child.exitCode != null ? "launch" : "debug"),
  }, options, dependencies, active)
  const { touch, idle, ensure, checkDrivable } = app
  const timers = app.deps.timers
  function release(run) {
    run.signal?.removeEventListener("abort", run.onAbort)
    if (active.get("dot") === run) active.delete("dot")
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
    let client = app.connection
    let rows
    try {
      if (!client?.open) throw failure("crashed")
      rows = await client.evaluate(transcriptRead, signal)
    } catch (error) {
      if (signal?.aborted || error.status === 401) throw error
      app.disconnect()
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
    dispose: app.dispose,
    checkDrivable,
  }
}
