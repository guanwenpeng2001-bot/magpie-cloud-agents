// Behavioral pins for the OAuth clauses scripts/check.mjs enforces under --stubs.
//
// Each test builds a temporary fixture tree with a fixed provider roster and
// matching EXPECTED membership, independent of new production providers.
// It replaces selected provider modules and runs the repository's gate copy
// against the fixture, asserting the gate's exit status and message. The gate
// reads its own location, so the copy of scripts/check.mjs inside the fixture
// tree is the gate under test; deleting a clause from it changes what these
// tests observe. A lying provider must be rejected by the clause named in the
// test, and each fixture is shaped so that the clause it pins is the one thing
// standing between the provider and a green run.
//
// Fixtures replace codex-cloud (id, display name and models are kept) so no
// real vendor CLI, sign-in, network call or credential is ever reached: the
// gate's own sentinels block every covered operation, and PATH is poisoned for
// the gate process. No test writes into the repository.

import { describe, test, expect, afterEach } from "bun:test"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))
const fixtureDirs = []
const fixturePlugins = {
  CodexCloudPlugin: ["codex-cloud", "makeCodexCloud", "options ?? {}"],
  CodexAgentsPlugin: ["codex-agents", "makeCodexAgents", "options ?? {}"],
  CursorCloudPlugin: ["cursor-cloud", "makeCursorCloud", "options ?? {}"],
  DevinCloudPlugin: ["devin-cloud", "makeDevinCloud", "options ?? {}"],
  GrokBotPlugin: ["grok-bot", "makeGrokBotDriver", "input, options ?? {}"],
}

const GATE_ENV = {
  ...process.env,
  PATH: "Z:\\missing",
  ProgramFiles: "Z:\\missing",
  LOCALAPPDATA: "Z:\\missing",
}

async function buildFixtureTree(replacements) {
  const dir = await mkdtemp(join(tmpdir(), "gate-clause-pin-"))
  fixtureDirs.push(dir)
  await writeFile(join(dir, "index.mjs"), Object.entries(fixturePlugins).map(([plugin, [id, factory, args]]) =>
    `import { ${factory} } from "./providers/${id}.mjs"\nexport async function ${plugin}(input, options) { return ${factory}(${args}) }`,
  ).join("\n"))
  await cp(join(repoRoot, "package.json"), join(dir, "package.json"))
  await cp(join(repoRoot, "lib"), join(dir, "lib"), { recursive: true })
  await mkdir(join(dir, "providers"))
  for (const id of [...Object.values(fixturePlugins).map(([id]) => id), "grok-bot-cdp", "grok-bot-direct", "grok-bot-token"])
    await cp(join(repoRoot, "providers", `${id}.mjs`), join(dir, "providers", `${id}.mjs`))
  await mkdir(join(dir, "scripts"))
  const gate = await readFile(join(repoRoot, "scripts/check.mjs"), "utf8")
  const importBoundary = 'const mod = await import(pathToFileURL(join(root, "index.mjs")).href)'
  if (gate.split(importBoundary).length !== 2) throw new Error("gate fixture import boundary changed")
  const retainFixturePlugins = `for (const key of Object.keys(EXPECTED)) if (!${JSON.stringify(Object.keys(fixturePlugins))}.includes(key)) delete EXPECTED[key]`
  await writeFile(join(dir, "scripts/check.mjs"), gate.replace(importBoundary, `${retainFixturePlugins}\n${importBoundary}`))
  for (const [relativePath, content] of Object.entries(replacements))
    await writeFile(join(dir, relativePath), content)
  return dir
}

function runGate(dir) {
  const result = spawnSync(process.execPath, ["scripts/check.mjs", "--stubs"], {
    cwd: dir,
    encoding: "utf8",
    env: GATE_ENV,
    timeout: 120_000,
  })
  return { status: result.status, output: (result.stdout ?? "") + (result.stderr ?? "") }
}

// A full codex-cloud replacement that keeps the real id, display name and
// models but takes its sandbox transport, OAuth outcome and loader behavior
// from BEHAVIOR, so each fixture isolates exactly one gate clause.
function codexCloudStubSource(behavior) {
  return `const ID = "codex-cloud"
const NAME = "Codex Cloud (codex CLI)"
const CHAT = "@ai-sdk/openai-compatible"
const BASE = "https://codex-cloud.cloud-agents.invalid/v1"
const MODELS = { "cloud-task": { name: "Codex Cloud task", tool_call: false } }
const BEHAVIOR = ${JSON.stringify(behavior)}

const errorResponse = ({ status, message, signIn = "kept" }) =>
  new Response(JSON.stringify({ error: { message, type: "cloud_agent_error", code: status } }), {
    status,
    headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": signIn },
  })

const SCAFFOLD_MESSAGE = NAME + " transport not implemented yet — the " + ID + " provider is a scaffold stub"
const SHARED_400_MESSAGE = "a request that isn't JSON or has no valid messages array"

async function stubTransport(input, getAuth) {
  const now = await getAuth()
  if (now?.type !== "oauth") return errorResponse({ status: 401, message: NAME + " isn't signed in — magpie plugin login " + ID, signIn: "expired" })
  const body = await input.clone().json().catch(() => null)
  const wellFormed = body != null && Array.isArray(body.messages)
  if (BEHAVIOR.transport === "shared400") return errorResponse({ status: 400, message: SHARED_400_MESSAGE })
  if (BEHAVIOR.transport === "scaffold501") return errorResponse({ status: 501, message: SCAFFOLD_MESSAGE })
  if (BEHAVIOR.transport === "scaffoldThenOk") {
    if (!wellFormed) return errorResponse({ status: 501, message: SCAFFOLD_MESSAGE })
    return Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "answered" }, finish_reason: "stop" }] })
  }
  if (!wellFormed) return errorResponse({ status: 400, message: SHARED_400_MESSAGE })
  return Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "answered" }, finish_reason: "stop" }] })
}

function stubAuthorize() {
  if (BEHAVIOR.authorize === "claimsSuccess") {
    return { url: "", instructions: NAME, method: "auto", callback: async () => ({ type: "success", access: "sandbox" }) }
  }
  if (BEHAVIOR.authorize === "invalidOutcome") {
    return { url: "", instructions: NAME, method: "auto", callback: async () => ({ type: "degraded", error: NAME + " reported an outcome that is neither failed nor success" }) }
  }
  if (BEHAVIOR.authorize === "attemptsOperation") {
    return {
      url: "",
      instructions: NAME,
      method: "auto",
      callback: async () => {
        try { await fetch("https://sentinel-blocked.invalid") } catch {}
        return { type: "failed", error: NAME + " transport not implemented yet" }
      },
    }
  }
  return { url: "", instructions: NAME + " transport not implemented yet; sign-in is unavailable in this scaffold.", method: "auto", callback: async () => ({ type: "failed", error: NAME + " transport not implemented yet" }) }
}

export function makeCodexCloud(options = {}) {
  return {
    auth: {
      provider: ID,
      async loader(getAuth) {
        const auth = await getAuth()
        if (BEHAVIOR.loader === "refuseAll") return {}
        if (auth?.type !== "oauth") return {}
        return { baseURL: BASE, fetch: (input, init = {}) => stubTransport(input, getAuth) }
      },
      methods: [{ type: "oauth", label: "fixture OAuth method", authorize: stubAuthorize }],
    },
    async config(config) {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      config.provider[ID] = { name: NAME, npm: CHAT, api: BASE, ...was, models: { ...MODELS, ...(was.models ?? {}) } }
    },
    provider: { id: ID, async models(provider) { return provider.models } },
  }
}
`
}

// A full grok-bot replacement that passes every implemented-driver contract the
// gate checks (missing-install, signed-out loader, transport error contract,
// transport isolation) but returns a malformed flow shape from its first OAuth
// method when the gate probes it with { env: "sandbox" } — the exact shape the
// gate's method-shape loop exists to catch.
function grokBotStubSource() {
  return `const ID = "grok-bot"
const NAME = "Grok Bot (xAI desktop)"
const BASE = "https://grok-bot.cloud-agents.invalid/v1"
const MODELS = { "app-bot": { name: "App bot (the currently selected bot)", tool_call: false } }
const MISSING_INSTALL_ERROR = "Grok Bot desktop isn't installed — install it from xAI and sign in once, then retry"

const errorResponse = ({ status, message, signIn = "kept" }) =>
  new Response(JSON.stringify({ error: { message, type: "cloud_agent_error", code: status } }), {
    status,
    headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": signIn },
  })

const failedFlow = () => ({ url: "", instructions: NAME, method: "auto", callback: async () => ({ type: "failed", error: MISSING_INSTALL_ERROR }) })

export function makeGrokBotDriver(input, options = {}, dependencies = {}) {
  return {
    auth: {
      provider: ID,
      methods: [
        {
          type: "oauth",
          label: "fixture app sign-in",
          authorize: (args) => (args?.env === "sandbox" ? { method: "not-auto", callback: async () => ({ type: "failed", error: MISSING_INSTALL_ERROR }) } : failedFlow()),
        },
        { type: "oauth", label: "fixture direct sign-in", authorize: () => failedFlow() },
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "oauth" || !auth.access) return {}
        return { baseURL: BASE, fetch: async () => errorResponse({ status: 502, message: MISSING_INSTALL_ERROR }) }
      },
    },
    async config(config) {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      config.provider[ID] = { name: NAME, npm: "@ai-sdk/openai-compatible", api: BASE, ...was, models: { ...MODELS, ...(was.models ?? {}) } }
    },
    provider: { id: ID, async models(provider) { return provider.models } },
  }
}
`
}

afterEach(async () => {
  while (fixtureDirs.length) await rm(fixtureDirs.pop(), { recursive: true, force: true })
})

describe("gate clause pins (scripts/check.mjs --stubs)", () => {
  test("scaffold-classified provider claiming OAuth success is rejected: stub claims successful authorization", async () => {
    const dir = await buildFixtureTree({
      "providers/codex-cloud.mjs": codexCloudStubSource({ transport: "scaffoldThenOk", authorize: "claimsSuccess" }),
    })
    const { status, output } = runGate(dir)
    expect(status).not.toBe(0)
    expect(output).toContain("sandbox: codex-cloud; scaffold")
    expect(output).toContain("CodexCloudPlugin: Error: stub claims successful authorization")
  })

  test("OAuth outcome that is neither failed nor success is rejected: invalid OAuth outcome", async () => {
    const dir = await buildFixtureTree({
      "providers/codex-cloud.mjs": codexCloudStubSource({ transport: "shared400", authorize: "invalidOutcome" }),
    })
    const { status, output } = runGate(dir)
    expect(status).not.toBe(0)
    expect(output).toContain("sandbox: codex-cloud; invalid request refused")
    expect(output).toContain("CodexCloudPlugin: Error: invalid OAuth outcome")
  })

  test("success claim whose loader refuses the credential it produced is rejected: authorization success has no transport", async () => {
    const dir = await buildFixtureTree({
      "providers/codex-cloud.mjs": codexCloudStubSource({ transport: "shared400", authorize: "claimsSuccess", loader: "refuseAll" }),
    })
    const { status, output } = runGate(dir)
    expect(status).not.toBe(0)
    expect(output).toContain("CodexCloudPlugin: Error: authorization success has no transport")
  })

  test("success claim answered by the shared 400 refusal is rejected: authorization success is unsupported by transport", async () => {
    const dir = await buildFixtureTree({
      "providers/codex-cloud.mjs": codexCloudStubSource({ transport: "shared400", authorize: "claimsSuccess" }),
    })
    const { status, output } = runGate(dir)
    expect(status).not.toBe(0)
    expect(output).toContain("sandbox: codex-cloud; invalid request refused")
    expect(output).toContain("CodexCloudPlugin: Error: authorization success is unsupported by transport")
  })

  test("non-scaffold authorize-region attempt is reported in the summary line and is not fatal", async () => {
    const dir = await buildFixtureTree({
      "providers/codex-cloud.mjs": codexCloudStubSource({ transport: "shared400", authorize: "attemptsOperation" }),
    })
    const { status, output } = runGate(dir)
    expect(status).toBe(0)
    expect(output).toContain("sandbox: codex-cloud; invalid request refused")
    expect(output).toContain("authorization: codex-cloud; failed")
    expect(output).toContain("sandbox summary: transport attempts: 0; authorization attempts blocked: 1")
    expect(output).not.toContain("sandbox isolation failed")
  })

  test("authorization probe exemption does not leak into a later API provider's transport", async () => {
    const dir = await buildFixtureTree({
      "providers/codex-cloud.mjs": codexCloudStubSource({ transport: "shared400", authorize: "attemptsOperation" }),
      "providers/cursor-cloud.mjs": `export function makeCursorCloud() {
  return {
    auth: {
      provider: "cursor-cloud",
      methods: [{ type: "api", label: "fixture API key" }],
      async loader() {
        return {
          baseURL: "https://cursor-cloud.cloud-agents.invalid/v1",
          async fetch() {
            try { await globalThis.fetch("https://sentinel-blocked.invalid") } catch {}
            return new Response(JSON.stringify({ error: {
              message: "a request that isn't JSON or has no valid messages array",
              type: "cloud_agent_error", code: 400,
            } }), { status: 400, headers: { "X-Magpie-Sign-In": "kept" } })
          },
        }
      },
    },
    async config(config) {
      config.provider["cursor-cloud"] = {
        name: "Cursor Cloud Agents", npm: "@ai-sdk/openai-compatible",
        models: {
          "composer-2": { name: "Composer 2", tool_call: false },
          "claude-sonnet-4-5": { name: "Claude Sonnet 4.5", tool_call: false },
        },
      }
    },
  }
}
`,
    })
    const { status, output } = runGate(dir)
    expect(status).not.toBe(0)
    expect(output).toContain("authorization: codex-cloud; failed")
    expect(output).toContain("sandbox: cursor-cloud; invalid request refused")
    expect(output).toContain("sandbox summary: transport attempts: 2; authorization attempts blocked: 1")
    expect(output).toContain("sandbox isolation failed: 2 external operations")
  })

  test("scaffold-classified authorize-region attempt stays fatal", async () => {
    const dir = await buildFixtureTree({
      "providers/codex-cloud.mjs": codexCloudStubSource({ transport: "scaffold501", authorize: "attemptsOperation" }),
    })
    const { status, output } = runGate(dir)
    expect(status).not.toBe(0)
    expect(output).toContain("sandbox: codex-cloud; scaffold")
    expect(output).toContain("sandbox isolation failed: 1 external operations")
  })

  test("grok-bot OAuth methods must keep their sandbox shape: malformed OAuth flow", async () => {
    const dir = await buildFixtureTree({
      "providers/grok-bot.mjs": grokBotStubSource(),
    })
    const { status, output } = runGate(dir)
    expect(status).not.toBe(0)
    expect(output).toContain("GrokBotPlugin: Error: malformed OAuth flow")
  })

  test("control: a corroborated success claim is accepted", async () => {
    const dir = await buildFixtureTree({
      "providers/codex-cloud.mjs": codexCloudStubSource({ transport: "realistic", authorize: "claimsSuccess" }),
    })
    const { status, output } = runGate(dir)
    expect(status).toBe(0)
    expect(output).toContain("sandbox: codex-cloud; invalid request refused")
    expect(output).toContain("authorization: codex-cloud; success")
    expect(output).toContain("sandbox summary: transport attempts: 0; authorization attempts blocked: 0")
    expect(output).toContain("✓ magpie-cloud-agents")
  })
})
