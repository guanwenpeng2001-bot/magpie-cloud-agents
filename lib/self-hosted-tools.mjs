// Self-hosted (BYOC) tool execution for the managed-agents providers.
// The model runs in the vendor cloud; agent.tool_use events are executed HERE,
// confined to the configured cwd, and results go back as user.tool_result.
// Opt-in only: options.<provider>.selfHosted.cwd must be set explicitly.
import { spawn } from "node:child_process"
import { promises as fs, existsSync } from "node:fs"
import path from "node:path"

export const TOOL_NAMES = ["bash", "read", "glob", "grep"]
const MAX_OUTPUT = 30000
const BASH_TIMEOUT_MS = 120000

const clip = text => text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + "\n[output truncated]" : text

// Symlink-aware containment: resolve the target fully, then check it stays under cwd.
async function contained(cwd, target) {
  const resolved = path.resolve(cwd, target ?? ".")
  let real
  try { real = await fs.realpath(resolved) }
  catch { real = path.resolve(await fs.realpath(cwd), path.relative(cwd, resolved)) }
  const root = await fs.realpath(cwd)
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error(`path escapes the self-hosted cwd: ${target}`)
  return real
}

function bashExecutable() {
  if (process.platform !== "win32") return "/bin/bash"
  const candidates = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs")]
    .filter(Boolean).map(root => path.join(root, "Git", "bin", "bash.exe"))
  const executable = candidates.find(existsSync)
  if (!executable) throw new Error("Self-hosted bash on Windows requires Git for Windows; install it or disable the bash tool")
  return executable
}

function bash(cwd, input, signal) {
  signal?.throwIfAborted()
  const executable = bashExecutable()
  return new Promise(resolve => {
    const child = spawn(executable, ["-c", String(input.command ?? "")], { cwd, windowsHide: true, detached: process.platform !== "win32", env: { ...process.env, PS1: "" }, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    const stopped = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", aborted)
      // Descendants can inherit these pipes (notably under Git Bash). Do not
      // wait for their handles to close after terminating the owned tree.
      child.stdout.destroy()
      child.stderr.destroy()
      resolve({ text: clip(out) + "\n[execution cancelled or timed out]", isError: true })
    }
    const stop = () => {
      if (!child.pid || child.exitCode !== null) return
      if (process.platform === "win32") {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
        killer.on("error", () => { child.kill("SIGKILL"); stopped() })
        killer.on("close", stopped)
      } else {
        try { process.kill(-child.pid, "SIGKILL") } catch { child.kill("SIGKILL") }
        stopped()
      }
    }
    const timer = setTimeout(stop, Math.min(Number(input.timeout_ms) || BASH_TIMEOUT_MS, BASH_TIMEOUT_MS))
    const aborted = stop
    signal?.addEventListener("abort", aborted, { once: true })
    const take = chunk => { out += chunk; if (out.length > MAX_OUTPUT * 2) out = out.slice(0, MAX_OUTPUT * 2) }
    child.stdout.on("data", take)
    child.stderr.on("data", take)
    child.on("error", error => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); resolve({ text: String(error), isError: true }) })
    child.on("close", code => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", aborted)
      resolve({ text: clip(out) + (code ? `\n[exit code ${code}]` : ""), isError: code !== 0 })
    })
  })
}

async function read(cwd, input) {
  const file = await contained(cwd, input.file_path)
  const text = await fs.readFile(file, "utf8")
  const lines = text.split("\n")
  const range = Array.isArray(input.view_range) && input.view_range.length === 2 ? input.view_range : null
  const start = range ? Math.max(1, Number(range[0]) || 1) : 1
  const end = range ? Math.min(lines.length, Number(range[1]) || lines.length) : lines.length
  return { text: clip(lines.slice(start - 1, end).map((line, index) => `${start + index}\t${line}`).join("\n")) }
}

async function walk(dir, cwd, out, limit) {
  if (out.length >= limit) return
  let entries
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (out.length >= limit) return
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, cwd, out, limit)
    else if (entry.isFile()) out.push(path.relative(cwd, full).split(path.sep).join("/"))
  }
}

// Glob supports the common **/ and * forms via RegExp; enough for agent navigation.
async function glob(cwd, input) {
  const base = await contained(cwd, input.path)
  const files = []
  await walk(base, await fs.realpath(cwd), files, 20000)
  const pattern = String(input.pattern ?? "*")
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "\u0000").replace(/\*\*/g, "\u0001").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replaceAll("\u0000", "(?:.*/)?").replaceAll("\u0001", ".*")
  const re = new RegExp(`^${escaped}$`)
  const matches = files.filter(file => re.test(file)).sort()
  return { text: matches.length ? clip(matches.slice(0, 1000).join("\n")) : "no matches" }
}

async function grep(cwd, input) {
  const base = await contained(cwd, input.path)
  const re = new RegExp(String(input.pattern ?? ""))
  const files = []
  const stat = await fs.stat(base).catch(() => null)
  if (stat?.isFile()) files.push(path.relative(await fs.realpath(cwd), base).split(path.sep).join("/"))
  else await walk(base, await fs.realpath(cwd), files, 20000)
  const root = await fs.realpath(cwd)
  const hits = []
  for (const file of files) {
    if (hits.length >= 500) break
    let text
    try { text = await fs.readFile(path.join(root, file), "utf8") } catch { continue }
    if (text.includes("\u0000")) continue
    const lines = text.split("\n")
    for (let index = 0; index < lines.length && hits.length < 500; index++) {
      if (re.test(lines[index])) hits.push(`${file}:${index + 1}:${lines[index].slice(0, 500)}`)
    }
  }
  return { text: hits.length ? clip(hits.join("\n")) : "no matches" }
}

const EXECUTORS = { bash, read, glob, grep }

// Execute one agent.tool_use event locally. Unknown tools get an error result so
// the cloud session can proceed instead of hanging.
export async function executeLocalTool(event, selfHosted, signal) {
  const name = String(event.name ?? "").toLowerCase()
  const cwd = selfHosted.cwd
  const allowed = (selfHosted.tools ?? TOOL_NAMES).map(tool => tool.toLowerCase())
  try {
    if (!allowed.includes(name) || !EXECUTORS[name]) return { text: `tool ${event.name} is not enabled for self-hosted execution (allowed: ${allowed.join(", ")})`, isError: true }
    const result = await EXECUTORS[name](cwd, event.input ?? {}, signal)
    return { text: result.text || "(no output)", isError: !!result.isError }
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    return { text: clip(String(error?.message ?? error)), isError: true }
  }
}

export const _internal = { contained, TOOL_NAMES }
