import { test, expect } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DotsTunnel } from "./dots-tunnel.mjs"

function fixture() {
  const scheduled = new Set()
  const timers = {
    setTimeout(callback, delay) { const timer = { callback, delay }; scheduled.add(timer); return timer },
    clearTimeout(timer) { scheduled.delete(timer) },
  }
  const child = new EventEmitter()
  Object.assign(child, { pid: 123, exitCode: null, stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { child.exitCode = 0; child.emit("exit", 0); return true } })
  const tunnel = new DotsTunnel({ localUrl: "http://127.0.0.1:1234", command: ["fixture"], publicUrl: "https://fixture.invalid", spawnChild: () => child, fetch: async () => new Response(null, { status: 401 }), timers, backoffMs: 10 })
  return { tunnel, child, scheduled }
}

test("successful tunnel establishment resets consecutive restart backoff", async () => {
  const { tunnel, child, scheduled } = fixture()
  const directory = await mkdtemp(join(tmpdir(), "dots-recovery-"))
  tunnel.directory = directory
  tunnel.failures = 4
  try {
    await tunnel.start()
    child.exitCode = 1
    child.emit("exit", 1)
    expect([...scheduled].map(timer => timer.delay)).toEqual([10])
  } finally { await tunnel.stop(); await rm(directory, { recursive: true, force: true }) }
})

for (const behavior of ["false", "throw", "silent", "exit"]) {
  test(`stop returns within its deadline when kill behavior is ${behavior}`, async () => {
    const { tunnel, child, scheduled } = fixture()
    tunnel.child = child
    child.kill = () => {
      if (behavior === "throw") throw new Error("kill failed")
      if (behavior === "exit") { child.exitCode = 0; child.emit("exit", 0) }
      return behavior !== "false"
    }
    let outcome = "pending"
    const stopped = tunnel.stop().then(() => { outcome = "resolved" }, () => { outcome = "rejected" })
    for (const timer of [...scheduled]) {
      expect(timer.delay).toBeLessThanOrEqual(5000)
      timer.callback()
    }
    await Promise.resolve()
    await Promise.resolve()
    expect(outcome).toBe("resolved")
    await stopped
    expect(tunnel.state).toBe("stopped")
    expect(child.listenerCount("exit")).toBe(0)
    expect(scheduled.size).toBe(0)
  })
}
