import { randomUUID } from "node:crypto"
import { gunzipSync } from "node:zlib"
import { chatError, errorResponse, errorBody, normalizeError } from "../lib/errors.mjs"
import { foldPrompt } from "../lib/transcript.mjs"

const SERVER = "https://server.codeium.com"
const CHAT_RPC = "/exa.api_server_pb.ApiServerService/GetChatMessage"
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const identity = { id: "devin-cloud", name: "Devin Cloud (Codeium)" }

// Wire field numbers and client metadata follow @magpie-community/opencode-devin-auth.
class Protobuf {
  parts = []
  integer(value) {
    let remaining = BigInt(value)
    const bytes = []
    while (remaining >= 128n) { bytes.push(Number(remaining & 127n) | 128); remaining >>= 7n }
    bytes.push(Number(remaining))
    this.parts.push(Uint8Array.from(bytes))
  }
  varint(field, value) { this.integer(field * 8); this.integer(value); return this }
  bytes(field, value) {
    const bytes = typeof value === "string" ? encoder.encode(value) : value instanceof Protobuf ? value.done() : value
    this.integer(field * 8 + 2); this.integer(bytes.length); this.parts.push(bytes)
    return this
  }
  double(field, value) {
    this.integer(field * 8 + 1)
    const bytes = new Uint8Array(8)
    new DataView(bytes.buffer).setFloat64(0, value, true)
    this.parts.push(bytes)
    return this
  }
  done() { return new Uint8Array(Buffer.concat(this.parts)) }
}

function fields(bytes) {
  let offset = 0
  function integer() {
    let value = 0n
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= bytes.length) throw new Error("truncated protobuf")
      const byte = bytes[offset++]
      value |= BigInt(byte & 127) << shift
      if (!(byte & 128)) return Number(value)
    }
    throw new Error("invalid protobuf varint")
  }
  const result = []
  while (offset < bytes.length) {
    const tag = integer(), field = Math.floor(tag / 8), wire = tag & 7
    if (!field) throw new Error("invalid protobuf field")
    if (wire === 0) { result.push({ field, value: integer() }); continue }
    const length = wire === 2 ? integer() : wire === 1 ? 8 : wire === 5 ? 4 : -1
    if (length < 0 || length > bytes.length - offset) throw new Error("invalid protobuf length")
    if (wire === 2) result.push({ field, bytes: bytes.subarray(offset, offset + length) })
    offset += length
  }
  return result
}

function frame(message) {
  const bytes = new Uint8Array(message.length + 5)
  new DataView(bytes.buffer).setUint32(1, message.length)
  bytes.set(message, 5)
  return bytes
}

async function* frames(body) {
  if (!body) throw new Error("empty Connect response")
  const reader = body.getReader()
  const header = new Uint8Array(5)
  let headerOffset = 0, payload, payloadOffset = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) {
        if (headerOffset || payload) throw new Error("unexpected EOF")
        return
      }
      let offset = 0
      while (offset < next.value.length) {
        if (!payload) {
          const count = Math.min(5 - headerOffset, next.value.length - offset)
          header.set(next.value.subarray(offset, offset + count), headerOffset)
          headerOffset += count; offset += count
          if (headerOffset < 5) continue
          const length = new DataView(header.buffer).getUint32(1)
          if (length > 64 * 1024 * 1024) throw new Error("invalid Connect frame length")
          payload = new Uint8Array(length)
          payloadOffset = 0
        }
        const count = Math.min(payload.length - payloadOffset, next.value.length - offset)
        payload.set(next.value.subarray(offset, offset + count), payloadOffset)
        payloadOffset += count; offset += count
        if (payloadOffset < payload.length) continue
        const flags = header[0]
        const data = flags & 1 ? new Uint8Array(gunzipSync(payload, { maxOutputLength: 64 * 1024 * 1024 })) : payload
        payload = undefined; headerOffset = 0
        yield { end: !!(flags & 2), data }
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function clientMetadata(key) {
  const version = "3000.11.3"
  return new Protobuf().bytes(1, "devin-cli").bytes(2, version).bytes(3, key).bytes(4, "en")
    .bytes(5, process.platform === "win32" ? "windows" : process.platform).bytes(7, version).bytes(12, "chisel").bytes(28, "chisel")
}

function requestBody(key, prompt, model) {
  const metadata = clientMetadata(key)
  const message = new Protobuf().bytes(1, randomUUID()).varint(2, 1).bytes(3, prompt)
  const parameters = new Protobuf().varint(1, 1).varint(2, 128000).varint(3, 400).double(5, 1).varint(7, 40).double(8, 0.95)
  return frame(new Protobuf().bytes(1, metadata).bytes(3, message).varint(7, 5).bytes(8, parameters).bytes(21, model).done())
}

function failure(status, text) {
  let code, message = text
  try { const parsed = JSON.parse(text); const error = parsed.error ?? parsed; code = error.code; message = error.message || code || text } catch {}
  if (code === "permission_denied") return chatError(403, "the Devin account isn't entitled to this model — Devin serves only the account's entitled models (listed via the provider); the key itself is valid")
  const mapped = code === "unauthenticated" || status === 403 ? 401
    : code === "resource_exhausted" ? 429 : code === "invalid_argument" ? 400
    : code === "unavailable" ? 503 : code ? 502 : status
  return chatError(mapped, message || `HTTP ${mapped}`)
}

async function* replies(body) {
  let ended = false
  for await (const part of frames(body)) {
    if (part.end) {
      const end = JSON.parse(decoder.decode(part.data))
      if (end.error) throw failure(200, JSON.stringify(end))
      ended = true
      break
    }
    for (const field of fields(part.data)) {
      if (field.field === 3 && field.bytes) yield decoder.decode(field.bytes)
    }
  }
  if (!ended) throw new Error("the reply broke off: missing Connect end frame")
}

export function makeCodeiumChat(options = {}) {
  const server = (options.apiBase?.["devin-cloud-codeium"] ?? SERVER).replace(/\/+$/, "")
  const transport = (...args) => (options.fetch ?? globalThis.fetch)(...args)
  const modelCache = new Map()
  return {
    async models(credential) {
      const cached = modelCache.get(credential.key)
      if (cached?.expires > Date.now()) return cached.models
      try {
        const response = await transport(server + "/exa.api_server_pb.ApiServerService/GetCliModelConfigs", {
          method: "POST", headers: { Authorization: `Basic ${credential.key}`, "Content-Type": "application/proto" },
          body: new Protobuf().bytes(1, clientMetadata(credential.key)).done(), signal: AbortSignal.timeout(15000),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const models = {}
        for (const config of fields(new Uint8Array(await response.arrayBuffer()))) {
          if (config.field !== 1 || !config.bytes || decoder.decode(config.bytes).includes("Upgrade to Pro")) continue
          const entries = fields(config.bytes)
          const uid = entries.find(entry => entry.field === 22 && entry.bytes)?.bytes
          const label = entries.find(entry => entry.field === 1 && entry.bytes)?.bytes
          if (uid?.length) models[decoder.decode(uid)] = { name: label?.length ? decoder.decode(label) : decoder.decode(uid), tool_call: false, reasoning: false }
        }
        modelCache.set(credential.key, { models, expires: Date.now() + 5 * 60000 })
        return models
      } catch {
        modelCache.delete(credential.key)
        return { "swe-2": { name: "SWE-2", tool_call: false, reasoning: false } }
      }
    },
    async complete(credential, input, init = {}) {
      const controller = new AbortController()
      const caller = init.signal ?? (input instanceof Request ? input.signal : undefined)
      const timeout = AbortSignal.timeout(Math.max(1, Math.floor((options.maxRunMinutes ?? 30) * 60000)))
      const signal = AbortSignal.any([controller.signal, timeout, ...(caller ? [caller] : [])])
      let iterator
      try {
        const url = new URL(input instanceof Request ? input.url : input)
        if (!url.pathname.endsWith("/chat/completions")) throw chatError(404, "only chat completions are served")
        let chat
        try {
          const raw = init.body ?? (input instanceof Request ? await input.clone().text() : undefined)
          chat = JSON.parse(typeof raw === "string" ? raw : decoder.decode(raw))
          if (!chat || !Array.isArray(chat.messages) || chat.messages.some(message => !message || typeof message.role !== "string")) throw new Error("invalid messages")
        } catch { throw chatError(400, "a request that isn't JSON or has no valid messages array") }
        const cached = modelCache.get(credential.key)
        const defaultModel = cached?.expires > Date.now() ? Object.keys(cached.models)[0] : undefined
        const model = !chat.model || ["devin-session", "swe-2"].includes(chat.model) ? defaultModel ?? "swe-2-high" : chat.model
        const response = await transport(server + CHAT_RPC, {
          method: "POST", headers: { Authorization: `Basic ${credential.key}`, "Content-Type": "application/connect+proto", "Connect-Protocol-Version": "1" },
          body: requestBody(credential.key, foldPrompt(chat.messages, options), model), signal,
        })
        if (!response.ok) throw failure(response.status, await response.text())
        iterator = replies(response.body)
        const first = await iterator.next()
        if (first.done) throw chatError(502, "Codeium returned an empty reply")
        const id = "chatcmpl-" + randomUUID(), created = Math.floor(Date.now() / 1000)
        if (!chat.stream) {
          let text = first.value
          for await (const part of iterator) text += part
          return Response.json({ id, object: "chat.completion", created, model: chat.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] }, { headers: { "X-Magpie-Sign-In": "kept" } })
        }
        let initial = first
        const chunk = (delta, finish_reason = null) => encoder.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: chat.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
        return new Response(new ReadableStream({
          async pull(stream) {
            try {
              if (initial) stream.enqueue(chunk({ role: "assistant", content: "" }))
              const next = initial ?? await iterator.next()
              initial = null
              if (next.done) {
                stream.enqueue(chunk({}, "stop")); stream.enqueue(encoder.encode("data: [DONE]\n\n")); stream.close()
                return
              }
              stream.enqueue(chunk({ content: next.value }))
            } catch (error) {
              stream.enqueue(encoder.encode(`data: ${JSON.stringify(errorBody(normalizeError(timeout.aborted ? chatError(504, "Codeium request timed out") : error, identity)))}\n\n`))
              stream.close()
            }
          },
          async cancel() { controller.abort(); await iterator.return() },
        }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Magpie-Sign-In": "kept" } })
      } catch (error) {
        await iterator?.return()
        return errorResponse(timeout.aborted ? chatError(504, "Codeium request timed out") : error, identity)
      }
    },
  }
}
