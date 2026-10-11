import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"

export const mintToken = () => randomBytes(24).toString("base64url")
export function equalSecret(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false
  const a = Buffer.from(left), b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export class DotsQueue {
  constructor({ now = Date.now, ttlMs = 1800000, leaseMs = 300000, retentionMs = 600000, capacity = 200 } = {}) {
    Object.assign(this, { now, ttlMs, leaseMs, retentionMs, capacity })
    this.tasks = new Map()
    this.listeners = new Set()
  }
  onAvailable(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  available(task) { for (const listener of this.listeners) listener(this.public(task)) }
  public(task) {
    const { lease, ...row } = task
    return structuredClone(row)
  }
  maintain() {
    const now = this.now()
    for (const [id, task] of this.tasks) {
      if (["completed", "failed", "cancelled", "expired"].includes(task.status)) {
        if (now >= task.finishedAt + this.retentionMs) this.tasks.delete(id)
      } else if (now >= task.expiresAt) {
        task.status = "expired"; task.finishedAt = now; task.lease = null
      } else if (task.status === "running" && now >= task.lease.expiresAt) {
        task.status = "queued"; task.lease = null; task.revision++
        this.available(task)
      }
    }
  }
  enqueue(prompt) {
    this.maintain()
    if (this.tasks.size >= this.capacity) throw new Error("Task queue is full")
    const now = this.now()
    const task = { id: "task_" + randomUUID(), task_id: "", queue: "dot", prompt, instructions: prompt, payload: { messages: [{ role: "user", content: prompt }] }, status: "queued", created_at: new Date(now).toISOString(), createdAt: now, expiresAt: now + this.ttlMs, revision: 1, attempts: 0, lease: null, result: null, error: null }
    task.task_id = task.id
    this.tasks.set(task.id, task)
    this.available(task)
    return this.public(task)
  }
  get(id) { this.maintain(); const task = this.tasks.get(id); return task && this.public(task) }
  list({ queue = "dot", status } = {}) {
    this.maintain()
    return { tasks: [...this.tasks.values()].filter(task => task.queue === queue && (status ? task.status === status : ["queued", "running"].includes(task.status))).map(task => this.public(task)), next_cursor: null }
  }
  claim(id) {
    this.maintain()
    const task = id ? this.tasks.get(id) : [...this.tasks.values()].find(task => task.status === "queued")
    if (!task || task.status !== "queued") throw new Error("Task is not available")
    task.status = "running"; task.attempts++; task.revision++
    task.lease = { token: mintToken(), expiresAt: Math.min(this.now() + this.leaseMs, task.expiresAt) }
    return { task: this.public(task), lease_token: task.lease.token }
  }
  leased(id, token) {
    this.maintain()
    const task = this.tasks.get(id)
    if (!task || !equalSecret(task.lease?.token, token)) throw new Error("Lease is no longer valid")
    return task
  }
  complete(id, token, result) {
    const task = this.leased(id, token)
    if (task.status === "completed" && JSON.stringify(task.result) === JSON.stringify(result)) return { task: this.public(task) }
    if (task.status !== "running") throw new Error("Lease is no longer valid")
    task.result = structuredClone(result); task.status = "completed"; task.finishedAt = this.now(); task.revision++
    return { task: this.public(task) }
  }
  release(id, token, retry = true, error = "") {
    const task = this.leased(id, token)
    if (task.status !== "running") throw new Error("Lease is no longer valid")
    task.status = retry ? "queued" : "failed"; task.error = error; task.lease = null; task.revision++
    if (retry) this.available(task)
    else task.finishedAt = this.now()
    return { task: this.public(task) }
  }
  cancel(id) {
    const task = this.tasks.get(id)
    if (task && ["queued", "running"].includes(task.status)) {
      task.status = "cancelled"; task.lease = null; task.finishedAt = this.now()
    }
  }
  clear() { this.tasks.clear(); this.listeners.clear() }
}
