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

export function foldPrompt(messages, { maxPromptBytes = 262144 } = {}) {
  const rows = messages.map(message => ({ ...message, text: clipped(textOf(message.content)) }))
  const system = rows.filter(message => ["system", "developer"].includes(message.role)).map(message => message.text)
  const conversation = rows.filter(message => !["system", "developer"].includes(message.role))
  const trailing = conversation.findLastIndex(message => message.role === "user")
  const first = conversation.findIndex(message => message.role === "user")
  let omitted = false
  const render = () => {
    const history = conversation.flatMap((message, index) => {
      if (index === trailing) return []
      if (!message) return []
      const label = message.role === "tool" ? `Tool result${message.name ? ` (${message.name})` : ""}` : message.role === "assistant" ? "Assistant" : "User"
      return [`${label}: ${message.text}`]
    })
    if (omitted) history.splice(Math.min(1, history.length), 0, ELISION)
    return [...system, ...(history.length ? ["Conversation so far:\n" + history.join("\n")] : []), "Current request:\n" + (conversation[trailing]?.text ?? "")].filter(Boolean).join("\n\n")
  }
  let result = render()
  for (let index = 0; Buffer.byteLength(result) > maxPromptBytes && index < conversation.length; index++) {
    if (index === first || index === trailing) continue
    conversation[index] = null
    omitted = true
    result = render()
  }
  // Protected instructions and requests cannot be silently removed to meet a byte cap.
  if (Buffer.byteLength(result) > maxPromptBytes) throw Object.assign(new Error("system texts and first/current requests exceed maxPromptBytes"), { status: 400 })
  return result
}

export function splitSuffix(history, messages) {
  if (!Array.isArray(history) || history.length > messages.length || !history.every((message, index) => isDeepStrictEqual(message, messages[index]))) return null
  const texts = messages.slice(history.length).filter(message => message.role === "user").map(message => clipped(textOf(message.content)))
  return texts.length ? texts : null
}
