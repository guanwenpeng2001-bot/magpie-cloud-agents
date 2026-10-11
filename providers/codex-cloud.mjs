import { spawn } from "node:child_process"
import { emulate } from "../lib/emulate.mjs"
import { chatError, errorResponse } from "../lib/errors.mjs"
import { sessionOf, SESSION_HEADER } from "../lib/sessions.mjs"

const ID = "codex-cloud"
const NAME = "Codex Cloud (codex CLI)"
const BASE = "https://codex-cloud.cloud-agents.invalid/v1"
const MODELS = { "cloud-task": { name: "Codex Cloud task", tool_call: false, reasoning: false } }
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
    timer = setTimeout(() => stop(chatError(502, "the codex CLI timed out")), timeoutMs)
    if (signal?.aborted) aborted()
  })
}

function taskOf(text) {
  const match = /task[_-]?[a-z0-9-]{6,}|https:\/\/\S*?\/tasks?\/[\w-]+/i.exec(text)
  if (!match) return null
  return match[0].startsWith("https://") ? { ref: new URL(match[0]).pathname.split("/").pop(), url: match[0] } : { ref: match[0] }
}
function stateOf(text) {
  if (/\bexpir\w*\b/i.test(text)) return "expired"
  if (/\b(fail|error|cancel)\w*\b/i.test(text)) return "failed"
  if (/\b(complet|succeed|done|finish)\w*\b/i.test(text)) return "succeeded"
  return "running"
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
      const env = credential.metadata?.env?.trim() || options.codexCloud?.env?.trim()
      if (!env) throw chatError(400, "Codex Cloud requires account metadata.env (the sign-in environment id) or option codexCloud.env")
      const attempts = options.codexCloud?.attempts ?? 1
      if (!Number.isInteger(attempts) || attempts < 1) throw chatError(400, "codexCloud.attempts must be a positive integer")
      const run = { children: new Set() }
      const created = checkExit(await cli(["cloud", "exec", "--env", env, "--attempts", String(attempts), "--", prompt], { signal, children: run.children }))
      let task = taskOf(created.stdout)
      if (!task) {
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
      const state = stateOf(progress)
      if (state !== "succeeded") return { state, progress }
      const diff = checkExit(await cli(["cloud", "diff", run.ref], { signal, children: run.children })).stdout
      const text = (Buffer.byteLength(progress) <= 2048 ? progress + "\n\n" : "") + trimBytes(diff, 102400) + (Buffer.byteLength(diff) > 102400 ? "\n[diff truncated at 100 KiB]" : "")
      return { state, text: text.trim(), progress }
    },
    async cancel(credential, run) { for (const child of run.children) child.kill() },
  }
}

export function makeCodexCloud(options = {}, { cli = spawnCodex, now = Date.now, timers } = {}) {
  const driver = makeDriver(options, cli)
  const verify = async signal => {
    const result = await cli(["login", "status"], { signal, timeoutMs: 10000 })
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
                checking ??= verify().then(() => { checkedAt = now() }).finally(() => { checking = undefined })
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
            url: "", instructions: "Reuses the codex CLI's own login. Nothing is typed in; only the environment id is stored.", method: "auto",
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
