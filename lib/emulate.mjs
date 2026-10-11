import { randomUUID } from "node:crypto"
import { chatError, errorBody, errorResponse, normalizeError } from "./errors.mjs"
import { foldPrompt, splitSuffix } from "./transcript.mjs"
import { SessionMap, JoinMap, SESSION_HEADER, sessionOf, joinKey } from "./sessions.mjs"
import { abortable, clock, deadline, pollWithBackoff, withTimeout } from "./http.mjs"

const validCredential = credential => credential?.type === "api" ? typeof credential.key === "string" && !!credential.key.trim() : credential?.type === "oauth" && typeof credential.access === "string" && !!credential.access

export function emulate(driver, getAuth, options = {}, { timers = clock } = {}) {
  const sessions = new SessionMap({ now: timers.now })
  const attachments = new SessionMap({ now: timers.now })
  const joins = new JoinMap()
  return async function fetchCompletion(input, init = {}) {
    let chat, credential, prompt, run, limit, session, key
    const caller = init.signal ?? (input instanceof Request ? input.signal : undefined)
    const controller = new AbortController()
    const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal
    const minutes = options.maxRunMinutes ?? 30
    let cancelled = false
    const cancel = () => {
      if (cancelled) return
      cancelled = true
      controller.abort(new DOMException("request cancelled", "AbortError"))
      if (run && driver.cancel) void withTimeout(() => driver.cancel(credential, run), undefined, 5000, timers).catch(() => {})
    }
    try {
      const url = new URL(input instanceof Request ? input.url : input)
      if (!url.pathname.endsWith("/chat/completions")) return errorResponse(chatError(404, "only chat completions are served"))
      try {
        const body = init.body ?? (input instanceof Request ? await input.clone().text() : undefined)
        chat = JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body))
        if (!chat || !Array.isArray(chat.messages) || chat.messages.some(message => !message || typeof message.role !== "string")) throw new Error("invalid messages")
      } catch { return errorResponse(chatError(400, "a request that isn't JSON or has no valid messages array")) }
      credential = await getAuth()
      if (!validCredential(credential)) return errorResponse(chatError(401, `${driver.name} isn't signed in — magpie plugin login ${driver.id}`, "expired"))
      prompt = foldPrompt(chat.messages, options)
      const headers = new Headers(input instanceof Request ? input.headers : undefined)
      new Headers(init.headers).forEach((value, name) => headers.set(name, value))
      session = sessionOf(headers.get(SESSION_HEADER) ?? "")
      key = joinKey(driver.id, session, chat.messages)
      limit = deadline(signal, minutes * 60000, timers, chatError(504, `${driver.name} is still running after ${minutes}m — asking again attaches to the same run`))
      signal.throwIfAborted()
      run = attachments.get(key)
      if (!run) run = await abortable(joins.join(key, async () => {
        const previous = session && sessions.get(session)
        const suffix = previous && splitSuffix(previous.history, chat.messages)
        let created
        if (suffix && driver.followUp) {
          try { created = await driver.followUp(credential, previous.run, suffix, limit.signal) }
          catch (error) { if (error?.name !== "FollowupRejected") throw error }
        }
        if (!created) created = await driver.create(credential, { model: chat.model, prompt }, limit.signal)
        attachments.set(key, created)
        if (session) sessions.set(session, { run: created, history: structuredClone(chat.messages) })
        return created
      }), limit.signal)
      if (signal.aborted) { cancel(); throw signal.reason }
    } catch (error) {
      limit?.dispose()
      if (caller?.aborted) cancel()
      return errorResponse(error, driver)
    }

    const id = "chatcmpl-" + randomUUID()
    const created = Math.floor(timers.now() / 1000)
    const chunk = (delta, finish_reason = null, extra = {}) => ({ id, object: "chat.completion.chunk", created, model: chat.model, choices: [{ index: 0, delta, finish_reason }], ...extra })
    let lastProgress = ""
    let lastActivity = timers.now()
    let heartbeat
    const watch = async emit => {
      const progress = text => {
        if (options.progress === false || !text || text === lastProgress || limit.signal.aborted) return
        lastProgress = text; lastActivity = timers.now()
        emit(chunk({ reasoning_content: text }))
      }
      const beat = () => {
        const silent = timers.now() - lastActivity
        if (silent >= 25000) progress(`${driver.name} still running (${Math.floor((timers.now() - created * 1000) / 1000)}s) — ${run.url || run.ref}`)
        heartbeat = timers.setTimeout(beat, Math.max(1, 25000 - (timers.now() - lastActivity)))
      }
      caller?.addEventListener("abort", cancel, { once: true })
      try {
        emit(chunk({ role: "assistant", content: "" }))
        progress(`${driver.name}: ${run.url || run.ref}`)
        if (options.progress !== false) heartbeat = timers.setTimeout(beat, 25000)
        let outcome
        if (driver.stream) {
          try { outcome = await abortable(driver.stream(credential, run, value => progress(typeof value === "string" ? value : value?.progress), limit.signal), limit.signal) }
          catch (error) {
            if (limit.signal.aborted || error?.status === 401 || error?.signIn === "expired" || error?.status === 429) throw error
          }
        }
        if (!outcome || outcome.state === "running") outcome = await pollWithBackoff(pollSignal => driver.poll(credential, run, pollSignal), { signal: limit.signal, emit: progress, timers })
        if (outcome.state === "failed") throw chatError(502, `${driver.name} run failed: ${outcome.progress || outcome.text || "failed"} — ${run.url || run.ref}`)
        if (outcome.state === "expired") throw chatError(502, `${driver.name} expired before finishing — ${run.url || run.ref}; asking again starts/reattaches safely`)
        if (outcome.state !== "succeeded") throw chatError(502, "driver returned an invalid terminal state")
        const text = outcome.text || `${driver.name} finished the session without writing a reply — see ${run.url || run.ref}`
        let part = ""
        for (const character of text) {
          if (Buffer.byteLength(part + character) > 4096) { emit(chunk({ content: part })); part = "" }
          part += character
        }
        if (part) emit(chunk({ content: part }))
        // Token counts are estimates when the driver supplies no usage.
        const promptTokens = Math.floor((prompt.length + 3) / 4)
        const completionTokens = Math.floor((text.length + 3) / 4)
        const usage = outcome.usage ?? { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
        emit(chunk({}, "stop", { usage }))
      } catch (error) {
        if (signal.aborted) return
        if (error?.status === 504) throw chatError(504, `${driver.name} is still running after ${minutes}m — follow it at ${run.url || run.ref}; asking again attaches to the same run`)
        throw error
      } finally {
        timers.clearTimeout(heartbeat)
        limit.dispose()
        caller?.removeEventListener("abort", cancel)
      }
    }
    if (!chat.stream) {
      const message = { role: "assistant", content: "" }
      let usage
      try {
        await watch(event => {
          message.content += event.choices[0].delta.content ?? ""
          if (event.usage) usage = event.usage
        })
        if (signal.aborted) return new Response(null, { status: 499 })
        return Response.json({ id, object: "chat.completion", created, model: chat.model, choices: [{ index: 0, message, finish_reason: "stop" }], usage }, { headers: { "X-Magpie-Sign-In": "kept" } })
      } catch (error) { return errorResponse(error, driver) }
    }
    const encoder = new TextEncoder()
    let closed = false
    const stream = new ReadableStream({
      start(streamController) {
        const emit = event => { if (!closed) streamController.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)) }
        void watch(emit).then(() => {
          if (!closed && !signal.aborted) streamController.enqueue(encoder.encode("data: [DONE]\n\n"))
        }, error => emit(errorBody(normalizeError(error, driver)))).finally(() => {
          if (!closed) { closed = true; streamController.close() }
        })
      },
      cancel() { closed = true; cancel() },
    })
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Magpie-Sign-In": "kept" } })
  }
}
