import { test, expect } from "bun:test"
import { emulate } from "./emulate.mjs"
import { chatError, FollowupRejected } from "./errors.mjs"
import { retryAfter, fetchWithTimeout } from "./http.mjs"

const messages = [{ role: "user", content: "Hello" }]
const run = { ref: "fake-run", url: "http://127.0.0.1/run" }
const auth = () => ({ type: "api", key: "SYNTHETIC" })
const driver = overrides => ({ id: "fake", name: "Fake", create: async () => run, followUp: async () => run, poll: async () => ({ state: "succeeded", text: "Answer" }), ...overrides })
const request = (fetcher, body = {}, init = {}) => fetcher("https://fake.invalid/v1/chat/completions", { body: JSON.stringify({ model: "model", messages, ...body }), ...init })
const retryTimers = { now: Date.now, random: () => 0.5, setTimeout: (callback, delay) => setTimeout(callback, delay < 35000 ? 0 : delay), clearTimeout }
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
  expect(events.find(event => event.error)?.error.message).toContain("is still running after 1m")
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
  await timers.advance(110001)
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
  const response = await request(emulate(driver({ poll: async () => { throw chatError(502, "the agent needs an action this plugin can't perform (approval) — open fake-run") } }), auth, {}, { timers: retryTimers }))
  expect(response.status).toBe(502)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect((await response.json()).error.message).toContain("(approval)")
})

test("B1 vendor 504 preserves wording in JSON and SSE", async () => {
  for (const stream of [false, true]) {
    const response = await request(emulate(driver({ poll: async () => { throw chatError(504, "vendor gateway timed out verbatim") } }), auth, {}, { timers: retryTimers }), { stream })
    const body = stream ? frames(await response.text()).find(event => event.error) : await response.json()
    expect(body.error.message).toBe("vendor gateway timed out verbatim")
    expect(body.error.code).toBe(504)
    if (!stream) expect(response.status).toBe(504)
  }
})
test.each(["failed", "expired"])("B2 terminal %s is replaced but success stays attached", async state => {
  let creates = 0
  const fetcher = emulate(driver({ create: async () => ({ ref: ++creates }), poll: async (credential, current) => ({ state: current.ref === 1 ? state : "succeeded", text: "recovered" }) }), auth)
  const init = { headers: { "x-magpie-cloud-agents-session": "session" } }
  expect((await request(fetcher, {}, init)).status).toBe(502)
  expect((await request(fetcher, {}, init)).status).toBe(200)
  expect((await request(fetcher, {}, init)).status).toBe(200)
  expect(creates).toBe(2)
})
test("B3 identity is request-derived and stable on resend", async () => {
  const identities = []
  const capture = async (credential, submission) => { identities.push(submission.identity); throw chatError(502, "synthetic create failure") }
  const fetcher = emulate(driver({ create: capture }), auth)
  const init = { headers: { "x-magpie-cloud-agents-session": "affinity" } }
  await request(fetcher, {}, init); await request(fetcher, {}, init)
  const next = [...messages, { role: "assistant", content: "reply" }, { role: "user", content: "next" }]
  await request(fetcher, { messages: next }, init)
  expect(identities[0]).toEqual({ key: expect.stringMatching(/^[a-f0-9]{64}$/), sessionKey: "affinity", turnIndex: 0, textsHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
  expect(identities[1]).toEqual(identities[0])
  expect(identities[2].key).not.toBe(identities[0].key)
  expect(identities[2].textsHash).not.toBe(identities[0].textsHash)
  expect(identities[2].turnIndex).toBe(1)
  await request(emulate(driver({ create: capture }), auth))
  expect(identities[3].sessionKey).toBeNull()
})
test("O3 one MiB answer chunking finishes within one second", async () => {
  const text = "x".repeat(1024 * 1024)
  const started = performance.now()
  const response = await request(emulate(driver({ poll: async () => ({ state: "succeeded", text }) }), auth), { stream: true })
  const contents = frames(await response.text()).flatMap(event => event.choices?.[0].delta.content ? [event.choices[0].delta.content] : [])
  const elapsed = performance.now() - started
  console.log("O3: 1048576 bytes, " + elapsed.toFixed(2) + " ms")
  expect(contents.join("")).toBe(text)
  expect(contents.every(content => Buffer.byteLength(content) <= 4096)).toBe(true)
  expect(elapsed).toBeLessThan(1000)
}, 20000)

test.each([400, 401, 403, 429, 500, 501, 502, 503, 504, 505])("N1 stream status %s falls back to successful polling", async status => {
  for (const stream of [false, true]) {
    let polls = 0
    const response = await request(emulate(driver({
      stream: async () => { throw chatError(status, "stream endpoint unavailable") },
      poll: async () => { polls++; return { state: "succeeded", text: "poll recovered answer" } },
    }), auth), { stream })
    expect(response.status).toBe(200)
    if (stream) {
      const events = frames(await response.text())
      expect(events.some(event => event.error)).toBe(false)
      expect(events.flatMap(event => event.choices?.[0].delta.content ?? []).join("")).toBe("poll recovered answer")
      expect(events.at(-1)).toBe("[DONE]")
    } else expect((await response.json()).choices[0].message.content).toBe("poll recovered answer")
    expect(polls).toBe(1)
  }
})

test("N1 stream failure followed by poll failure preserves the poll error", async () => {
  for (const stream of [false, true]) {
    const response = await request(emulate(driver({
      stream: async () => { throw chatError(504, "stream unavailable") },
      poll: async () => { throw chatError(504, "poll gateway timeout verbatim") },
    }), auth, {}, { timers: retryTimers }), { stream })
    const body = stream ? frames(await response.text()).find(event => event.error) : await response.json()
    expect(body.error.message).toBe("poll gateway timeout verbatim")
    expect(body.error.code).toBe(504)
    if (!stream) expect(response.status).toBe(504)
  }
})

test.each([
  ["401 form", chatError(401, "vendor rejected the credential")],
  ["expired marker on 403", Object.assign(chatError(403, "token no longer valid"), { signIn: "expired" })],
])("F1 stream auth failure (%s) surfaces when the poll fails without auth", async (_form, streamError) => {
  for (const stream of [false, true]) {
    const response = await request(emulate(driver({
      stream: async () => { throw streamError },
      poll: async () => { throw chatError(502, "unreachable upstream") },
    }), auth, {}, { timers: retryTimers }), { stream })
    const body = stream ? frames(await response.text()).find(event => event.error) : await response.json()
    expect(body.error.message).toContain(streamError.message)
    expect(body.error.code).toBe(401)
    if (!stream) {
      expect(response.status).toBe(401)
      expect(response.headers.get("X-Magpie-Sign-In")).toBe("expired")
    }
  }
})
test("F1 stream auth failure confirmed by the poll keeps the auth error with one poll", async () => {
  let polls = 0
  const response = await request(emulate(driver({
    stream: async () => { throw chatError(401, "vendor rejected the credential") },
    poll: async () => { polls++; throw chatError(401, "vendor rejected the credential again") },
  }), auth))
  expect(response.status).toBe(401)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe("expired")
  expect((await response.json()).error.message).toContain("vendor rejected the credential")
  expect(polls).toBe(1)
})
test("F1 stream auth failure does not override a successful poll", async () => {
  let polls = 0
  const response = await request(emulate(driver({
    stream: async () => { throw chatError(401, "vendor rejected the credential") },
    poll: async () => { polls++; return { state: "succeeded", text: "credential still works" } },
  }), auth))
  expect(response.status).toBe(200)
  expect((await response.json()).choices[0].message.content).toBe("credential still works")
  expect(polls).toBe(1)
})
test("F3 run cap during repeated stream failures still reports the run cap", async () => {
  const timers = fakeClock(); let creates = 0
  const fetcher = emulate(driver({ create: async () => ({ ref: ++creates }), stream: async () => { throw chatError(502, "stream endpoint down") }, poll: async () => ({ state: "running" }) }), auth, { maxRunMinutes: 1 }, { timers })
  const pending = request(fetcher)
  await timers.advance(60001)
  const response = await pending
  expect(response.status).toBe(504)
  expect((await response.json()).error.message).toContain("is still running after 1m")
  expect(creates).toBe(1)
})

test("streamed answer content arrives before the terminal state and is not repeated", async () => {
  let release
  const response = await request(emulate(driver({
    stream: async (credential, current, onEvent) => {
      onEvent({ content: "Hel" })
      onEvent({ content: "Hello" })
      await new Promise(resolve => { release = resolve })
      return { state: "succeeded", text: "Hello world" }
    },
    poll: async () => { throw new Error("poll must not run after a streaming success") },
  }), auth), { stream: true })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let received = ""
  try {
    for (let index = 0; index < 4; index++) received += decoder.decode((await reader.read()).value)
    expect(frames(received).flatMap(event => event.choices?.[0].delta.content ?? []).join("")).toBe("Hello")
  } finally { release() }
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    received += decoder.decode(next.value)
  }
  const events = frames(received)
  const contents = events.flatMap(event => event.choices?.[0].delta.content ? [event.choices[0].delta.content] : [])
  expect(contents).toEqual(["Hel", "lo", " world"])
  expect(events.at(-1)).toBe("[DONE]")
})

test("a stream driver pushing only status strings keeps reasoning deltas and full text", async () => {
  const response = await request(emulate(driver({
    stream: async (credential, current, onEvent) => {
      onEvent("working")
      onEvent({ progress: "still working" })
      return { state: "succeeded", text: "Answer" }
    },
  }), auth), { stream: true })
  const events = frames(await response.text())
  const reasoning = events.flatMap(event => event.choices?.[0].delta.reasoning_content ? [event.choices[0].delta.reasoning_content] : [])
  expect(reasoning).toContain("working")
  expect(reasoning).toContain("still working")
  expect(events.flatMap(event => event.choices?.[0].delta.content ?? []).join("")).toBe("Answer")
  expect(events.at(-1)).toBe("[DONE]")
})

test("non-stream path assembles the complete message from streamed content increments", async () => {
  const usage = { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
  const response = await request(emulate(driver({
    stream: async (credential, current, onEvent) => {
      onEvent({ content: "Hello" })
      onEvent({ content: "Hello world" })
      return { state: "succeeded", text: "Hello world", usage }
    },
  }), auth))
  const body = await response.json()
  expect(body.choices[0].message.content).toBe("Hello world")
  expect(body.usage).toEqual(usage)
})

test("non-streaming divergence returns only the complete final answer", async () => {
  const response = await request(emulate(driver({
    stream: async (credential, current, onEvent) => {
      onEvent({ content: "draft" })
      return { state: "succeeded", text: "Final answer" }
    },
  }), auth))
  const body = await response.json()
  expect(body.choices[0].message.content).toBe("Final answer")
  expect(body.usage.completion_tokens).toBe(3)
})

test("diverging streamed content falls back to the full terminal text", async () => {
  const response = await request(emulate(driver({
    stream: async (credential, current, onEvent) => {
      onEvent({ content: "stale preview" })
      onEvent({ content: "totally different" })
      onEvent({ content: "stale preview resumed" })
      return { state: "succeeded", text: "Answer" }
    },
  }), auth), { stream: true })
  const events = frames(await response.text())
  const contents = events.flatMap(event => event.choices?.[0].delta.content ? [event.choices[0].delta.content] : [])
  expect(contents).toEqual(["stale preview", "Answer"])
  expect(events.at(-1)).toBe("[DONE]")
})

test("a shorter authoritative final text leaves the streamed tail and repeats the full final text", async () => {
  const response = await request(emulate(driver({
    stream: async (credential, current, onEvent) => {
      onEvent({ content: "Hello world" })
      onEvent({ content: "Hel" })
      onEvent({ content: "Hello world\n\n" })
      return { state: "succeeded", text: "Hello world" }
    },
  }), auth), { stream: true })
  const events = frames(await response.text())
  const contents = events.flatMap(event => event.choices?.[0].delta.content ? [event.choices[0].delta.content] : [])
  expect(contents).toEqual(["Hello world", "\n\n", "Hello world"])
  expect(events.at(-1)).toBe("[DONE]")
})

test("a transient regression recovers and later extension emits only its new tail", async () => {
  const response = await request(emulate(driver({
    stream: async (credential, current, onEvent) => {
      onEvent({ content: "Hello" })
      onEvent({ content: "Hello world" })
      onEvent({ content: "Hel" })
      onEvent({ content: "Hello world!" })
      return { state: "succeeded", text: "Hello world" }
    },
  }), auth), { stream: true })
  const events = frames(await response.text())
  const contents = events.flatMap(event => event.choices?.[0].delta.content ? [event.choices[0].delta.content] : [])
  expect(contents).toEqual(["Hello", " world", "!", "Hello world"])
})

test("steady streamed content resets the heartbeat until the stream goes quiet", async () => {
  const timers = fakeClock()
  const fetcher = emulate(driver({
    stream: async (credential, current, onEvent, signal) => {
      const pause = milliseconds => new Promise(resolve => timers.setTimeout(resolve, milliseconds))
      await pause(20000)
      if (signal.aborted) return
      onEvent({ content: "answer" })
      await pause(20000)
      if (signal.aborted) return
      onEvent({ content: "answer text" })
      await pause(20000)
      if (signal.aborted) return
      onEvent({ content: "answer text grows" })
      await new Promise(() => {})
    },
  }), auth, { maxRunMinutes: 2 }, { timers })
  const response = await request(fetcher, { stream: true })
  const reading = response.text()
  await timers.advance(120001)
  const events = frames(await reading)
  const heartbeats = events.flatMap(event => event.choices?.[0].delta.reasoning_content?.includes("still running") ? [event.choices[0].delta.reasoning_content] : [])
  expect(heartbeats).toEqual(["Fake still running (85s) — http://127.0.0.1/run", "Fake still running (110s) — http://127.0.0.1/run"])
  expect(events.find(event => event.error)?.error.code).toBe(504)
})

test("heartbeat keeps firing after streamed content goes quiet", async () => {
  const timers = fakeClock()
  const fetcher = emulate(driver({
    stream: async (credential, current, onEvent) => {
      onEvent({ content: "partial answer" })
      await new Promise(() => {})
    },
  }), auth, { maxRunMinutes: 1 }, { timers })
  const response = await request(fetcher, { stream: true })
  const reading = response.text()
  await timers.advance(60001)
  const events = frames(await reading)
  expect(events.some(event => event.choices?.[0].delta.content === "partial answer")).toBe(true)
  expect(events.some(event => event.choices?.[0].delta.reasoning_content?.includes("25s"))).toBe(true)
  expect(events.find(event => event.error)?.error.code).toBe(504)
})

test("poll partial answer text streams as content deltas before success", async () => {
  const timers = fakeClock()
  let polls = 0
  const response = await request(emulate(driver({
    poll: async () => {
      polls++
      if (polls === 1) return { state: "running", progress: "drafting", partial: "Hel" }
      if (polls === 2) return { state: "running", partial: "Hello" }
      return { state: "succeeded", text: "Hello world" }
    },
  }), auth, {}, { timers }), { stream: true })
  const reading = response.text()
  await flush()
  await timers.advance(2500)
  await flush()
  await timers.advance(5000)
  await flush()
  const events = frames(await reading)
  const contents = events.flatMap(event => event.choices?.[0].delta.content ? [event.choices[0].delta.content] : [])
  const reasoning = events.flatMap(event => event.choices?.[0].delta.reasoning_content ? [event.choices[0].delta.reasoning_content] : [])
  expect(reasoning).toContain("drafting")
  expect(contents).toEqual(["Hel", "lo", " world"])
  expect(polls).toBe(3)
})

test("shared run survives one subscriber abort and is removed after the last abort", async () => {
  let creates = 0, cancels = 0
  const fetcher = emulate(driver({ create: async () => ({ ref: "run-" + ++creates }), poll: async () => new Promise(() => {}), cancel: async () => { cancels++ } }), auth)
  const first = new AbortController(), second = new AbortController()
  const responses = await Promise.all([request(fetcher, { stream: true }, { signal: first.signal }), request(fetcher, { stream: true }, { signal: second.signal })])
  const readings = responses.map(response => response.text())
  first.abort(); await flush()
  const afterFirst = cancels
  second.abort(); await Promise.all(readings); await flush()
  expect(afterFirst).toBe(0)
  expect(cancels).toBe(1)
  const retry = await request(fetcher, { stream: true })
  expect(creates).toBe(2)
  await retry.body.cancel()
})

test("aborting the creator during creation does not abort a joined subscriber", async () => {
  let finish, sharedSignal, cancels = 0
  const fetcher = emulate(driver({ create: async (credential, input, signal) => { sharedSignal = signal; return new Promise(resolve => { finish = resolve }) }, cancel: async () => { cancels++ } }), auth)
  const first = new AbortController()
  const abandoned = request(fetcher, {}, { signal: first.signal })
  const survivor = request(fetcher)
  await flush(); first.abort(); await flush()
  const aborted = sharedSignal.aborted
  finish(run)
  await abandoned
  expect((await survivor).status).toBe(200)
  expect(aborted).toBe(false)
  expect(cancels).toBe(0)
})

test("exhausted polling errors remove attachment for a fresh retry", async () => {
  let creates = 0
  const fetcher = emulate(driver({ create: async () => ({ ref: ++creates }), poll: async (credential, current) => { if (current.ref === 1) throw chatError(503, "temporary"); return { state: "succeeded", text: "recovered" } } }), auth, {}, { timers: retryTimers })
  expect((await request(fetcher)).status).toBe(503)
  expect((await request(fetcher)).status).toBe(200)
  expect(creates).toBe(2)
})

test("last subscriber abort during creation cancels late run without caching it", async () => {
  let finish, creates = 0, cancels = 0
  const fetcher = emulate(driver({ create: async () => { creates++; if (creates === 1) return new Promise(resolve => { finish = resolve }); return run }, cancel: async () => { cancels++ } }), auth)
  const caller = new AbortController()
  const pending = request(fetcher, {}, { signal: caller.signal })
  await flush(); caller.abort(); await pending
  finish(run); await flush()
  expect(cancels).toBe(1)
  expect((await request(fetcher)).status).toBe(200)
  expect(creates).toBe(2)
})

test.each([false, true])("subscriber failure preserves shared attachment and session after success=%s", async completed => {
  let rejectFirst, resolveSecond, creates = 0, polls = 0, followups = 0
  const fetcher = emulate(driver({
    create: async () => ({ ref: "run-" + ++creates }),
    poll: async () => {
      if (++polls === 1) return new Promise((resolve, reject) => { rejectFirst = reject })
      if (polls === 2) return new Promise(resolve => { resolveSecond = resolve })
      return { state: "succeeded", text: "Answer" }
    },
    followUp: async (credential, prior) => { followups++; return prior },
  }), auth)
  const init = { headers: { "x-magpie-cloud-agents-session": "shared-session" } }
  const first = request(fetcher, {}, init), second = request(fetcher, {}, init)
  await flush()
  if (completed) { resolveSecond({ state: "succeeded", text: "Answer" }); await second }
  rejectFirst(chatError(400, "subscriber failed"))
  expect((await first).status).toBe(400)
  expect((await request(fetcher, {}, init)).status).toBe(200)
  expect((await request(fetcher, { messages: [...messages, { role: "assistant", content: "Answer" }, { role: "user", content: "Next" }] }, init)).status).toBe(200)
  if (!completed) { resolveSecond({ state: "succeeded", text: "Answer" }); await second }
  expect(creates).toBe(1)
  expect(followups).toBe(1)
})

test("expired creation cancels its late run without replacing healthy attachment or session", async () => {
  const timers = fakeClock()
  let finish, creates = 0, followed
  const cancelled = []
  const fetcher = emulate(driver({
    create: async () => { if (++creates === 1) return new Promise(resolve => { finish = resolve }); return { ref: "healthy" } },
    poll: async (credential, current) => ({ state: "succeeded", text: current.ref }),
    cancel: async (credential, current) => { cancelled.push(current.ref) },
    followUp: async (credential, prior) => { followed = prior.ref; return prior },
  }), auth, { maxRunMinutes: 0.001 }, { timers })
  const init = { headers: { "x-magpie-cloud-agents-session": "late-session" } }
  const pending = request(fetcher, {}, init)
  await timers.advance(61)
  expect((await pending).status).toBe(504)
  expect((await (await request(fetcher, {}, init)).json()).choices[0].message.content).toBe("healthy")
  finish({ ref: "orphan" }); await flush()
  expect((await (await request(fetcher, {}, init)).json()).choices[0].message.content).toBe("healthy")
  await request(fetcher, { messages: [...messages, { role: "user", content: "Next" }] }, init)
  expect(followed).toBe("healthy")
  expect(cancelled).toEqual(["orphan"])
  expect(creates).toBe(2)
})
