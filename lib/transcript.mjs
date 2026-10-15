import { isDeepStrictEqual } from "node:util"

const ELISION = "[history omitted]"
export function textOf(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map(part => part?.type === "text" ? String(part.text ?? "") : /image/.test(part?.type ?? "") ? "[image omitted — this provider takes text only]" : "").join("")
}

function clipped(text) {
  if (text.length <= 20000) return text
  return text.slice(0, 9990) + "[text omitted]" + text.slice(-9990)
}

const encodeText = text => JSON.stringify(text).slice(1, -1)

export function foldPrompt(messages, { maxPromptBytes = 262144 } = {}) {
  const system = []
  const conversation = []
  for (const message of messages) {
    const text = clipped(textOf(message.content))
    if (["system", "developer"].includes(message.role)) system.push(text)
    else conversation.push({ ...message, text: encodeText(text) })
  }
  const trailing = conversation.findLastIndex(message => message.role === "user")
  const first = conversation.findIndex(message => message.role === "user")
  const history = conversation.flatMap((message, index) => {
    if (index === trailing) return []
    const label = message.role === "tool" ? "Tool result" + (message.name ? " (" + encodeText(String(message.name)) + ")" : "") : message.role === "assistant" ? "Assistant" : "User"
    const text = label + ": " + message.text
    return [{ text, bytes: Buffer.byteLength(text), protected: index === first }]
  })
  const current = "Current request:\n" + (conversation[trailing]?.text ?? "")
  const fixedBytes = Buffer.byteLength([...system, current].filter(Boolean).join("\n\n"))
  let count = history.length
  let historyBytes = history.reduce((sum, row) => sum + row.bytes, 0)
  let omitted = false
  const total = () => fixedBytes + (count || omitted ? 2 + Buffer.byteLength("Conversation so far:\n") + historyBytes + (omitted ? Buffer.byteLength(ELISION) : 0) + Math.max(0, count + Number(omitted) - 1) : 0)
  for (const row of history) {
    if (total() <= maxPromptBytes) break
    if (row.protected) continue
    row.removed = true
    historyBytes -= row.bytes
    count--
    omitted = true
  }
  if (total() > maxPromptBytes) throw Object.assign(new Error("system texts and first/current requests exceed maxPromptBytes"), { status: 400 })
  const retained = history.filter(row => !row.removed).map(row => row.text)
  if (omitted) retained.splice(Math.min(1, retained.length), 0, ELISION)
  return [...system, ...(retained.length ? ["Conversation so far:\n" + retained.join("\n")] : []), current].filter(Boolean).join("\n\n")
}

export function splitSuffix(history, messages) {
  if (!Array.isArray(history) || history.length > messages.length || !history.every((message, index) => isDeepStrictEqual(message, messages[index]))) return null
  const texts = messages.slice(history.length).filter(message => message.role === "user").map(message => clipped(textOf(message.content)))
  return texts.length ? texts : null
}
