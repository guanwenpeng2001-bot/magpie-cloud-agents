import { strict as assert } from "node:assert"

const json = value => Response.json(value)
const events = rows => new Response(rows.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } })

export function startFakeCloud({ port = 0, scenario } = {}) {
  const requests = []
  const sessions = new Map()
  let sequence = 0
  const server = Bun.serve({
    hostname: "127.0.0.1", port,
    async fetch(request) {
      const url = new URL(request.url)
      let body
      try { body = request.method === "POST" ? await request.json() : undefined }
      catch { return new Response("invalid JSON", { status: 400 }) }
      const record = { method: request.method, path: url.pathname, body }
      requests.push(record)
      if (scenario) {
        const response = await scenario({ request, url, body, sessions, requests })
        if (response) return response
      }
      const [, vendor, ...segments] = url.pathname.split("/")
      const path = "/" + segments.join("/")
      if (path === "/v1/models") return json(vendor === "cursor" ? { models: [{ id: "composer-2", name: "Composer 2" }] } : { data: [{ id: "gpt-6-astra" }] })
      if (vendor === "openai") {
        if (path === "/v1/agents/sessions" && request.method === "POST") {
          const id = `session_${++sequence}`
          sessions.set(id, { id, turnId: "turn_synthetic", text: "Synthetic OpenAI answer" })
          return json({ id, status: "active" })
        }
        const match = /^\/v1\/agents\/sessions\/([^/]+)(?:\/(events|turns)(?:\/([^/]+)\/(items))?)?$/.exec(path)
        const session = match && sessions.get(match[1])
        if (session) {
          if (match[4]) {
            if (match[2] !== "turns" || match[3] !== session.turnId) return new Response("unknown synthetic turn", { status: 404 })
            return json({ data: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: session.text }] }] })
          }
          if (match[2] === "events" && request.method === "POST") return json({ data: body.events })
          if (match[2] === "events") return events([["agent.session.turn.completed", { type: "agent.session.turn.completed", session_id: session.id, turn_id: session.turnId }]])
          if (match[2] === "turns") return json({ data: [{ id: session.turnId, status: "completed" }] })
          return json(session)
        }
      }
      if (vendor === "cursor") {
        if (path === "/v1/agents" && request.method === "POST") {
          const id = body.agentId || `bc-synthetic-${++sequence}`
          if (sessions.has(id)) return new Response(JSON.stringify({ error: "agent_id_conflict" }), { status: 409 })
          const agent = { id, status: "IDLE", url: `${url.origin}/cursor/agents/${id}` }
          const run = { id: `run-${++sequence}`, status: "FINISHED", result: "Synthetic Cursor answer", git: { branches: [] } }
          sessions.set(id, { agent, run })
          return json({ agent, run })
        }
        const match = /^\/v1\/agents\/([^/]+)(?:\/runs(?:\/([^/]+)(?:\/(stream|cancel))?)?)?$/.exec(path)
        const session = match && sessions.get(match[1])
        if (session) {
          if (match[3] === "cancel") return json({ status: "CANCELLED" })
          if (match[3] === "stream") return events([["status", { status: "RUNNING" }], ["result", { result: session.run.result }], ["done", { status: "FINISHED" }]])
          if (path.endsWith("/runs") && request.method === "POST") { session.run = { ...session.run, id: `run-${++sequence}` }; return json({ run: session.run }) }
          return json(match[2] ? session.run : session)
        }
      }
      if (vendor === "devin") {
        if (path === "/v1/sessions" && request.method === "POST") {
          const session_id = `devin-${++sequence}`
          const session = { session_id, url: `${url.origin}/devin/sessions/${session_id}`, is_new_session: true, status_enum: "finished", status: "Finished", messages: [{ type: "agent_message", message: "Synthetic Devin answer" }] }
          sessions.set(session_id, session)
          return json(session)
        }
        const match = /^\/v1\/sessions\/([^/]+)(?:\/(message))?$/.exec(path)
        const session = match && sessions.get(match[1])
        if (session) return json(match[2] ? { detail: null } : session)
      }
      // Codex Cloud has a CLI contract; this local endpoint supplies synthetic CLI output only.
      if (vendor === "codex" && path === "/cloud/exec" && request.method === "POST") {
        const ref = `task_synthetic_${++sequence}`
        sessions.set(ref, { ref })
        return json({ stdout: `Created ${ref}`, code: 0, ref })
      }
      const codex = vendor === "codex" && /^\/cloud\/(status|diff)\/(.+)$/.exec(path)
      if (codex && sessions.has(codex[2])) return json({ stdout: codex[1] === "status" ? "Task completed successfully" : "diff --git a/example b/example\n+Synthetic Codex change", code: 0 })
      return new Response("unknown synthetic route", { status: 404 })
    },
  })
  return { url: server.url.origin, requests, sessions, stop: () => server.stop(true) }
}

export async function selfTest() {
  const server = startFakeCloud()
  const get = async path => {
    const response = await fetch(server.url + path)
    assert.equal(response.status, 200)
    return response.json()
  }
  const post = async (path, body) => {
    const response = await fetch(server.url + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    assert.equal(response.status, 200)
    return response.json()
  }
  try {
    const openai = await post("/openai/v1/agents/sessions", { agent: { model: "gpt-6-astra" }, input: [{ role: "user", content: [{ type: "input_text", text: "Synthetic request" }] }] })
    assert.match(await (await fetch(`${server.url}/openai/v1/agents/sessions/${openai.id}/events`)).text(), /agent.session.turn.completed/)
    const turn = (await get(`/openai/v1/agents/sessions/${openai.id}/turns`)).data[0]
    assert.match((await get(`/openai/v1/agents/sessions/${openai.id}/turns/${turn.id}/items`)).data[0].content[0].text, /OpenAI answer/)
    const cursor = await post("/cursor/v1/agents", { prompt: { text: "Synthetic request" }, model: { id: "composer-2" } })
    assert.match((await get(`/cursor/v1/agents/${cursor.agent.id}/runs/${cursor.run.id}`)).result, /Cursor answer/)
    const devin = await post("/devin/v1/sessions", { prompt: "Synthetic request" })
    assert.equal((await get(`/devin/v1/sessions/${devin.session_id}`)).status_enum, "finished")
    const codex = await post("/codex/cloud/exec", { prompt: "Synthetic request", env: "env_synthetic" })
    assert.match((await get(`/codex/cloud/status/${codex.ref}`)).stdout, /completed/)
    assert.match((await get(`/codex/cloud/diff/${codex.ref}`)).stdout, /Synthetic Codex change/)
    console.log("4 vendor happy paths passed (OpenAI, Cursor, Devin, Codex CLI fixtures)")
  } finally { server.stop() }
}

if (import.meta.main) {
  if (process.argv.includes("--self-test")) await selfTest()
  else {
    const server = startFakeCloud({ port: Number(process.env.PORT || 8799) })
    console.log(`Synthetic cloud server listening at ${server.url}`)
  }
}
