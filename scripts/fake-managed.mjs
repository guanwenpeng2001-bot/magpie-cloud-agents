// Loopback fake for the managed-agents API family (Qoder wire shape: no /v1
// prefix, page pagination, after_id event listing, SSE tail).
// State machine per session: created -> running -> (tool_use -> waiting result -> running)* -> idle(end_turn).
export function startFakeManaged({ prefix = "", vendor = "qoder", scenario = null } = {}) {
  const requests = []
  const agents = new Map()
  const environments = new Map()
  const sessions = new Map()
  let serial = 0
  const id = kind => `${kind}_${vendor}_${++serial}`
  const page = rows => ({ data: rows, has_more: false, next_page: null, first_id: rows[0]?.id ?? null, last_id: rows.at(-1)?.id ?? null })

  function seed(session, prompt) {
    session.events.push({ id: id("evt"), type: "user.message", content: [{ type: "text", text: prompt }], processed_at: new Date().toISOString() })
    session.events.push({ id: id("evt"), type: "session.status_running", processed_at: new Date().toISOString() })
    if (session.selfHosted) {
      session.pendingTool = { id: id("evt"), type: "agent.tool_use", name: "Bash", input: { command: "echo fake-tool-output" }, processed_at: new Date().toISOString() }
      session.events.push(session.pendingTool)
      session.events.push({ id: id("evt"), type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: [session.pendingTool.id] }, processed_at: new Date().toISOString() })
      session.status = "idle"
    } else {
      finish(session)
    }
  }
  function finish(session) {
    session.events.push({ id: id("evt"), type: "agent.message", content: [{ type: "text", text: `fake ${vendor} answer to: ${session.prompt.slice(0, 40)}` }], processed_at: new Date().toISOString() })
    session.events.push({ id: id("evt"), type: "session.status_idle", stop_reason: { type: "end_turn" }, processed_at: new Date().toISOString() })
    session.status = "idle"
  }

  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url)
      if (!url.pathname.startsWith(prefix + "/")) return new Response("not found", { status: 404 })
      let path = url.pathname.slice(prefix.length)
      const body = ["POST", "PUT"].includes(request.method) ? await request.json().catch(() => null) : null
      requests.push({ method: request.method, path, query: Object.fromEntries(url.searchParams), body, auth: request.headers.get("authorization") ?? request.headers.get("x-api-key") })
      if (scenario) {
        const custom = await scenario({ request, url, path, body, sessions, agents, environments, requests, page, id, finish })
        if (custom) return custom
      }
      const json = value => Response.json(value)
      if (path === "/models" && request.method === "GET") return json(page([{ id: "ultimate", type: "model", display_name: "Ultimate", is_enabled: true }, { id: "claude-sonnet-4-5", type: "model", display_name: "Claude Sonnet 4.5" }]))
      if (path === "/agents" && request.method === "GET") return json(page([...agents.values()]))
      if (path === "/agents" && request.method === "POST") {
        const agent = { id: id("agent"), type: "agent", name: body.name, model: body.model, tools: body.tools, version: 1, archived_at: null }
        agents.set(agent.id, agent)
        return json(agent)
      }
      if (path === "/environments" && request.method === "GET") return json(page([...environments.values()]))
      if (path === "/environments" && request.method === "POST") {
        const environment = { id: id("env"), type: "environment", name: body.name, config: body.config, archived_at: null }
        environments.set(environment.id, environment)
        return json(environment)
      }
      if (path === "/sessions" && request.method === "POST") {
        const prompt = body.initial_events?.[0]?.content?.[0]?.text ?? ""
        const session = { id: id("sess"), type: "session", status: "running", agent: body.agent, environment_id: body.environment_id, title: body.title, prompt, events: [], selfHosted: environments.get(body.environment_id)?.config?.type === "self_hosted", usage: { input_tokens: 10, output_tokens: 20 } }
        sessions.set(session.id, session)
        seed(session, prompt)
        return json({ ...session, events: undefined, prompt: undefined })
      }
      const match = path.match(/^\/sessions\/([^/]+)(\/events(\/stream)?|\/cancel)?$/)
      if (!match) return new Response("not found", { status: 404 })
      const session = sessions.get(match[1])
      if (!session) return json({ error: { message: "no such session" } }, { status: 404 })
      if (match[2] === "/cancel" && request.method === "POST") {
        session.status = "terminated"
        session.events.push({ id: id("evt"), type: "session.status_terminated", processed_at: new Date().toISOString() })
        return json({ id: session.id, status: "terminated" })
      }
      if (match[2] === "/events/stream") {
        const lastId = url.searchParams.get("last_event_id") ?? request.headers.get("last-event-id")
        let rows = session.events
        if (vendor === "qoder" && lastId) rows = rows.slice(rows.findIndex(event => event.id === lastId) + 1)
        const frames = rows.map(event => `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("") + "event: done\ndata: {}\n\n"
        return new Response(frames, { headers: { "content-type": "text/event-stream" } })
      }
      if (match[2] === "/events" && request.method === "GET") {
        let rows = session.events
        const after = url.searchParams.get("after_id")
        if (after) rows = rows.slice(rows.findIndex(event => event.id === after) + 1)
        return json(page(rows))
      }
      if (match[2] === "/events" && request.method === "POST") {
        const accepted = []
        for (const event of body.events ?? []) {
          const stored = { ...event, id: id("evt"), processed_at: new Date().toISOString() }
          session.events.push(stored)
          accepted.push(stored)
          if (event.type === "user.tool_result" && session.pendingTool?.id === event.tool_use_id) {
            session.toolResults = [...(session.toolResults ?? []), event]
            session.pendingTool = null
            session.events.push({ id: id("evt"), type: "session.status_running", processed_at: new Date().toISOString() })
            finish(session)
          }
          if (event.type === "user.message") {
            session.prompt = event.content?.[0]?.text ?? session.prompt
            session.status = "running"
            session.events.push({ id: id("evt"), type: "session.status_running", processed_at: new Date().toISOString() })
            finish(session)
          }
          if (event.type === "user.interrupt") {
            session.status = "idle"
            session.events.push({ id: id("evt"), type: "session.status_idle", stop_reason: { type: "cancelled" }, processed_at: new Date().toISOString() })
          }
        }
        return json({ data: accepted })
      }
      if (!match[2] && request.method === "GET") return json({ ...session, events: undefined, prompt: undefined })
      return new Response("not found", { status: 404 })
    },
  })
  return { url: server.url.origin + prefix, requests, sessions, agents, environments, stop: () => server.stop(true) }
}

if (import.meta.main) {
  const qoder = startFakeManaged({ prefix: "/qoder" })
  console.log(`qoder fake: ${qoder.url}`)
  await new Promise(() => {})
}