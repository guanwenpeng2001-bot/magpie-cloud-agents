import { test, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeQoderCloud, _internal as qoderInternal } from "./qoder-cloud.mjs"
import { startFakeManaged } from "../scripts/fake-managed.mjs"

const chat = async (fetch, messages, extra = {}) => {
  const { headers: extraHeaders, ...body } = extra
  const response = await fetch("http://sandbox.invalid/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json", ...(extraHeaders ?? {}) },
    body: JSON.stringify({ model: "ultimate", messages, stream: true, ...body }),
  })
  const text = await response.text()
  const errorFrame = [...text.matchAll(/^data: (\{"error".*)$/gm)].at(-1)
  return { status: errorFrame ? JSON.parse(errorFrame[1]).error.code ?? 502 : response.status, text }
}
const answerOf = body => [...body.matchAll(/^data: (\{.*)$/gm)].map(m => JSON.parse(m[1])).flatMap(c => c.choices ?? []).map(c => c.delta?.content ?? "").join("")
const progressOf = body => [...body.matchAll(/^data: (\{.*)$/gm)].map(m => JSON.parse(m[1])).flatMap(c => c.choices ?? []).map(c => c.delta?.reasoning_content ?? "").join("")

test("cloud turn provisions agent+environment, streams answer, follows up on the same session", async () => {
  const fake = startFakeManaged({ prefix: "/qoder" })
  try {
    const plugin = makeQoderCloud({ apiBase: { "qoder-cloud": fake.url }, maxRunMinutes: 1 })
    const fetch = (await plugin.auth.loader(async () => ({ type: "api", key: "test-key" }))).fetch
    const first = await chat(fetch, [{ role: "user", content: "hello cloud" }], { headers: { "x-magpie-cloud-agents-session": "s1" } })
    expect(first.status).toBe(200)
    expect(answerOf(first.text)).toContain("fake qoder answer")
    expect(fake.agents.size).toBe(1)
    expect(fake.environments.size).toBe(1)
    expect([...fake.environments.values()][0].config.type).toBe("cloud")
    expect([...fake.environments.values()][0].config.networking?.type).toBe("unrestricted")
    expect(fake.sessions.size).toBe(1)
    const second = await chat(fetch, [
      { role: "user", content: "hello cloud" },
      { role: "assistant", content: answerOf(first.text) },
      { role: "user", content: "follow up" },
    ], { headers: { "x-magpie-cloud-agents-session": "s1" } })
    expect(second.status).toBe(200)
    expect(fake.sessions.size).toBe(1)
    const sent = fake.requests.filter(r => r.method === "POST" && r.path.endsWith("/events"))
    expect(sent.length).toBe(1)
    expect(sent[0].body.events[0].type).toBe("user.message")
    expect(sent[0].body.events[0].content[0].text).toContain("follow up")
  } finally { fake.stop() }
})

test("self-hosted turn executes tool_use locally and posts user.tool_result", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "managed-self-hosted-"))
  const fake = startFakeManaged({ prefix: "/qoder" })
  try {
    const plugin = makeQoderCloud({ apiBase: { "qoder-cloud": fake.url }, qoderCloud: { selfHosted: { cwd } }, maxRunMinutes: 1 })
    const fetch = (await plugin.auth.loader(async () => ({ type: "api", key: "test-key" }))).fetch
    const result = await chat(fetch, [{ role: "user", content: "run a tool" }])
    expect(result.status).toBe(200)
    expect(answerOf(result.text)).toContain("answer")
    expect(progressOf(result.text)).toContain("running Bash locally")
    const session = [...fake.sessions.values()][0]
    expect(session.toolResults?.length).toBe(1)
    expect(session.toolResults[0].content[0].text).toContain("fake-tool-output")
    expect(session.toolResults[0].is_error).toBe(false)
    expect([...fake.environments.values()][0].config.type).toBe("self_hosted")
  } finally { fake.stop(); await rm(cwd, { recursive: true, force: true }) }
})

test("auth failure maps to 401 expired", async () => {
  const fake = startFakeManaged({ prefix: "/qoder", scenario: () => Response.json({ error: { message: "bad key" } }, { status: 401 }) })
  try {
    const plugin = makeQoderCloud({ apiBase: { "qoder-cloud": fake.url } })
    const fetch = (await plugin.auth.loader(async () => ({ type: "api", key: "bad" }))).fetch
    const result = await chat(fetch, [{ role: "user", content: "hi" }])
    expect(result.status).toBe(401)
  } finally { fake.stop() }
})

test("pinned agent/environment ids skip provisioning", async () => {
  const fake = startFakeManaged({ prefix: "/qoder" })
  try {
    const plugin = makeQoderCloud({ apiBase: { "qoder-cloud": fake.url }, qoderCloud: { agentId: "agent_pinned", environmentId: "env_pinned" } })
    const fetch = (await plugin.auth.loader(async () => ({ type: "api", key: "test-key" }))).fetch
    const result = await chat(fetch, [{ role: "user", content: "hi" }])
    expect(result.status).toBe(200)
    expect(fake.agents.size).toBe(0)
    expect(fake.environments.size).toBe(0)
    const session = [...fake.sessions.values()][0]
    expect(session.agent.id).toBe("agent_pinned")
    expect(session.environment_id).toBe("env_pinned")
  } finally { fake.stop() }
})

test("toolset uses capitalized enabled_tools for self-hosted", () => {
  const q = qoderInternal.toolset({ cwd: "/tmp" })
  expect(q.enabled_tools).toEqual(["Bash", "Read", "Glob", "Grep"])
  const cloud = qoderInternal.toolset(null)
  expect(cloud.enabled_tools).toBeUndefined()
})

test("requires_action without answered tools fails instead of hanging", async () => {
  const scenario = ({ path, body, sessions }) => {
    if (path === "/sessions" && body) {
      const session = { id: "sess_stuck", status: "idle", selfHosted: true, events: [
        { id: "evt_1", type: "agent.message", content: [{ type: "text", text: "partial" }] },
        { id: "evt_2", type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["evt_unknown"] } },
      ] }
      sessions.set(session.id, session)
      return Response.json({ id: session.id, status: "idle" })
    }
    return null
  }
  const fake = startFakeManaged({ prefix: "/qoder", scenario })
  try {
    const plugin = makeQoderCloud({ apiBase: { "qoder-cloud": fake.url }, qoderCloud: { agentId: "a", environmentId: "e", selfHosted: { cwd: process.cwd() } } })
    const fetch = (await plugin.auth.loader(async () => ({ type: "api", key: "k" }))).fetch
    const result = await chat(fetch, [{ role: "user", content: "hi" }])
    expect(result.status).toBe(502)
    expect(result.text).toContain("requires_action")
  } finally { fake.stop() }
})