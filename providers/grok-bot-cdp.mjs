import { createHash } from "node:crypto"
import { access } from "node:fs/promises"
import { win32 } from "node:path"
import { tmpdir } from "node:os"
import { chatError } from "../lib/errors.mjs"
import { createCdpApp, connectCdp as connectAppCdp } from "../lib/cdp-app.mjs"

export const CDP_ERRORS = {
  missing: "Grok Bot desktop isn't installed — install it from xAI and sign in once, then retry",
  signedOut: "Grok Bot isn't signed in in the connected window. Sign in in the Grok Bot window opened by Magpie (or the existing debug-enabled window), then retry. Magpie's separate profile does not inherit your usual app's sign-in; your usual app can stay open.",
  running: "Magpie couldn't start its own Grok Bot instance — the launch exited before its debug interface opened; retry the sign-in",
  fallback: "Grok Bot updated and its automation bridge changed — falling back to UI input; if this repeats, the provider needs an update",
  changed: "Grok Bot changed its UI; the provider needs an update",
  crashed: "Grok Bot closed mid-answer — your prompt may still be answered in the app; ask again to re-attach",
  debug: "Grok Bot didn't open its debug interface — another security tool may be blocking it",
}
const failure = key => chatError(key === "signedOut" ? 401 : key === "running" ? 409 : 502, CDP_ERRORS[key])
export async function findGrokBot({ env = process.env, exists = path => access(path).then(() => true, () => false) } = {}) {
  const roots = [env.ProgramFiles && win32.join(env.ProgramFiles, "Grok Bot"), env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, "Programs", "Grok Bot"), ...(env.PATH ?? env.Path ?? "").split(";").filter(Boolean)]
  for (const root of roots.filter(Boolean)) {
    const candidate = win32.join(root.replace(/^"|"$/g, ""), "Grok Bot.exe")
    if (await exists(candidate)) return candidate
  }
  throw failure("missing")
}

export const connectCdp = (url, options, signal) => connectAppCdp(url, { ...options, failure }, signal)

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
  const active = new Map()
  const app = createCdpApp({
    failure, find: findGrokBot, processName: "Grok Bot.exe", flag: "magpie-grok-managed",
    version: value => /GrokBot\//.test(value["User-Agent"] ?? ""),
    pages: list => list.filter(target => target.type === "page" && /^file:\/\//.test(target.url ?? "") && /\/dist\/renderer\//.test(target.url ?? "") && /app\.asar/.test(target.url ?? "")),
    args: deps => ["--user-data-dir=" + win32.join(deps.env.LOCALAPPDATA || tmpdir(), "Magpie", "grok-bot-managed-profile")],
    launchError: ({ child, previous }) => failure(previous.length && child.exitCode != null ? "running" : "debug"),
  }, options, dependencies, active)
  const { touch, idle, ensure, checkDrivable } = app
  function release(run) {
    run.signal?.removeEventListener("abort", run.onAbort)
    if (active.get(run.bot.id) === run) active.delete(run.bot.id)
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
    let client = app.connection
    try {
      let entries
      try {
        if (!client?.open) throw failure("crashed")
        await signedIn(client, signal)
        entries = await tail(client, run.bot.id, signal)
      } catch (error) {
        if (error.status === 401 || error.bridge || error.message === CDP_ERRORS.changed || signal?.aborted) throw error
        app.disconnect()
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
      return { url: "", method: "auto", instructions: "Magpie attaches to an available debug-enabled Grok Bot window, or opens its own window with a separate profile when you chat. That profile does not inherit your usual app's sign-in: sign in once in the window Magpie opens, then retry your request. Your usual app can stay open. This setup checks drivability, not account sign-in. Sending a turn brings the app window to the front. No credential leaves the app. A unique Magpie turn identifier is appended to each submitted prompt for reply correlation. If the app status bridge is unavailable or unreadable, a paused answer may be delivered as final after two unchanged transcript reads.", callback: async () => {
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
    dispose: app.dispose,
  }
}
