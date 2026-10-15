import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { createCdpApp } from "./cdp-app.mjs"

function fixture(options = {}, overrides = {}) {
  const host = new EventEmitter(), jobs = new Map(), active = new Map(), stopped = [], synchronous = []
  let row, closed = 0
  const client = { open: true, close() { closed++; this.open = false } }
  const app = createCdpApp({
    failure: key => Object.assign(new Error(key), { status: 502 }),
    find: async () => "C:\\app.exe", processName: "app.exe", flag: "magpie-test-managed",
    version: () => true, pages: list => list, launchError: () => new Error("launch"),
  }, options, {
    host, processes: async () => row ? [{ ...row }] : [], parentAlive: () => false,
    freePort: async () => 9333,
    spawn(executable, args) { row = { pid: 123, created: "original", executable, managedTag: args[2].split("=")[1] }; return { pid: 123, exitCode: null, once() {} } },
    stopManaged: async value => stopped.push(value), stopManagedSync: value => synchronous.push(value),
    fetch: async () => Response.json([{ webSocketDebuggerUrl: "ws://127.0.0.1:9333/page" }]),
    connect: async () => client,
    timers: { now: () => 0, setTimeout(callback, delay) { const timer = { unref() {} }; jobs.set(timer, { callback, delay }); return timer }, clearTimeout(timer) { jobs.delete(timer) } },
    ...overrides,
  }, active)
  return { app, host, jobs, active, stopped, synchronous, client, get closed() { return closed }, get row() { return row } }
}

test("default idle exposure is one minute and active work prevents teardown", async () => {
  const fake = fixture()
  await fake.app.ensure()
  expect([...fake.jobs.values()].map(job => job.delay)).toEqual([60000])
  fake.active.set("turn", {})
  fake.app.idle()
  expect(fake.jobs.size).toBe(0)
  fake.active.clear()
  fake.app.idle()
  await [...fake.jobs.values()][0].callback()
  await fake.app.dispose()
  expect(fake.closed).toBe(1)
  expect(fake.stopped).toHaveLength(1)
})

test("configured idle timeout remains supported", async () => {
  const fake = fixture({ keepAliveMinutes: 0.5 })
  await fake.app.ensure()
  expect([...fake.jobs.values()][0].delay).toBe(30000)
  await fake.app.dispose()
})

for (const event of ["beforeExit", "exit"]) test(`host ${event} disposes the connection and owned process`, async () => {
  const fake = fixture()
  await fake.app.ensure()
  fake.host.emit(event, 0)
  await fake.app.dispose()
  expect(fake.closed).toBe(1)
  expect(event === "exit" ? fake.synchronous : fake.stopped).toHaveLength(1)
  expect(fake.host.listenerCount("exit")).toBe(0)
  expect(fake.jobs.size).toBe(0)
})

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) test(`host ${signal} cleans up and preserves signal exit status`, async () => {
  const fake = fixture()
  const exits = []
  fake.host.exit = value => exits.push(value)
  await fake.app.ensure()
  fake.host.emit(signal)
  await Bun.sleep(0)
  expect(fake.stopped).toHaveLength(1)
  expect(exits).toEqual([code])
  expect(fake.host.listenerCount(signal)).toBe(0)
})

test("process creation stamp changed after launch is never terminated", async () => {
  const fake = fixture()
  await fake.app.ensure()
  fake.row.created = "reused"
  await fake.app.dispose()
  expect(fake.stopped).toEqual([])
})

test("dispose during attachment closes the eventual client", async () => {
  let resolveConnection, entered
  const ready = new Promise(resolve => { entered = resolve })
  const fake = fixture({}, { connect: () => { entered(); return new Promise(resolve => { resolveConnection = resolve }) } })
  const pending = fake.app.ensure().catch(() => {})
  await ready
  const disposing = fake.app.dispose()
  resolveConnection(fake.client)
  await pending
  await disposing
  expect(fake.client.open).toBe(false)
  expect(fake.jobs.size).toBe(0)
  expect(fake.stopped).toHaveLength(1)
})
