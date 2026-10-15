import { afterEach, expect, spyOn, test } from "bun:test"
import * as plugins from "../index.mjs"

const entries = Object.entries(plugins).filter(([name]) => name.endsWith("Plugin"))
const originalDebug = process.env.MAGPIE_CLOUD_AGENTS_DEBUG
let output

afterEach(() => {
  output?.mockRestore()
  if (originalDebug === undefined) delete process.env.MAGPIE_CLOUD_AGENTS_DEBUG
  else process.env.MAGPIE_CLOUD_AGENTS_DEBUG = originalDebug
})

test("plugin startup rejects invalid common configuration with the option path", async () => {
  for (const [, plugin] of entries) {
    await expect(plugin({}, { maxRunMinutes: -1 })).rejects.toThrow("maxRunMinutes")
  }
})

test("default startup and startup failures are silent", async () => {
  delete process.env.MAGPIE_CLOUD_AGENTS_DEBUG
  output = spyOn(console, "error").mockImplementation(() => {})
  for (const [, plugin] of entries) await plugin({})
  await plugins.CodexCloudPlugin({}, { progress: "yes" }).catch(() => {})
  expect(output).not.toHaveBeenCalled()
})

test("debug logs startup and failure without configuration secrets", async () => {
  process.env.MAGPIE_CLOUD_AGENTS_DEBUG = "1"
  output = spyOn(console, "error").mockImplementation(() => {})
  await plugins.CodexCloudPlugin({}, {})
  await plugins.CodexCloudPlugin({}, { maxRunMinutes: "private-token" }).catch(() => {})
  const text = output.mock.calls.flat().join(" ")
  expect(text).toContain("codex-cloud")
  expect(text).toContain("startup")
  expect(text).toContain("failed")
  expect(text).not.toContain("private-token")
})

test("false debug switch stays silent", async () => {
  process.env.MAGPIE_CLOUD_AGENTS_DEBUG = "false"
  output = spyOn(console, "error").mockImplementation(() => {})
  await plugins.CodexCloudPlugin({})
  expect(output).not.toHaveBeenCalled()
})

test("invalid nested configuration fails at plugin startup", async () => {
  const cases = [
    [[], "options"],
    [{ progress: "yes" }, "progress"],
    [{ maxPromptBytes: 0 }, "maxPromptBytes"],
    [{ codexCloud: [] }, "codexCloud"],
    [{ codexCloud: { attempts: 1.5 } }, "codexCloud.attempts"],
    [{ codexCloud: { env: 123 } }, "codexCloud.env"],
    [{ apiBase: { "codex-agents": "" } }, "apiBase.codex-agents"],
    [{ codexAgents: { environment: { type: "" } } }, "codexAgents.environment.type"],
    [{ dots: { publicUrl: "  " } }, "dots.publicUrl"],
    [{ dots: { tunnelCommand: [""] } }, "dots.tunnelCommand"],
    [{ dots: { tunnelCommand: "  " } }, "dots.tunnelCommand"],
    [{ apiBase: { "codex-agents": "file:///secret" } }, "apiBase.codex-agents"],
    [{ dotsApp: { reattachPorts: [65536] } }, "dotsApp.reattachPorts"],
    [{ dots: { taskTtlMinutes: 0 } }, "dots.taskTtlMinutes"],
    [{ dots: { publicUrl: "invalid" } }, "dots.publicUrl"],
    [{ dots: { publicUrl: "http://localhost" } }, "dots.publicUrl"],
    [{ dots: { tunnelCommand: [] } }, "dots.tunnelCommand"],
    [{ cursorCloud: { repos: "repo" } }, "cursorCloud.repos"],
    [{ grokBot: { ghostMode: "false" } }, "grokBot.ghostMode"],
    [{ devinCloud: { maxAcuLimit: -1 } }, "devinCloud.maxAcuLimit"],
    [{ codexAgents: { environment: {} } }, "codexAgents.environment.type"],
  ]
  for (const [options, path] of cases) await expect(plugins.CodexCloudPlugin({}, options)).rejects.toThrow(path)
})

test("zero wait and idle durations load all six providers", async () => {
  for (const section of ["dotsApp", "grokBot"]) {
    for (const key of ["keepAliveMinutes", "launchTimeoutMs", ...(section === "dotsApp" ? ["appBootMs", "surfaceTimeoutMs", "stableMs"] : [])]) {
      for (const [, plugin] of entries) expect(await plugin({}, { [section]: { [key]: 0 } })).toHaveProperty("auth")
    }
  }
})

test("cleared optional fields load all six providers", async () => {
  for (const options of [
    { devinCloud: { maxAcuLimit: null } }, { codexCloud: { env: "" } },
    { codexCloud: { attempts: null } }, { dotsApp: { reattachPorts: null } },
    { progress: null }, { dotsApp: null },
  ]) for (const [, plugin] of entries) expect(await plugin({}, options)).toHaveProperty("auth")
})

test.each(["", "  ", "\t\n", " "])("environment discovery accepts blank string %p", async env => {
  for (const [, plugin] of entries) expect(await plugin({}, { codexCloud: { env } })).toHaveProperty("auth")
})

test.each(["publicUrl", "tunnelCommand"])("empty %s selects the default tunnel configuration", async key => {
  for (const value of ["", null, undefined, false, 0]) {
    for (const options of [{ dots: { [key]: value } }, { [key]: value }]) {
      for (const [, plugin] of entries) expect(await plugin({}, options)).toHaveProperty("auth")
    }
  }
})

test("zero streaming interval remains invalid", async () => {
  for (const [, plugin] of entries) await expect(plugin({}, { dotsApp: { streamIntervalMs: 0 } })).rejects.toThrow("dotsApp.streamIntervalMs")
})

test("logging failures preserve startup and the original configuration error", async () => {
  process.env.MAGPIE_CLOUD_AGENTS_DEBUG = "1"
  output = spyOn(console, "error").mockImplementation(() => { throw new Error("EPIPE") })
  expect(await plugins.CodexCloudPlugin({})).toHaveProperty("auth")
  await expect(plugins.CodexCloudPlugin({}, { progress: "yes" })).rejects.toThrow("Invalid plugin configuration: progress must be a boolean")
})

test("optional defaults and valid shared options remain accepted", async () => {
  const options = {
    progress: false, maxRunMinutes: 0.5, maxPromptBytes: 1024,
    apiBase: { "codex-agents": "http://127.0.0.1:8080/v1" },
    codexCloud: { attempts: 2 }, devinCloud: { maxAcuLimit: 0 },
    dotsApp: { reattachPorts: [9222], stableMs: 1 },
    codexAgents: { environment: { type: "openai_hosted" } },
  }
  for (const [, plugin] of entries) expect(await plugin({}, options)).toHaveProperty("auth")
})
