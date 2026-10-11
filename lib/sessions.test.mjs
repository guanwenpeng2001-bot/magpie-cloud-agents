import { test, expect } from "bun:test"
import { SessionMap, JoinMap, sessionOf, joinKey } from "./sessions.mjs"

test("session TTL expires at the deadline", () => {
  let now = 0
  const sessions = new SessionMap({ ttl: 10, now: () => now })
  sessions.set("chat", { run: 1 })
  now = 9
  expect(sessions.get("chat")).toEqual({ run: 1 })
  now = 10
  expect(sessions.get("chat")).toBeUndefined()
  expect(sessions.size).toBe(0)
})
test("session cap evicts the least recently used entry", () => {
  const sessions = new SessionMap({ cap: 2 })
  sessions.set("first", 1).set("second", 2)
  expect(sessions.get("first")).toBe(1)
  sessions.set("third", 3)
  expect(sessions.get("second")).toBeUndefined()
  expect(sessions.get("first")).toBe(1)
  expect(sessions.size).toBe(2)
})
test("join attaches callers to the same in-flight run without another create", async () => {
  const joins = new JoinMap()
  let creates = 0
  let finish
  const create = () => { creates++; return new Promise(resolve => { finish = resolve }) }
  const first = joins.join("request", create)
  const second = joins.join("request", create)
  await Promise.resolve()
  expect(creates).toBe(1)
  expect(second).toBe(first)
  finish({ ref: "run" })
  expect(await second).toEqual({ ref: "run" })
})
test("session extraction drops synthetic ids and bounds real ids", () => {
  expect(sessionOf({ sessionID: "magpie-" + "a".repeat(24) })).toBe("")
  expect(sessionOf({ sessionID: " real " })).toBe("real")
  expect(sessionOf("x".repeat(200))).toHaveLength(128)
  expect(sessionOf({})).toBe("")
  expect(joinKey("driver", "chat", [{ role: "user", content: "hi" }])).toBe(joinKey("driver", "chat", [{ content: "hi", role: "user" }]))
})
