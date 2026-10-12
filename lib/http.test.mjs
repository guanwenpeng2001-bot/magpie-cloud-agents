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
