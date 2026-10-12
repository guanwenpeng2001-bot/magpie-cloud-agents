import { test, expect } from "bun:test"
import { makeGrokBotDriver } from "./grok-bot.mjs"
import { makeGrokBotDirect } from "./grok-bot-direct.mjs"

const auth = { type: "oauth", access: "fixture", mechanism: "direct" }
const botId = "11111111-1111-4111-8111-111111111111"

function harness(agents) {
  const sent = []
  const direct = makeGrokBotDirect({}, {}, {
    store: { get: async () => ({ token: new TextEncoder().encode("fixture"), machineId: "fixture" }), dispose() {} },
    readFile: async () => { throw new Error("no local selection") },
    fetch: async (url, init) => {
      if (url.endsWith("ListGrokBotAgents")) return Response.json({ agents })
      if (url.endsWith("ListGrokBotTranscriptEntries")) return Response.json({ entries: [] })
      if (url.endsWith("SendGrokBotUserMessage")) { sent.push(JSON.parse(init.body).agent_id); return Response.json({ dispatched: true }) }
      throw new Error("unexpected request")
    },
  })
  const plugin = makeGrokBotDriver({}, {}, { importDirect: async () => ({ makeGrokBotDirect: () => direct }) })
  return { plugin, direct, sent }
}

test("first published Grok Bot model sends to a real bot even without a local selection", async () => {
  const { plugin, direct, sent } = harness([{ agentId: botId, name: "First live bot" }, { agentId: "second-bot", name: "Second live bot" }])
  try {
    const config = {}; await plugin.config(config)
    const models = await plugin.provider.models(config.provider["grok-bot"], { auth })
    const first = Object.keys(models)[0]
    expect(first).toBe(botId)
    expect(models["app-bot"]).toBeDefined()
    expect(models[first].api.id).toBe(first)
    await direct.create(auth, { model: first, prompt: "hello" })
    expect(sent).toEqual([botId])
  } finally { direct.dispose() }
})

test("Grok Bot keeps its floor without sign-in or live bots", async () => {
  const { plugin, direct } = harness([])
  try {
    const config = {}; await plugin.config(config)
    for (const context of [{}, { auth }]) {
      expect(Object.keys(await plugin.provider.models(config.provider["grok-bot"], context))).toEqual(["app-bot"])
    }
  } finally { direct.dispose() }
})
