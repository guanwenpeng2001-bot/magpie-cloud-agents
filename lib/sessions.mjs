import { createHash } from "node:crypto"

export const SESSION_HEADER = "x-magpie-cloud-agents-session"
export function sessionOf(input) {
  const session = String(typeof input === "string" ? input : input?.sessionID ?? "").trim()
  return !session || /^magpie-[0-9a-f]{24}$/.test(session) ? "" : session.slice(0, 128)
}
export function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]"
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}"
  return JSON.stringify(value)
}
export const joinKey = (provider, session, messages) => createHash("sha256").update(canonical([provider, session, messages])).digest("hex")

export class SessionMap {
  constructor({ ttl = 86400000, cap = 200, now = Date.now } = {}) { Object.assign(this, { ttl, cap, now, entries: new Map() }) }
  get(key) {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    if (this.now() >= entry.expires) return undefined
    this.entries.set(key, entry)
    return entry.value
  }
  set(key, value) {
    this.entries.delete(key)
    this.entries.set(key, { value, expires: this.now() + this.ttl })
    for (const [storedKey, entry] of this.entries) if (this.now() >= entry.expires) this.entries.delete(storedKey)
    while (this.entries.size > this.cap) this.entries.delete(this.entries.keys().next().value)
    return this
  }
  delete(key) { return this.entries.delete(key) }
  get size() { return this.entries.size }
}
export class JoinMap {
  constructor() { this.entries = new Map() }
  join(key, create) {
    if (this.entries.has(key)) return this.entries.get(key)
    const pending = Promise.resolve().then(create)
    this.entries.set(key, pending)
    pending.finally(() => { if (this.entries.get(key) === pending) this.entries.delete(key) }).catch(() => {})
    return pending
  }
  delete(key) { return this.entries.delete(key) }
}
