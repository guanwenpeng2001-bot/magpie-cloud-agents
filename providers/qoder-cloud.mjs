// Qoder Cloud Agents provider — uses the official qca-sdk ManagedClient.
// Cloud mode: model + Qoder-hosted sandbox. Self-hosted mode (opt-in via
// options.qoderCloud.selfHosted): model in Qoder cloud, tools executed locally.
import { ManagedClient } from "qca-sdk/managed"
import { managedPlugin, SELF_HOSTED_TOOLS } from "../lib/managed-agents.mjs"
import { executeLocalTool } from "../lib/self-hosted-tools.mjs"

const ID = "qoder-cloud"
const NAME = "Qoder Cloud Agents"
const BASE = "https://qoder-cloud.cloud-agents.invalid/v1"
const MODELS = {
  ultimate: { name: "Qoder Ultimate", tool_call: false, reasoning: false },
  auto: { name: "Qoder Auto", tool_call: false, reasoning: false },
}
const METHODS = [{ type: "api", label: "Qoder PAT", placeholder: "Qoder personal access token (qoder.com → settings → PAT)" }]
const AGENT_NAME = "magpie-cloud-agents"
const ENV_NAME = "magpie-cloud-agents"

const toolset = selfHosted => ({
  type: "agent_toolset_20260401",
  default_config: { enabled: true, permission_policy: { type: "always_allow" } },
  // Qoder's REST API expects capitalized enabled_tools names (per vendor docs).
  ...(selfHosted ? { enabled_tools: (selfHosted.tools ?? SELF_HOSTED_TOOLS).map(tool => tool[0].toUpperCase() + tool.slice(1).toLowerCase()) } : {}),
})

async function findByName(list, name) {
  for await (const item of list) if (item?.name === name && !item.archived_at) return item
  return null
}

export const vendor = {
  id: ID, name: NAME, models: MODELS, methods: METHODS, fakeBase: BASE, optionKey: "qoderCloud",
  client(cred, options) {
    return new ManagedClient({ pat: cred.key, baseURL: options.apiBase?.[ID] ?? "https://api.qoder.com/api/v1/cloud", maxRetries: 1, timeout: 60000 })
  },
  async ensureAgent(client, model, selfHosted, signal) {
    const name = AGENT_NAME + ":" + model + (selfHosted ? ":self-hosted" : "")
    const existing = await findByName(client.agents.list({}, { signal }), name)
    if (existing) return existing.id
    const agent = await client.agents.create({ name, model, tools: [toolset(selfHosted)] }, { signal })
    return agent.id
  },
  async ensureEnvironment(client, selfHosted, signal) {
    const name = ENV_NAME + (selfHosted ? ":self-hosted" : ":cloud")
    const existing = await findByName(client.environments.list({}, { signal }), name)
    if (existing) return existing.id
    const config = selfHosted ? { type: "self_hosted" } : { type: "cloud", networking: { type: "unrestricted" } }
    const environment = await client.environments.create({ name, config }, { signal })
    return environment.id
  },
  async createSession(client, { agentId, environmentId, prompt, identity }, signal) {
    const session = await client.sessions.create({
      agent: { type: "agent", id: agentId },
      environment_id: environmentId,
      title: "magpie: " + (identity?.sessionKey ?? "chat").slice(0, 60),
      initial_events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }],
    }, { signal })
    return session
  },
  getSession(client, ref, signal) { return client.sessions.retrieve(ref, undefined, { signal }) },
  sendEvents(client, ref, events, signal) { return client.sessions.events.send(ref, { events }, { signal }) },
  async listEvents(client, ref, after, signal) {
    const page = await client.sessions.events.list(ref, { order: "asc", limit: 100, ...(after ? { after_id: after } : {}) }, { signal })
    return page.data
  },
  streamEvents(client, ref, cursor, signal) {
    return client.sessions.events.resumableStream(ref, { ...(cursor ? { last_event_id: cursor } : {}), event_deltas: ["agent.message"] }, { signal })
  },
  async runLocalTool(client, run, event, selfHosted, signal) {
    const result = await executeLocalTool(event, selfHosted, signal)
    await client.sessions.events.send(run.ref, { events: [{ type: "user.tool_result", tool_use_id: event.id, content: [{ type: "text", text: result.text }], is_error: result.isError }] }, { signal })
  },
  cancel(client, ref) { return client.sessions.cancel(ref, undefined, { signal: AbortSignal.timeout(5000) }) },
  async liveModels(client, signal) {
    const rows = []
    for await (const model of client.models.list({}, { signal })) rows.push(model)
    const entries = rows.filter(model => model?.id && model.is_enabled !== false).map(model => [model.id, { id: model.id, name: model.display_name ?? model.id, tool_call: false, reasoning: false, capabilities: { toolcall: false, reasoning: false, attachment: false, input: { text: true }, output: { text: true } } }])
    return { ...MODELS, ...Object.fromEntries(entries) }
  },
}

export function makeQoderCloud(options = {}) {
  return managedPlugin(vendor, options)
}

export const _internal = { vendor, toolset }