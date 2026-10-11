import { test, expect } from "bun:test"
import { emulate } from "./emulate.mjs"
import { chatError, FollowupRejected } from "./errors.mjs"
import { retryAfter, fetchWithTimeout } from "./http.mjs"

const messages = [{ role: "user", content: "Hello" }]
const run = { ref: "fake-run", url: "http://127.0.0.1/run" }
const auth = () => ({ type: "api", key: "SYNTHETIC" })
const driver = overrides => ({ id: "fake", name: "Fake", create: async () => run, followUp: async () => run, poll: async () => ({ state: "succeeded", text: "Answer" }), ...overrides })
const request = (fetcher, body = {}, init = {}) => fetcher("https://fake.invalid/v1/chat/completions", { body: JSON.stringify({ model: "model", messages, ...body }), ...init })
const frames = text => text.trim().split("\n\n").map(frame => frame.slice(6)).map(frame => frame === "[DONE]" ? frame : JSON.parse(frame))
const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve() }
function fakeClock() {
  let now = 0
  let serial = 0
  const tasks = new Map()
  return {
    now: () => now, random: () => 0.5,
    setTimeout(callback, delay) { const id = ++serial; tasks.set(id, { callback, at: now + delay }); return id },
    clearTimeout: id => tasks.delete(id),
    async advance(milliseconds) {
      const target = now + milliseconds
      await flush()
      for (;;) {
        const next = [...tasks].filter(([, task]) => task.at <= target).sort((left, right) => left[1].at - right[1].at)[0]
        if (!next) break
        now = next[1].at; tasks.delete(next[0]); next[1].callback(); await flush()
      }
      now = target; await flush()
    },
  }
}

test("path guard returns 404 and bad JSON returns 400 before credentials", async () => {
  const fetcher = emulate(driver(), () => { throw new Error("must not read auth") })
  expect((await fetcher("https://fake.invalid/models")).status).toBe(404)
  expect((await fetcher("https://fake.invalid/chat/completions", { body: "{" })).status).toBe(400)
})
test("credential gate re-reads auth and returns expired 401", async () => {
  let current = auth()
  const fetcher = emulate(driver(), () => current)
  expect((await request(fetcher)).status).toBe(200)
  current = null
  const response = await request(fetcher)
  expect(response.status).toBe(401)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe("expired")
})
test("stream sequence is role, progress, content, usage, DONE", async () => {
  const response = await request(emulate(driver(), auth), { stream: true })
  const events = frames(await response.text())
  expect(events[0].choices[0].delta).toEqual({ role: "assistant", content: "" })
  expect(events[1].choices[0].delta.reasoning_content).toContain(run.url)
  expect(events[2].choices[0].delta.content).toBe("Answer")
  expect(events[3].choices[0].finish_reason).toBe("stop")
  expect(events[3].usage.total_tokens).toBeGreaterThan(0)
  expect(events[4]).toBe("[DONE]")
})
test("non-stream accumulates final text and vendor usage without progress contamination", async () => {
  const usage = { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 }
  const response = await request(emulate(driver({ poll: async () => ({ state: "succeeded", text: "Answer", usage }) }), auth))
  const body = await response.json()
  expect(body.object).toBe("chat.completion")
  expect(body.choices[0].message.content).toBe("Answer")
  expect(body.usage).toEqual(usage)
})
test("abort closes stream and calls optional cancel with credential and run", async () => {
  const controller = new AbortController()
  let cancelled
  const response = await request(emulate(driver({ poll: async () => new Promise(() => {}), cancel: async (...args) => { cancelled = args } }), auth), { stream: true }, { signal: controller.signal })
  const reading = response.text()
  await flush(); controller.abort(); await reading; await flush()
  expect(cancelled).toEqual([auth(), run])
})
test.each([[401, undefined, 401, "expired"], [403, "expired", 401, "expired"], [403, undefined, 403, "kept"], [401, "kept", 401, "kept"], [429, undefined, 429, "kept"], [409, undefined, 409, "kept"], [502, undefined, 502, "kept"]])("create error %s/%s maps to %s/%s", async (status, signIn, expected, marker) => {
  const response = await request(emulate(driver({ create: async () => { throw Object.assign(new Error("vendor wording"), { status, signIn }) } }), auth))
  expect(response.status).toBe(expected)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe(marker)
  expect((await response.json()).error.message).toContain("vendor wording")
})
test.each(["failed", "expired"])("terminal %s returns 502 with run URL", async state => {
  const response = await request(emulate(driver({ poll: async () => ({ state, progress: "vendor detail" }) }), auth))
  expect(response.status).toBe(502)
  expect((await response.json()).error.message).toContain(run.url)
})
test("empty success produces an honest run link", async () => {
  const body = await (await request(emulate(driver({ poll: async () => ({ state: "succeeded" }) }), auth))).json()
  expect(body.choices[0].message.content).toContain("without writing a reply")
  expect(body.choices[0].message.content).toContain(run.url)
})
test("fake timers produce silence heartbeat and run cap 504 while preserving attachment", async () => {
  const timers = fakeClock()
  let creates = 0
  const fetcher = emulate(driver({ create: async () => { creates++; return run }, poll: async () => ({ state: "running" }) }), auth, { maxRunMinutes: 1 }, { timers })
  const response = await request(fetcher, { stream: true })
  const reading = response.text()
  await timers.advance(60001)
  const events = frames(await reading)
  expect(events.some(event => event.choices?.[0].delta.reasoning_content?.includes("25s"))).toBe(true)
  expect(events.find(event => event.error)?.error.code).toBe(504)
  const retry = request(fetcher)
  await timers.advance(60001)
  expect((await retry).status).toBe(504)
  expect(creates).toBe(1)
})
test("three consecutive poll transport failures return 502", async () => {
  const timers = fakeClock()
  let polls = 0
  const pending = request(emulate(driver({ poll: async () => { polls++; throw new Error("offline") } }), auth, {}, { timers }))
  await timers.advance(6000)
  expect((await pending).status).toBe(502)
  expect(polls).toBe(3)
})
test("simultaneous requests attach without a second create", async () => {
  let creates = 0
  const fetcher = emulate(driver({ create: async () => { creates++; await Promise.resolve(); return run } }), auth)
  const responses = await Promise.all([request(fetcher), request(fetcher)])
  expect(creates).toBe(1)
  for (const response of responses) expect((await response.json()).choices[0].message.content).toBe("Answer")
})
test("follow-up uses new user texts, rejected follow-up and divergence create fresh runs", async () => {
  const sent = []; let creates = 0
  const fetcher = emulate(driver({ create: async () => { creates++; return run }, followUp: async (cred, prior, texts) => { sent.push(texts); if (texts[0] === "reject") throw new FollowupRejected(); return run } }), auth)
  const init = { headers: { "x-magpie-cloud-agents-session": "conversation" } }
  await request(fetcher, {}, init)
  const next = [...messages, { role: "assistant", content: "Answer" }, { role: "user", content: "Next" }]
  await request(fetcher, { messages: next }, init)
  expect(sent).toEqual([["Next"]])
  await request(fetcher, { messages: [...next, { role: "user", content: "reject" }] }, init)
  await request(fetcher, { messages: [{ role: "user", content: "edited" }] }, init)
  expect(creates).toBe(3)
})
test("Request input uses the loader fetch signature", async () => {
  const fetcher = emulate(driver(), auth)
  const response = await fetcher(new Request("https://fake.invalid/chat/completions", { method: "POST", body: JSON.stringify({ messages }) }))
  expect(response.status).toBe(200)
})
test("Retry-After handles seconds and dates, HTTP wrapper preserves vendor wording", async () => {
  expect(retryAfter("2")).toBe(2000)
  expect(retryAfter("Thu, 01 Jan 1970 00:00:03 GMT", 1000)).toBe(2000)
  try {
    await fetchWithTimeout("http://127.0.0.1/unused", {}, { fetch: async () => new Response("vendor rate limit", { status: 429, headers: { "Retry-After": "4" } }) })
    throw new Error("expected failure")
  } catch (error) { expect(error.status).toBe(429); expect(error.retryAfter).toBe("4"); expect(error.message).toBe("vendor rate limit") }
})

test("stream disconnect falls back to poll and progress false suppresses heartbeats", async () => {
  const response = await request(emulate(driver({ stream: async () => { throw new Error("disconnected") } }), auth, { progress: false }), { stream: true })
  const events = frames(await response.text())
  expect(events.some(event => event.choices?.[0].delta.reasoning_content)).toBe(false)
  expect(events[1].choices[0].delta.content).toBe("Answer")
})
test("poll honors Retry-After then recovers", async () => {
  const timers = fakeClock(); let calls = 0
  const pending = request(emulate(driver({ poll: async () => {
    calls++
    if (calls === 1) throw Object.assign(chatError(429, "rate limited"), { retryAfter: "4" })
    return { state: "succeeded", text: "recovered" }
  } }), auth, {}, { timers }))
  await timers.advance(3999)
  expect(calls).toBe(1)
  await timers.advance(1)
  expect((await pending).status).toBe(200)
  expect(calls).toBe(2)
})
test("poll timeout bounds a driver that never resolves", async () => {
  const timers = fakeClock(); let calls = 0
  const pending = request(emulate(driver({ poll: async () => { calls++; return new Promise(() => {}) } }), auth, {}, { timers }))
  await timers.advance(50001)
  expect((await pending).status).toBe(502)
  expect(calls).toBe(3)
})
test("stream success honors byte-sized content chunks", async () => {
  const text = "中".repeat(5000)
  const response = await request(emulate(driver({ poll: async () => ({ state: "succeeded", text }) }), auth), { stream: true })
  const contents = frames(await response.text()).flatMap(event => event.choices?.[0].delta.content ? [event.choices[0].delta.content] : [])
  expect(contents.join("")).toBe(text)
  expect(contents.every(content => Buffer.byteLength(content) <= 4096)).toBe(true)
})
test("abort without cancel support closes normally", async () => {
  const controller = new AbortController()
  const response = await request(emulate(driver({ poll: async () => new Promise(() => {}) }), auth), { stream: true }, { signal: controller.signal })
  const reading = response.text()
  controller.abort()
  expect(await reading).not.toContain("[DONE]")
})

test("already aborted request never creates cloud work", async () => {
  let creates = 0
  const controller = new AbortController(); controller.abort()
  await request(emulate(driver({ create: async () => { creates++; return run } }), auth), {}, { signal: controller.signal })
  expect(creates).toBe(0)
})
test("action-required wording remains a 502 with kept sign-in", async () => {
  const response = await request(emulate(driver({ poll: async () => { throw chatError(502, "the agent needs an action this plugin can't perform (approval) — open fake-run") } }), auth))
  expect(response.status).toBe(502)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect((await response.json()).error.message).toContain("(approval)")
})
