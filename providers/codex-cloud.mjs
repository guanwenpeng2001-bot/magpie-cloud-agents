import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { emulate } from "../lib/emulate.mjs"
import { chatError, errorResponse } from "../lib/errors.mjs"
import { sessionOf, SESSION_HEADER } from "../lib/sessions.mjs"

const ID = "codex-cloud"
const NAME = "Codex Cloud (codex CLI)"
const BASE = "https://codex-cloud.cloud-agents.invalid/v1"
const MODELS = { "cloud-task": { name: "Codex Cloud task", tool_call: false, reasoning: false } }
const STATUS_NOTES = "Status interpretation is experimental and tested only on constructed examples; real CLI wording is unverified. Product limit: despite recognizing grammatical patterns across arbitrary action verbs, continuations with no marker or with a marker outside the recognized set, including 'work continues on the parser', 'the worker proceeds to packaging', 'the agent keeps indexing the tree', and 'the migration is underway', can be mistaken for completion and return an unfinished diff. Verify task completion independently before using a returned diff. Conversely, completed summaries can remain attached and time out without a diff: subject gerunds ('testing is complete', 'indexing is finished', 'checking revealed no issues', 'monitoring is in place', 'testing passed', 'monitoring shows no errors'); predicate adjectives ('the file is missing', 'one test is failing', 'the results are promising', 'the report is outstanding', 'the remaining work is existing scope'); sequencing summaries ('now the tests pass', 'now everything is green', 'then the suite went green', 'meanwhile the cache was cleared', 'subsequently reviewed and merged'); modal summaries ('the tests will pass on retry', 'the API can be extended later'); and intent summaries ('nothing left to be verified', 'the fix is ready to be merged'). Bare Error diagnostics also remain running. An identical resend reuses the task; delivery can resume if the status later becomes unambiguous, but unchanged wording can keep timing out indefinitely."
const LOGGED_OUT = "the codex CLI isn't signed in — run `codex login` (or `codex login --device-auth` on a headless box), then sign in again"
const MISSING = "the codex CLI wasn't found on PATH — install the `codex` CLI from OpenAI first"
// The CLI's own refusal for a workspace with no Codex Cloud environment, measured live (2026-10-12):
// `codex cloud list --env <any-id>` exits 1 with exactly this sentence, and a bogus id produces the
// identical message, so it is the workspace's answer, not a complaint about the id. It is the only
// configuration refusal measured; other configuration refusals may exist and stay unclassified.
const NO_CLOUD_ENVIRONMENT = /\bno cloud environments are available for this workspace\b/i
const noCloudEnvironmentMessage = refusal => `the codex CLI refused this workspace: ${refusal.trim()} — your account has no Codex Cloud environment. Create one in your OpenAI Codex Cloud settings, or point the plugin at an existing environment with account metadata.env or option codexCloud.env`
// The CLI's refusal for an environment id that does not exist on this account, measured live
// (2026-10-14): `codex cloud exec --env <unknown-id>` exits 1 with exactly this sentence once at
// least one environment exists. Unlike the no-environment refusal it names a stale id, not an
// empty workspace, but it is the same class of account configuration the client must fix. The
// anchor to the CLI's own refusal line is load-bearing: failed task summaries and diff bodies can
// legitimately contain the phrase "environment 'x' not found", and matching those would misreport
// a task failure as an account-configuration 400.
const STALE_ENVIRONMENT = /^\s*error: environment '[^']+' not found\b/im
const staleEnvironmentMessage = refusal => `the codex CLI rejected this environment: ${refusal.trim()} — the saved or discovered environment id is not valid for this account. Re-login to the codex CLI, or set a valid id via account metadata.env or option codexCloud.env`
const marker = auth => auth?.type === "oauth" && auth.access === "codex-cli" && auth.refresh === "codex-cli"
const outputOf = result => [result.stdout, result.stderr].filter(Boolean).join("\n")
const loggedOut = text => /\b(not logged in|logged out)\b/i.test(text)
const trimBytes = (text, maximum) => {
  const bytes = Buffer.from(text)
  let end = Math.min(bytes.length, maximum)
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
  return bytes.toString("utf8", 0, end)
}

function spawnCodex(args, { signal, timeoutMs = 30000, env = process.env, children, cwd = tmpdir() } = {}) {
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
    // The CLI infers the cloud task's git branch from its own cwd; a git checkout here would
    // override the vendor's repo default branch, so children run in a neutral non-git directory.
    try { child = spawn("codex", args, { env, cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }) }
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
// A leading bracket token is the real CLI's authoritative status rendering (measured live,
// 2026-10-14: `[PENDING] Pong`, `[READY] Pong`, `[ERROR] Pong`, each followed by metadata lines);
// it decides the line's state outright, and an unrecognized token stays nonterminal.
const bracketStates = { ready: "succeeded", done: "succeeded", completed: "succeeded", succeeded: "succeeded", finished: "succeeded", error: "failed", failed: "failed", cancelled: "failed", canceled: "failed", expired: "expired", pending: "running", queued: "running", running: "running", working: "running", starting: "running", "in progress": "running" }
function stateOf(text, prompt = "") {
  const states = []
  const echoed = new Set(prompt.split(/\r?\n/).map(line => line.trim()).filter(Boolean))
  for (let line of text.split(/\r?\n/)) {
    for (const echo of echoed) line = line.split(echo).join(" ")
    line = line.trim()
    const bracketed = /^\[([A-Za-z][A-Za-z ]*)\]/.exec(line)
    if (bracketed) {
      const token = bracketed[1].trim().toLowerCase()
      // Object.hasOwn keeps tokens like [CONSTRUCTOR] from resolving through Object.prototype.
      states.push(Object.hasOwn(bracketStates, token) ? bracketStates[token] : "running")
      continue
    }
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
  if (result.code !== 0) {
    // A workspace without a Codex Cloud environment is account configuration the user must change,
    // so it is a 400 client error (normalizeError passes 4xx through to the client), never a
    // retryable 502. The refusal kind is carried on the error because the wrapped message no longer
    // keeps the refusal line at a line start, which the anchored STALE_ENVIRONMENT requires.
    if (NO_CLOUD_ENVIRONMENT.test(text)) throw Object.assign(chatError(400, noCloudEnvironmentMessage(text)), { refusal: "no-cloud-environment" })
    if (STALE_ENVIRONMENT.test(text)) throw Object.assign(chatError(400, staleEnvironmentMessage(text)), { refusal: "stale-environment" })
    throw chatError(/\b(rate limit|rate limited|too many requests|429)\b/i.test(text) ? 429 : 502, text || "the codex CLI exited without output")
  }
  return result
}

function codexStatePaths() {
  return [...new Set([process.env.CODEX_HOME, join(homedir(), ".codex")].filter(Boolean).map(home => resolve(home, ".codex-global-state.json")))]
}
function canonicalEnvironment(id) {
  if (!id.startsWith("ccarenv_b64_")) return id
  const decoded = Buffer.from(id.slice("ccarenv_b64_".length), "base64url").toString("utf8")
  if (/^ccarenv_[A-Za-z0-9_-]+$/.test(decoded)) return decoded
  return /^[0-9a-f]{32}$/i.test(decoded) ? decoded : id
}
function discoverEnvironment(paths) {
  const searched = []
  for (const path of paths) {
    let state
    try { state = JSON.parse(readFileSync(path, "utf8")) }
    catch (error) { searched.push(`${path} (${error.code ?? "invalid JSON"})`); continue }
    const threads = state?.["electron-persisted-atom-state"]?.["cloud-aeon-sidebar-cache-v1"]?.threads
    if (Array.isArray(threads)) for (const thread of threads) {
      if (!Array.isArray(thread?.environments)) continue
      for (const environment of thread.environments) {
        const id = environment?.environmentId
        if (typeof id === "string" && (/^(?:env_|ccarenv_)[A-Za-z0-9_-]+$/.test(id) || /^[0-9a-f]{32}$/i.test(id))) return { env: canonicalEnvironment(id), searched }
      }
    }
    searched.push(`${path} (no cloud task environment)`)
  }
  return { searched }
}
function resolveEnvironment(metadataEnv, options, paths) {
  for (const value of [metadataEnv, options.codexCloud?.env]) if (value != null && typeof value !== "string") throw chatError(400, "metadata.env and codexCloud.env must be strings")
  const explicit = metadataEnv?.trim() || options.codexCloud?.env?.trim()
  if (explicit) return canonicalEnvironment(explicit)
  const discovered = discoverEnvironment(paths)
  if (discovered.env) return discovered.env
  throw chatError(400, `Codex Cloud could not discover an environment id. Searched: ${discovered.searched.join("; ")}. Open a Codex cloud task to populate the local cache, or set account metadata.env or option codexCloud.env.`)
}

function makeDriver(options, cli, statePaths = codexStatePaths()) {
  return {
    id: ID, name: NAME, staticModels: MODELS,
    async create(credential, { prompt }, signal) {
      let env = resolveEnvironment(credential.metadata?.env, options, statePaths)
      const fromOption = !credential.metadata?.env?.trim() && !!options.codexCloud?.env?.trim()
      const attempts = options.codexCloud?.attempts ?? 1
      if (!Number.isInteger(attempts) || attempts < 1) throw chatError(400, "codexCloud.attempts must be a positive integer")
      const run = { children: new Set(), prompt }
      const execute = () => cli(["cloud", "exec", "--env", env, "--attempts", String(attempts), "--", prompt], { signal, children: run.children })
      let created
      try { created = checkExit(await execute()) }
      catch (error) {
        if (fromOption || error.status !== 400 || !(error.refusal === "no-cloud-environment" || error.refusal === "stale-environment")) throw error
        const discovered = discoverEnvironment(statePaths).env
        if (!discovered || discovered === env) throw error
        env = discovered
        created = checkExit(await execute())
      }
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
      // The real CLI exits 1 for a failed task while still printing a parseable status line, so a
      // leading [ERROR] token is terminal even on non-zero exit; classified refusals keep flowing
      // to checkExit.
      if (result.code !== 0 && !loggedOut(progress) && !NO_CLOUD_ENVIRONMENT.test(progress) && !STALE_ENVIRONMENT.test(progress)) {
        if (/not found|no such task/i.test(progress)) return { state: "failed", progress }
        if (stateOf(result.stdout, run.prompt) === "failed") return { state: "failed", progress }
      }
      checkExit(result)
      const state = stateOf(result.stdout, run.prompt)
      if (state !== "succeeded") return { state, progress }
      let diff
      try { diff = checkExit(await cli(["cloud", "diff", run.ref], { signal, children: run.children, timeoutMs: 3000 })).stdout }
      catch (error) {
        if (!signal?.aborted && error.code === "CODEX_CLI_TIMEOUT") return { state: "running", progress: progress + "\nDiff retrieval timed out; waiting to retry the same task" }
        // The CLI exits 1 with this sentence for a completed task that produced no diff; that is a
        // successful turn, so the summary alone is the answer rather than an error.
        if (/no diff available/i.test(error.message)) diff = ""
        else throw error
      }
      const text = (run.inferred ? "WARNING: Task reference inferred from the environment's newest task; ownership is unverified and this may be another session's work.\n\n" : "") + (Buffer.byteLength(progress) <= 2048 ? progress + "\n\n" : "") + trimBytes(diff, 102400) + (Buffer.byteLength(diff) > 102400 ? "\n[diff truncated at 100 KiB]" : "")
      return { state, text: text.trim(), progress }
    },
    async cancel(credential, run) { for (const child of run.children) child.kill() },
  }
}

export function makeCodexCloud(options = {}, { cli = spawnCodex, now = Date.now, timers, statePaths = codexStatePaths() } = {}) {
  const driver = makeDriver(options, cli, statePaths)
  const verify = async (signal, children = new Set()) => {
    const result = await cli(["login", "status"], { signal, children, timeoutMs: 10000 })
    // The CLI writes its confirmation to stderr (measured: stdout "", stderr "Logged in using ChatGPT", exit 0),
    // so the marker has to be read from both streams, exactly as the logged-out check already does.
    if (result.code !== 0 || !/logged in/i.test(outputOf(result)) || loggedOut(outputOf(result))) throw chatError(401, LOGGED_OUT, "expired")
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
        get prompts() {
          if ((typeof options.codexCloud?.env === "string" && options.codexCloud.env.trim()) || discoverEnvironment(statePaths).env) return []
          return [{ type: "text", key: "env", message: "Optional Codex Cloud environment id (leave blank to discover from local Codex state)", validate: value => value == null || typeof value === "string" ? undefined : "an environment id must be a string" }]
        },
        authorize(inputs) {
          return {
            url: "", instructions: "Reuses the codex CLI's own login and discovers the environment from local Codex state unless explicitly configured. Only the resolved environment id is stored; Codex state is never changed.\n\nProvider notes: " + STATUS_NOTES, method: "auto",
            async callback() {
              let env
              try {
                env = resolveEnvironment(inputs?.env, options, statePaths)
                await verify()
                checkExit(await cli(["cloud", "list", "--env", env, "--limit", "1"]))
              }
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
