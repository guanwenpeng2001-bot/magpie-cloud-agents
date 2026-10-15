import { test, expect } from "bun:test"
import { pollWithBackoff } from "./http.mjs"

// pollWithBackoff's backoff sleeps stay below the 15s poll deadline, so timers under
// 15s fire instantly and the deadline timer never does; polls resolve immediately.
const instantTimers = {
  now: () => 0,
  random: () => 0.5,
  setTimeout: (callback, delay) => { if (delay < 15000) queueMicrotask(callback); return 0 },
  clearTimeout: () => {},
}

test("pollWithBackoff forwards running progress as status text", async () => {
  const events = []
  let polls = 0
  const outcome = await pollWithBackoff(async () => {
    polls++
    return polls === 1 ? { state: "running", progress: "step 1" } : { state: "succeeded", text: "done" }
  }, { emit: event => events.push(event), timers: instantTimers })
  expect(outcome).toEqual({ state: "succeeded", text: "done" })
  expect(events).toEqual(["step 1"])
})

test("pollWithBackoff forwards cumulative partial answer text as content events", async () => {
  const events = []
  let polls = 0
  const outcome = await pollWithBackoff(async () => {
    polls++
    if (polls === 1) return { state: "running", progress: "drafting", partial: "Hel" }
    if (polls === 2) return { state: "running", partial: "Hello" }
    return { state: "succeeded", text: "Hello world" }
  }, { emit: event => events.push(event), timers: instantTimers })
  expect(outcome).toEqual({ state: "succeeded", text: "Hello world" })
  expect(events).toEqual(["drafting", { content: "Hel" }, { content: "Hello" }])
})

test("pollWithBackoff emits nothing when a running poll has neither progress nor partial", async () => {
  const events = []
  let polls = 0
  const outcome = await pollWithBackoff(async () => {
    polls++
    return polls === 1 ? { state: "running" } : { state: "succeeded", text: "done" }
  }, { emit: event => events.push(event), timers: instantTimers })
  expect(outcome).toEqual({ state: "succeeded", text: "done" })
  expect(events).toEqual([])
})

test.each([408, 502, 503])("poll retries transient HTTP %s", async status => {
  let calls = 0
  const result = await pollWithBackoff(async () => {
    if (++calls < 3) throw Object.assign(new Error("temporary"), { status })
    return { state: "succeeded", text: "ok" }
  }, { timers: instantTimers })
  expect(result.text).toBe("ok")
  expect(calls).toBe(3)
})
test.each([400, 401, 403, 404, 409])("poll does not retry HTTP %s", async status => {
  let calls = 0
  await expect(pollWithBackoff(async () => { calls++; throw Object.assign(new Error("permanent"), { status }) }, { timers: instantTimers })).rejects.toMatchObject({ status })
  expect(calls).toBe(1)
})

test("poll deadline allows a 30 second subprocess to finish", async () => {
  let deadlineMs
  const timers = { ...instantTimers, setTimeout(callback, delay) { deadlineMs = delay; return 1 } }
  await pollWithBackoff(async () => ({ state: "succeeded", text: "ok" }), { timers })
  expect(deadlineMs).toBeGreaterThan(30000)
})

test("transient retries back off and stop after three failures", async () => {
  const sleeps = []
  const timers = { ...instantTimers, setTimeout(callback, delay) { if (delay < 35000) { sleeps.push(delay); queueMicrotask(callback) } return 0 } }
  let calls = 0
  await expect(pollWithBackoff(async () => { calls++; throw Object.assign(new Error("unavailable"), { status: 503 }) }, { timers })).rejects.toMatchObject({ status: 503 })
  expect(calls).toBe(3)
  expect(sleeps).toEqual([1000, 1500])
})

test("abort during backoff prevents another poll", async () => {
  const controller = new AbortController()
  let calls = 0
  const timers = { ...instantTimers, setTimeout(callback, delay) { if (delay < 35000) queueMicrotask(() => controller.abort(new Error("cancelled"))); return 0 } }
  await expect(pollWithBackoff(async () => { calls++; throw new Error("offline") }, { timers, signal: controller.signal })).rejects.toThrow("cancelled")
  expect(calls).toBe(1)
})

test("invalid poll states never escape as terminal outcomes", async () => {
  await expect(pollWithBackoff(async () => ({ state: "unknown" }), { timers: instantTimers })).rejects.toMatchObject({ status: 502 })
})
