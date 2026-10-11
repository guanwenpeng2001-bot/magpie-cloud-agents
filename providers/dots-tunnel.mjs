import { createHash, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile, rename, rm, chmod } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { chatError } from "../lib/errors.mjs"

export const CLOUDFLARED_VERSION = "2026.10.0"
// GitHub cloudflare/cloudflared release 2026.10.0 body and asset digest, read 2026-10-11.
export const CLOUDFLARED_SHA256 = "86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c"
export const CLOUDFLARED_URL = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-windows-amd64.exe`
export const DOTS_FAILURES = {
  download: "Dots: couldn't fetch the tunnel tool — check the proxy in Magpie Settings or your AV, then sign in again",
  down: "Dots: The Dots bridge is unreachable — the tunnel is not running. Start the tunnel or provide a public address.",
  unreachable: "Dots: the public URL isn't answering — the tunnel is up but unreachable; check firewall/proxy",
  rotated: "Dots: the tunnel URL changed — copy the new one from magpie plugin login dots (re-run sign-in) into the ChatGPT connector",
  lapsed: "Dots: The Dot's queue subscription lapsed. Ask the Dot to re-subscribe (or re-run setup).",
  noDot: "Dots: Your ChatGPT account doesn't have Dots enabled. This provider needs a Dot on the account.",
  restarted: "Dots: the bridge restarted; asking again sends it as a new task",
}
export const dotsFailure = kind => chatError(["rotated", "lapsed", "noDot"].includes(kind) ? 503 : 502, DOTS_FAILURES[kind], "kept")
export const dotsStateDir = (env = process.env) => join(env.XDG_CONFIG_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".config"), "magpie", "cloud-agents", "dots")
export function parseTunnelUrl(output) {
  return /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com(?=[\s|/]|$)/i.exec(output)?.[0]?.toLowerCase() ?? null
}
export async function ensureTunnelBinary({ directory = dotsStateDir(), fetch: fetcher = globalThis.fetch, sourceUrl = CLOUDFLARED_URL, expectedSha256 = CLOUDFLARED_SHA256, version = CLOUDFLARED_VERSION } = {}) {
  const target = join(directory, `cloudflared-${CLOUDFLARED_VERSION}-windows-amd64.exe`)
  let temporary
  try {
    if (version !== CLOUDFLARED_VERSION || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("Invalid pin")
    const source = new URL(sourceUrl)
    const fixture = source.protocol === "http:" && source.hostname === "127.0.0.1"
    if (!fixture && (sourceUrl !== CLOUDFLARED_URL || expectedSha256 !== CLOUDFLARED_SHA256)) throw new Error("Invalid download source")
    try {
      const cached = await readFile(target)
      if (createHash("sha256").update(cached).digest("hex") !== expectedSha256) throw new Error("Checksum mismatch")
      return target
    } catch (error) { if (error.code !== "ENOENT") throw error }
    const response = await fetcher(sourceUrl, { signal: AbortSignal.timeout(60000) })
    if (!response.ok) throw new Error("Download failed")
    const reader = response.body.getReader(), chunks = []
    let size = 0
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > 128 * 1024 * 1024) { await reader.cancel(); throw new Error("Download too large") }
      chunks.push(part.value)
    }
    const bytes = Buffer.concat(chunks)
    if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) throw new Error("Checksum mismatch")
    await mkdir(directory, { recursive: true, mode: 0o700 })
    temporary = target + "." + randomUUID() + ".tmp"
    await writeFile(temporary, bytes, { mode: 0o700, flag: "wx" })
    await chmod(temporary, 0o700)
    await rename(temporary, target)
    return target
  } catch { throw dotsFailure("download") }
  finally { if (temporary) await rm(temporary, { force: true }).catch(() => {}) }
}

export async function healthCheck(publicUrl, { fetch: fetcher = globalThis.fetch, timeoutMs = 10000 } = {}) {
  try {
    const response = await fetcher(publicUrl + "/mcp", { redirect: "error", signal: AbortSignal.timeout(timeoutMs) })
    if (response.status >= 500) throw dotsFailure("down")
    if (response.status !== 401) throw dotsFailure("unreachable")
    return true
  } catch (error) { if (error.status) throw error; throw dotsFailure("unreachable") }
}

function diagnosticTail(output) {
  return output
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\p{C}]/gu, character => /[\n\r\t]/.test(character) ? character : "")
    .replace(/[A-Za-z0-9_+\/=.%\-]+(?:\s+[A-Za-z0-9_+\/=.%\-]+)*/g, span => {
      const parts = span.split(/(\s+)/)
      for (let start = 0; start < parts.length; start += 2) {
        if (!/[0-9]|[a-z][A-Z]|[A-Z].*[A-Z]/.test(parts[start]) && parts[start].length < 12) continue
        let end = start, length = parts[start].length
        while (end + 2 < parts.length && (/[0-9]|[a-z][A-Z]|[A-Z].*[A-Z]/.test(parts[end + 2]) || parts[end + 2].length >= 12)) { end += 2; length += parts[end].length }
        if (length >= 20 && /[A-Z0-9]/.test(parts.slice(start, end + 1).join(""))) { parts.splice(start, end - start + 1, "[redacted]") }
        else start = end
      }
      return parts.join("")
    })
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\b(?:bearer|(?:[\w-]*[_-])?(?:token|secret|password|authorization|cookie|key))\b[^\r\n]*/gi, "[credential]")
    .replace(/[\p{C}\p{Z}]+/gu, " ").trim().slice(-200)
}

export class DotsTunnel {
  constructor({ localUrl, directory = dotsStateDir(), command, publicUrl, binary = ensureTunnelBinary, spawnChild = spawn, fetch: fetcher = globalThis.fetch, startupMs = 30000, backoffMs = 1000, timers = { setTimeout, clearTimeout }, onState = () => {} } = {}) {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(localUrl)) throw new Error("Tunnel target must be loopback")
    if (command && (!Array.isArray(command) || !command.length || command.some(part => typeof part !== "string" || !part))) throw new Error("tunnelCommand must be an argv array")
    if (publicUrl && (new URL(publicUrl).protocol !== "https:" || new URL(publicUrl).origin !== publicUrl)) throw new Error("Invalid public URL")
    Object.assign(this, { localUrl, directory, command, fixedUrl: publicUrl, binary, spawnChild, fetcher, startupMs, backoffMs, timers, onState })
    this.state = "stopped"; this.publicUrl = null; this.previousUrl = null; this.generation = 0; this.failures = 0; this.stopped = false; this.waiters = new Set()
  }
  setState(state) { this.state = state; this.onState(state) }
  start() {
    if (this.state === "ready") return Promise.resolve(this.publicUrl)
    if (this.pending) return this.pending
    this.stopped = false
    this.pending = this.launch().finally(() => { this.pending = null })
    return this.pending
  }
  async launch() {
    this.setState("starting")
    const generation = ++this.generation
    let command = this.command
    if (!command) command = [await this.binary({ directory: this.directory }), "tunnel", "--url", this.localUrl, "--no-autoupdate"]
    if (this.stopped || generation !== this.generation) throw dotsFailure("down")
    return new Promise((resolve, reject) => {
      let child, settled = false, output = "", checking = false, truncated = false
      const downFailure = () => {
        const tail = diagnosticTail(truncated ? output.replace(/^[^\r\n]*/, "") : output)
        return chatError(502, DOTS_FAILURES.down + (tail ? " — " + tail : ""), "kept")
      }
      this.downFailure = downFailure
      const finish = error => {
        if (settled) return
        settled = true; this.timers.clearTimeout(timeout)
        if (error) {
          if (error.message === DOTS_FAILURES.down) error = downFailure()
          this.lastError = error; reject(error)
        } else { this.lastError = null; resolve(this.publicUrl) }
      }
      const timeout = this.timers.setTimeout(() => { finish(dotsFailure("down")); child?.kill() }, this.startupMs)
      this.abortStart = () => finish(dotsFailure("down"))
      const ready = async url => {
        if (checking || settled || this.stopped) return
        checking = true
        try {
          await healthCheck(url, { fetch: this.fetcher })
          if (this.stopped || generation !== this.generation || child.exitCode !== null) throw dotsFailure("down")
          await mkdir(this.directory, { recursive: true, mode: 0o700 })
          await writeFile(join(this.directory, "tunnel-state.json"), JSON.stringify({ publicUrl: url, startedAt: Date.now(), pid: child.pid }), { mode: 0o600 })
          this.publicUrl = url
          this.rotated = Boolean(this.previousUrl && this.previousUrl !== url)
          this.previousUrl = url
          this.setState("ready")
          for (const waiter of this.waiters) waiter(url)
          finish()
        } catch (error) { finish(error); child.kill() }
      }
      try { child = this.spawnChild(command[0], command.slice(1), { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false }) }
      catch { this.setState("down"); finish(dotsFailure("down")); return }
      this.child = child
      const consume = chunk => {
        const combined = output + chunk.toString()
        truncated = truncated || combined.length > 8192
        output = combined.slice(-8192)
        const url = this.fixedUrl || parseTunnelUrl(output)
        if (url) void ready(url)
      }
      child.stdout?.on("data", consume)
      child.stderr?.on("data", consume)
      child.once("error", () => { this.lastError = downFailure(); this.setState("down"); finish(this.lastError) })
      child.once("exit", () => {
        if (generation !== this.generation) return
        if (this.state === "ready" || !settled) this.lastError = downFailure()
        this.child = null; this.publicUrl = null; this.setState("down"); finish(this.lastError)
        if (!this.stopped) {
          const delay = Math.min(this.backoffMs * 2 ** this.failures++, 30000)
          this.restartTimer = this.timers.setTimeout(() => { this.restartTimer = null; void this.start().catch(() => {}) }, delay)
          this.restartTimer.unref?.()
        }
      })
      if (this.fixedUrl) void ready(this.fixedUrl)
    })
  }
  async check() {
    if (this.state !== "ready" || !this.child || !this.publicUrl) throw this.lastError ?? dotsFailure("down")
    if (this.rotated) throw dotsFailure("rotated")
    try { return await healthCheck(this.publicUrl, { fetch: this.fetcher }) }
    catch (error) { throw error.message === DOTS_FAILURES.down ? this.downFailure() : error }
  }
  async stop() {
    this.stopped = true; this.generation++
    this.timers.clearTimeout(this.restartTimer); this.abortStart?.()
    const child = this.child
    this.child = null; this.publicUrl = null
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once("exit", resolve))
      child.kill()
      await exited
    }
    this.setState("stopped")
  }
}
