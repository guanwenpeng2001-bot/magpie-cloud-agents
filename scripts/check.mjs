// Shape gate for magpie-cloud-agents. Loads index.mjs exactly as the host
// does and checks the shape of what each plugin function returns: the
// assertions the community gate enforces (auth.provider, auth.loader,
// non-empty auth.methods with authorize on every oauth entry, config
// producing npm + non-empty models) plus, for this package, the six
// expected provider ids with their display names and static models, and
// the no-helper-export rule (S1: an exported helper is invoked as a plugin
// and its throw poisons the load — internals hang off `_internal`).
// It signs in to nothing and sends no request.

import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const EXPECTED = {
  CodexCloudPlugin: {
    id: "codex-cloud",
    name: "Codex Cloud (codex CLI)",
    models: { "cloud-task": "Codex Cloud task" },
  },
  CodexAgentsPlugin: {
    id: "codex-agents",
    name: "Codex Agents API",
    models: { "gpt-6-astra": "GPT-6 Astra" },
  },
  CursorCloudPlugin: {
    id: "cursor-cloud",
    name: "Cursor Cloud Agents",
    models: { "composer-2": "Composer 2", "claude-sonnet-4-5": "Claude Sonnet 4.5" },
  },
  DevinCloudPlugin: {
    id: "devin-cloud",
    name: "Devin Cloud",
    models: { "devin-session": "Devin session" },
  },
  DotsPlugin: {
    id: "dots",
    name: "ChatGPT Dot",
    models: { dot: "ChatGPT Dot (replies in minutes)" },
  },
  GrokBotPlugin: {
    id: "grok-bot",
    name: "Grok Bot (xAI desktop)",
    models: { "app-bot": "App bot (the currently selected bot)" },
  },
}

const root = fileURLToPath(new URL("..", import.meta.url))
const problems = []

const mod = await import(pathToFileURL(join(root, "index.mjs")).href)

for (const key of Object.keys(EXPECTED))
  if (typeof mod[key] !== "function") problems.push(`missing plugin function export: ${key}`)
for (const key of Object.keys(mod)) {
  if (key === "_internal") {
    if (typeof mod._internal === "function") problems.push("_internal is a function — exported helpers are invoked as plugins")
    continue
  }
  if (!(key in EXPECTED)) problems.push(`unexpected export: ${key} (every exported function is invoked as a plugin — helpers belong under _internal)`)
}

const ids = []
const client = {
  app: { log: async () => {} },
  auth: { set: async () => {} },
  tui: { showToast: async () => {} },
  config: { get: async () => ({ data: {} }) },
}

for (const [fnName, fn] of Object.entries(mod)) {
  if (typeof fn !== "function") continue
  const want = EXPECTED[fnName]
  try {
    const hooks = await fn({ client, directory: process.cwd(), worktree: process.cwd(), $: undefined, project: {} })
    const auth = hooks?.auth
    if (!auth) {
      problems.push(`${fnName}: no auth hook`)
      continue
    }
    if (typeof auth.provider !== "string" || !auth.provider) problems.push(`${fnName}: auth.provider`)
    else if (want && auth.provider !== want.id) problems.push(`${fnName}: auth.provider is ${auth.provider}, expected ${want.id}`)
    else ids.push(auth.provider)
    if (typeof auth.loader !== "function") problems.push(`${fnName}: auth.loader`)
    if (!Array.isArray(auth.methods) || !auth.methods.length) problems.push(`${fnName}: auth.methods`)
    for (const m of auth.methods ?? []) {
      if (!["oauth", "api"].includes(m.type)) problems.push(`${fnName}: method type ${m.type}`)
      if (m.type === "oauth" && typeof m.authorize !== "function") problems.push(`${fnName}: ${m.label} has no authorize`)
    }
    if (process.argv.includes("--stubs")) {
      for (const method of auth.methods) {
        if (method.type !== "oauth") continue
        const flow = await method.authorize({ env: "sandbox" })
        if (flow.method !== "auto" || typeof flow.callback !== "function") throw new Error("malformed OAuth flow")
        if ((await flow.callback()).type !== "failed") throw new Error("stub claims successful authorization")
      }
      const credential = auth.methods[0].type === "api" ? { type: "api", key: "sandbox-only" } : { type: "oauth", env: "sandbox" }
      const loader = await auth.loader(async () => credential)
      for (const stream of [false, true]) {
        const response = await loader.fetch(new Request(loader.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ messages: [], stream }) }))
        const answer = await response.json()
        if (response.status !== 501 || !answer.error.message.includes(auth.provider) || !answer.error.message.includes("transport not implemented yet")) throw new Error("invalid stub response")
      }
    }
    if (!hooks.config) {
      problems.push(`${fnName}: no config hook`)
      continue
    }
    const cfg = { provider: {} }
    await hooks.config(cfg)
    const p = cfg.provider[auth.provider]
    if (!p) problems.push(`${fnName}: config adds no ${auth.provider} provider`)
    else {
      if (!p.npm) problems.push(`${fnName}: config gives ${auth.provider} no npm`)
      if (want && p.name !== want.name) problems.push(`${fnName}: display name ${p.name}, expected ${want.name}`)
      if (!p.models || !Object.keys(p.models).length) problems.push(`${fnName}: config gives ${auth.provider} no models`)
      else if (want)
        for (const [modelId, modelName] of Object.entries(want.models)) {
          const m = p.models[modelId]
          if (!m) problems.push(`${fnName}: ${auth.provider} is missing model ${modelId}`)
          else {
            if (m.name !== modelName) problems.push(`${fnName}: model ${modelId} is named ${m.name}, expected ${modelName}`)
            if (m.tool_call !== false) problems.push(`${fnName}: model ${modelId} must declare tool_call: false (prose answers only)`)
          }
        }
    }
  } catch (e) {
    problems.push(`${fnName}: ${e?.stack ?? e}`)
  }
}

const missingIds = Object.values(EXPECTED)
  .map((w) => w.id)
  .filter((id) => !ids.includes(id))
if (missingIds.length) problems.push(`provider ids missing: ${missingIds.join(", ")}`)

if (problems.length) {
  console.error(`✗ magpie-cloud-agents\n  ${problems.join("\n  ")}`)
  process.exit(1)
}
console.log(`✓ magpie-cloud-agents (${ids.length} providers: ${ids.join(", ")})`)
