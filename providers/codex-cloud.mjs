import { spawn } from "node:child_process"
import { emulate } from "../lib/emulate.mjs"
import { chatError, errorResponse } from "../lib/errors.mjs"
import { sessionOf, SESSION_HEADER } from "../lib/sessions.mjs"

const ID = "codex-cloud"
const NAME = "Codex Cloud (codex CLI)"
const BASE = "https://codex-cloud.cloud-agents.invalid/v1"
const MODELS = { "cloud-task": { name: "Codex Cloud task", tool_call: false, reasoning: false } }
const STATUS_NOTES = "Status interpretation is experimental and tested only on constructed examples; real CLI wording is unverified. Product limit: third-person present continuations without a recognized grammatical marker, such as 'work continues on the parser', 'the worker proceeds to packaging', 'the agent keeps indexing the tree', and 'the migration is underway', can be mistaken for completion and return an unfinished diff. Verify task completion independently before using a returned diff. Conversely, completed summaries can remain attached and time out without a diff: subject gerunds ('testing is complete', 'indexing is finished', 'checking revealed no issues', 'monitoring is in place', 'testing passed', 'monitoring shows no errors'); predicate adjectives ('the file is missing', 'one test is failing', 'the results are promising', 'the report is outstanding', 'the remaining work is existing scope'); sequencing summaries ('now the tests pass', 'now everything is green', 'then the suite went green', 'meanwhile the cache was cleared', 'subsequently reviewed and merged'); modal summaries ('the tests will pass on retry', 'the API can be extended later'); and intent summaries ('nothing left to be verified', 'the fix is ready to be merged'). Bare Error diagnostics also remain running. An identical resend reuses the task; delivery can resume if the status later becomes unambiguous, but unchanged wording can keep timing out indefinitely."
const LOGGED_OUT = "the codex CLI isn't signed in — run `codex login` (or `codex login --device-auth` on a headless box), then sign in again"
const MISSING = "the codex CLI wasn't found on PATH — install the `codex` CLI from OpenAI first"
const marker = auth => auth?.type === "oauth" && auth.access === "codex-cli" && auth.refresh === "codex-cli"
const outputOf = result => [result.stdout, result.stderr].filter(Boolean).join("\n")
const loggedOut = text => /\b(not logged in|logged out)\b/i.test(text)
const trimBytes = (text, maximum) => {
  const bytes = Buffer.from(text)
  let end = Math.min(bytes.length, maximum)
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
  return bytes.toString("utf8", 0, end)
}

function spawnCodex(args, { signal, timeoutMs = 30000, env = process.env, children } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return }
    let child, timer, stopped, settled = false
    let stdout = "", stderr = ""
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", aborted)
      children?.delete(child)
      if (error) reject(error)
      else resolve(result)
    }
    const stop = error => { stopped = error; child?.kill() }
    const aborted = () => stop(signal.reason)
    try { child = spawn("codex", args, { env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }) }
    catch (error) { finish(error.code === "ENOENT" ? chatError(401, MISSING, "kept") : error); return }
    children?.add(child)
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", data => { stdout += data })
    child.stderr.on("data", data => { stderr += data })
    child.once("error", error => finish(error.code === "ENOENT" ? chatError(401, MISSING, "kept") : error))
    child.once("close", code => finish(stopped, { code, stdout, stderr }))
    signal?.addEventListener("abort", aborted, { once: true })
    timer = setTimeout(() => stop(Object.assign(chatError(502, "the codex CLI timed out"), { code: "CODEX_CLI_TIMEOUT" })), timeoutMs)
    if (signal?.aborted) aborted()
  })
}

function taskOf(text) {
  const match = /https:\/\/[^\s/]+\/\S*?\btasks?\/[\w-]+|\btask[_-](?=[a-z0-9-]*\d)[a-z0-9-]{6,}\b/i.exec(text)
  if (!match) return null
  return match[0].startsWith("https://") ? { ref: new URL(match[0]).pathname.split("/").pop(), url: match[0] } : { ref: match[0] }
}
const continuationWords = "running|starting|continuing|retrying|reconnecting|resuming|attempting|trying|waiting|verifying|working|queuing|in progress|pending|queued"
const leadingContinuation = new RegExp("^\\s*(?:(?:still|now|again|then|also|already|currently|just|back|and|but|so)\\s+)*(?:" + continuationWords + ")\\b", "i")
function continues(rest) {
  return rest.split(/[,;—]|\.\s/).some((clause, index) => {
    if (index > 0) {
      const opening = /^\s*(?:(?:now|still|then|again|also|already|currently|just|and|but|so|[a-z]+ly)\s+)*([a-z]{2,}ing)\b/i.exec(clause)
      if (opening && !/^(?:no|some|any|every)thing$/i.test(opening[1])) return true
      if (/\b(?:am|is|are|was|were|been|be)\s+(?:(?:still|now|[a-z]+ly)\s+)*[a-z]{2,}ing\b/i.test(clause)) return true
      if (/\b(?:will|would|shall|should|can|could|may|might|must)\s+(?:not\s+)?[a-z]+\b/i.test(clause)) return true
      if (/^\s*(?:(?:and|but)\s+)?(?:now|then|meanwhile|subsequently|next|afterwards|after\s+that)\b/i.test(clause)) return true
      if (/^\s*(?:about\s+|going\s+)?to\s+[a-z]+\b|\bto\s+be\s+[a-z]+\b/i.test(clause)) return true
      if (leadingContinuation.test(clause)) return true
    }
    for (const match of clause.matchAll(new RegExp("\\b(?:" + continuationWords + ")\\b", "gi"))) {
      const after = clause.slice(match.index + match[0].length)
      if (!after.trim() || /^\s*[.:]/.test(after)) return true
      if (/^\s+(?:the|a|an|my|its|his|her|their|our|your|this|that|these|those|to|for|with|and|or|now|still|again|it|them|us|me|back|up|down|on|in|at|from|out|by|into|over|through|toward|towards|about)\b/i.test(after)) return true
    }
    return false
  })
}
function stateOf(text, prompt = "") {
  const states = []
  const echoed = new Set(prompt.split(/\r?\n/).map(line => line.trim()).filter(Boolean))
  for (let line of text.split(/\r?\n/)) {
    for (const echo of echoed) line = line.split(echo).join(" ")
    line = line.trim()
    const positioned = /\[([^\]]+)\]\s*$/.exec(line)?.[1] ?? /^(?:status|state)\s*:\s*(.+)$/i.exec(line)?.[1] ?? /^task[_-][\w-]+\s+.+\s{2,}([a-z]+|in progress)$/i.exec(line)?.[1]
    const candidate = positioned ?? line.replace(/^task\s+/i, "")
    const match = /^(complet\w*|succeed\w*|done|finish\w*|fail\w*|error\w*|cancel\w*|expir\w*|running|working|queued|pending|in progress)\b(?=$|[.:,;\s—])/i.exec(candidate)
    if (!match) { if (positioned) states.push("running"); continue }
    const word = match[1]
    const rest = candidate.slice(match[0].length)
    if (!/^expir/i.test(word) && continues(rest)) { states.push("running"); continue }
    if (!positioned && /^error/i.test(word) && rest) { states.push("running"); continue }
    if (!positioned && !/^expir/i.test(word) && rest && !/^(?:\s*[.:,;—]|\s+(?:successfully\b|with\s+\d|by user\b))/.test(rest)) continue
    states.push(/^expir/i.test(word) ? "expired" : /^(fail|error|cancel)/i.test(word) ? "failed" : /^(complet|succeed|done|finish)/i.test(word) ? "succeeded" : "running")
  }
  return states.length && states.every(state => state === states[0]) ? states[0] : "running"
}
function checkExit(result) {
  const text = outputOf(result)
  if (loggedOut(text)) throw chatError(401, LOGGED_OUT, "expired")
  if (result.code !== 0) throw chatError(/\b(rate limit|rate limited|too many requests|429)\b/i.test(text) ? 429 : 502, text || "the codex CLI exited without output")
  return result
}

function makeDriver(options, cli) {
  return {
    id: ID, name: NAME, staticModels: MODELS,
    async create(credential, { prompt }, signal) {
      for (const value of [credential.metadata?.env, options.codexCloud?.env]) if (value != null && typeof value !== "string") throw chatError(400, "metadata.env and codexCloud.env must be strings")
      const env = credential.metadata?.env?.trim() || options.codexCloud?.env?.trim()
      if (!env) throw chatError(400, "Codex Cloud requires account metadata.env (the sign-in environment id) or option codexCloud.env")
      const attempts = options.codexCloud?.attempts ?? 1
      if (!Number.isInteger(attempts) || attempts < 1) throw chatError(400, "codexCloud.attempts must be a positive integer")
      const run = { children: new Set(), prompt }
      const created = checkExit(await cli(["cloud", "exec", "--env", env, "--attempts", String(attempts), "--", prompt], { signal, children: run.children }))
      let task = taskOf(created.stdout)
      if (!task) {
        run.inferred = true
        const listed = checkExit(await cli(["cloud", "list", "--env", env, "--limit", "1"], { signal, children: run.children }))
        task = taskOf(listed.stdout)
        if (!task) throw chatError(502, outputOf(created) + "\n" + outputOf(listed))
      }
      return Object.assign(run, task)
    },
    async poll(credential, run, signal) {
      const result = await cli(["cloud", "status", run.ref], { signal, children: run.children })
      const progress = outputOf(result)
      if (result.code !== 0 && /not found|no such task/i.test(progress)) return { state: "failed", progress }
      checkExit(result)
      const state = stateOf(result.stdout, run.prompt)
      if (state !== "succeeded") return { state, progress }
      let diff
      try { diff = checkExit(await cli(["cloud", "diff", run.ref], { signal, children: run.children, timeoutMs: 3000 })).stdout }
      catch (error) {
        if (!signal?.aborted && error.code === "CODEX_CLI_TIMEOUT") return { state: "running", progress: progress + "\nDiff retrieval timed out; waiting to retry the same task" }
        throw error
      }
      const text = (run.inferred ? "WARNING: Task reference inferred from the environment's newest task; ownership is unverified and this may be another session's work.\n\n" : "") + (Buffer.byteLength(progress) <= 2048 ? progress + "\n\n" : "") + trimBytes(diff, 102400) + (Buffer.byteLength(diff) > 102400 ? "\n[diff truncated at 100 KiB]" : "")
      return { state, text: text.trim(), progress }
    },
    async cancel(credential, run) { for (const child of run.children) child.kill() },
  }
}

export function makeCodexCloud(options = {}, { cli = spawnCodex, now = Date.now, timers } = {}) {
  const driver = makeDriver(options, cli)
  const verify = async (signal, children = new Set()) => {
    const result = await cli(["login", "status"], { signal, children, timeoutMs: 10000 })
    if (result.code !== 0 || !/logged in/i.test(result.stdout) || loggedOut(outputOf(result))) throw chatError(401, LOGGED_OUT, "expired")
  }
  return {
    auth: {
      provider: ID, maxConcurrency: 4,
      async loader(getAuth) {
        if (!marker(await getAuth())) return {}
        let checkedAt = -Infinity, checking
        const completion = emulate(driver, async () => {
          const auth = await getAuth()
          if (!marker(auth)) throw chatError(401, `${NAME} isn't signed in — magpie plugin login ${ID}`, "expired")
          return { ...auth, metadata: { ...auth.metadata, env: auth.metadata?.env || auth.env } }
        }, options, { timers })
        return {
          baseURL: BASE,
          async fetch(input, init = {}) {
            try {
              if (!marker(await getAuth())) throw chatError(401, `${NAME} isn't signed in — magpie plugin login ${ID}`, "expired")
              if (now() - checkedAt >= 60000) {
                const signal = init.signal ?? (input instanceof Request ? input.signal : undefined)
                checking ??= verify(signal).then(() => { checkedAt = now() }).finally(() => { checking = undefined })
                await checking
              }
              return await completion(input, init)
            } catch (error) { return errorResponse(error) }
          },
        }
      },
      methods: [{
        type: "oauth", label: "This machine's codex CLI login (ChatGPT)",
        prompts: [{ type: "text", key: "env", message: "Codex Cloud environment id (Codex web → Environments; used as `codex cloud exec --env`)", validate: value => typeof value === "string" && value.trim() ? undefined : "an environment id is required" }],
        authorize(inputs) {
          return {
            url: "", instructions: "Reuses the codex CLI's own login. Nothing is typed in; only the environment id is stored.\n\nProvider notes: " + STATUS_NOTES, method: "auto",
            async callback() {
              const env = inputs?.env?.trim()
              if (!env) return { type: "failed", error: "an environment id is required" }
              try { await verify() }
              catch (error) { return { type: "failed", error: error.message } }
              return { type: "success", refresh: "codex-cli", access: "codex-cli", expires: 0, accountId: "env:" + env, env }
            },
          }
        },
      }],
    },
    async config(config) {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      config.provider[ID] = { name: NAME, npm: "@ai-sdk/openai-compatible", api: BASE, ...was, models: { ...MODELS, ...(was.models ?? {}) } }
    },
    provider: { id: ID, async models(provider) { return provider.models } },
    async "chat.headers"(input, output) {
      if (input?.model?.providerID !== ID && input?.provider?.info?.id !== ID) return
      const session = sessionOf(input)
      if (session) output.headers[SESSION_HEADER] = session
    },
  }
}

export const _internal = { spawnCodex, taskOf, stateOf, makeDriver }
