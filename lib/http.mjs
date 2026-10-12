import { chatError } from "./errors.mjs"

export const clock = { now: () => Date.now(), setTimeout: (...args) => setTimeout(...args), clearTimeout: timer => clearTimeout(timer), random: () => Math.random() }
export function abortable(promise, signal) {
  if (!signal) return Promise.resolve(promise)
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const aborted = () => { cleanup(); reject(signal.reason) }
    const cleanup = () => signal.removeEventListener("abort", aborted)
    signal.addEventListener("abort", aborted, { once: true })
    Promise.resolve(promise).then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}
export function deadline(signal, milliseconds, timers = clock, reason = new DOMException("upstream timed out", "TimeoutError")) {
  const controller = new AbortController()
  const timer = timers.setTimeout(() => controller.abort(reason), milliseconds)
  return { signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, dispose: () => timers.clearTimeout(timer) }
}
export async function withTimeout(operation, signal, milliseconds = 15000, timers = clock) {
  const limit = deadline(signal, milliseconds, timers)
  try { return await abortable(Promise.resolve().then(() => operation(limit.signal)), limit.signal) }
  finally { limit.dispose() }
}
export function sleep(milliseconds, signal, timers = clock) {
  let timer
  const waiting = new Promise(resolve => { timer = timers.setTimeout(resolve, milliseconds) })
  return abortable(waiting, signal).finally(() => timers.clearTimeout(timer))
}
export function retryAfter(value, now = Date.now()) {
  if (value == null || value === "") return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isNaN(date) ? null : Math.max(0, date - now)
}
export async function fetchWithTimeout(input, init = {}, { timeoutMs = 15000, fetch: fetcher = globalThis.fetch } = {}) {
  return withTimeout(async signal => {
    const response = await fetcher(input, { ...init, signal })
    if (!response.ok) {
      const error = chatError(response.status, await response.text())
      const after = response.headers.get("retry-after")
      if (after !== null) error.retryAfter = after
      throw error
    }
    return response
  }, init.signal, timeoutMs)
}
export async function pollWithBackoff(poll, { signal, emit = () => {}, timers = clock, initialMs = 2000, capMs = 10000 } = {}) {
  let delay = initialMs
  let failures = 0
  for (;;) {
    let outcome
    try {
      outcome = await withTimeout(poll, signal, 15000, timers)
      if (!["running", "succeeded", "failed", "expired"].includes(outcome?.state)) throw chatError(502, "driver returned an invalid poll state")
      failures = 0
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      if (error?.status === 429) {
        const after = retryAfter(error.retryAfter, timers.now())
        if (after == null) throw error
        await sleep(after, signal, timers)
        continue
      }
      if (error?.status || ++failures >= 3) throw error
    }
    if (outcome) {
      if (outcome.progress) emit(outcome.progress)
      if (outcome.partial) emit({ content: outcome.partial })
      if (outcome.state !== "running") return outcome
    }
    await sleep(delay * (0.8 + timers.random() * 0.4), signal, timers)
    delay = Math.min(capMs, delay * 1.5)
  }
}
