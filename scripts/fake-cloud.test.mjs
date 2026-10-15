import { afterEach, expect, test } from "bun:test"
import { makeCodexAgents } from "../providers/codex-agents.mjs"
import { startFakeCloud } from "./fake-cloud.mjs"

const servers = []
afterEach(() => { for (const server of servers.splice(0)) server.stop() })

function start(scenario) {
  const server = startFakeCloud({ scenario })
  servers.push(server)
  return server
}

test.each([false, true])("default fake supports Codex Agents chat with polling=%s", async polling => {
  const server = start(polling ? ({ url }) => url.pathname.endsWith("/events") ? new Response("") : undefined : undefined)
  const plugin = makeCodexAgents({ apiBase: { "codex-agents": server.url + "/openai" } })
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: "synthetic-only" }))
  const response = await loader.fetch(loader.baseURL + "/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-6-astra", messages: [{ role: "user", content: "Hello cloud" }] }),
  })
  expect(response.status).toBe(200)
  expect((await response.json()).choices[0].message.content).toBe("Synthetic OpenAI answer")
  expect(server.requests.some(row => row.path === "/openai/v1/agents/sessions/session_1/turns/turn_synthetic/items")).toBe(true)
})

test("fake scopes items to an existing session and turn", async () => {
  const server = start()
  const created = await fetch(server.url + "/openai/v1/agents/sessions", {
    method: "POST", body: JSON.stringify({}),
  })
  const { id } = await created.json()
  const base = `${server.url}/openai/v1/agents/sessions/${id}`
  const turns = await (await fetch(base + "/turns?order=desc&limit=1")).json()
  const turn = turns.data[0].id
  const items = await fetch(`${base}/turns/${turn}/items?order=asc&limit=100`)
  expect(items.status).toBe(200)
  expect((await items.json()).data[0].content[0].text).toBe("Synthetic OpenAI answer")
  for (const path of [base + "/items", base + "/turns/missing/items", `${server.url}/openai/v1/agents/sessions/missing/turns/${turn}/items`]) {
    expect((await fetch(path)).status).toBe(404)
  }
})
