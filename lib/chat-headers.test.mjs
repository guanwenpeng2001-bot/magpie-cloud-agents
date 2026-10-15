import { expect, test } from "bun:test"
import { makeCodexCloud } from "../providers/codex-cloud.mjs"
import { makeCodexAgents } from "../providers/codex-agents.mjs"
import { makeCursorCloud } from "../providers/cursor-cloud.mjs"
import { makeDotsDriver } from "../providers/dots.mjs"
import { makeGrokBotDriver } from "../providers/grok-bot.mjs"
import { SESSION_HEADER } from "./sessions.mjs"

const providers = [makeCodexCloud(), makeCodexAgents(), makeCursorCloud(), makeDotsDriver({}), makeGrokBotDriver({})]
for (const provider of providers) {
  const id = provider.auth.provider
  test(`${id}: missing headers are initialized for this provider`, async () => {
    const output = {}
    await provider["chat.headers"]({ model: { providerID: id }, sessionID: "session-one" }, output)
    expect(output.headers?.[SESSION_HEADER]).toBe("session-one")
  })
  test(`${id}: another provider never receives the session header`, async () => {
    const output = { headers: { authorization: "existing" } }
    await provider["chat.headers"]({ model: { providerID: "external" }, sessionID: "private" }, output)
    expect(output.headers).toEqual({ authorization: "existing" })
  })
  test(`${id}: model provider takes precedence over conflicting provider metadata`, async () => {
    const output = {}
    await provider["chat.headers"]({ model: { providerID: "external" }, provider: { info: { id } }, sessionID: "private" }, output)
    expect(output.headers).toBeUndefined()
  })
  test(`${id}: provider metadata fallback preserves existing headers`, async () => {
    const output = { headers: { authorization: "existing" } }
    await provider["chat.headers"]({ provider: { info: { id } }, sessionID: "session-one" }, output)
    expect(output.headers).toEqual({ authorization: "existing", [SESSION_HEADER]: "session-one" })
  })
}
