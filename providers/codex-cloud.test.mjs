import { expect, test, afterAll } from "bun:test"
import { mkdtempSync, writeFileSync, copyFileSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeCodexCloud, _internal } from "./codex-cloud.mjs"

const directory = mkdtempSync(join(tmpdir(), "fake-codex-"))
const executable = join(directory, process.platform === "win32" ? "codex.exe" : "codex")
copyFileSync(process.execPath, executable)
const fixture = join(directory, "fixture.mjs")
writeFileSync(fixture, `const args = process.argv.slice(2); const row = JSON.parse(process.env.FAKE_REPLY); if (process.env.FAKE_LOG) await Bun.write(process.env.FAKE_LOG, JSON.stringify(args)); process.stdout.write(row.stdout || ''); process.stderr.write(row.stderr || ''); if (row.hang) setInterval(() => {}, 1000); else process.exit(row.code || 0)`)
afterAll(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
const auth = { type: "oauth", access: "codex-cli", refresh: "codex-cli", env: "env_fake" }
const reply = (stdout, code = 0, stderr = "") => ({ stdout, code, stderr })
// Verbatim from the live capture (evidence/live-acceptance-sweep/raw-codex-cloud.txt line 16):
// the real CLI emits this sentence with a trailing newline on exit 1, so the fixture keeps it.
const workspaceRefusal = "Error: no cloud environments are available for this workspace\n"
function scripted(rows) {
  const calls = []
  const cli = async (args, options) => {
    calls.push({ args, options })
    const row = rows.shift()
    if (!row) throw new Error("unexpected CLI invocation: " + args.join(" "))
    if (row instanceof Error) throw row
    return row
  }
  return { cli, calls }
}
const request = (messages = [{ role: "user", content: "fix it" }], stream = false) => ({ method: "POST", headers: { "x-magpie-cloud-agents-session": "session-test" }, body: JSON.stringify({ model: "cloud-task", messages, stream }) })
const endpoint = "https://codex-cloud.cloud-agents.invalid/v1/chat/completions"
const fakeSpawn = (row, extra = {}) => _internal.spawnCodex([fixture, "login", "status"], { env: { PATH: directory, FAKE_REPLY: JSON.stringify(row), ...extra } })

test("sign-in refuses an unavailable environment before saving credentials", async () => {
  const script = scripted([reply("Logged in"), reply("", 1, workspaceRefusal)])
  const result = await makeCodexCloud({}, script).auth.methods[0].authorize({ env: "stale" }).callback()
  expect(result).toEqual({ type: "failed", error: `the codex CLI refused this workspace: ${workspaceRefusal.trim()} — your account has no Codex Cloud environment. Create one in your OpenAI Codex Cloud settings, or point the plugin at an existing environment with account metadata.env or option codexCloud.env` })
  expect(script.calls[1].args).toEqual(["cloud", "list", "--env", "stale", "--limit", "1"])
})

test("loader rejects oauth rows without the codex-cli marker", async () => {
  expect(await makeCodexCloud().auth.loader(async () => ({ type: "oauth", env: "env_fake" }))).toEqual({})
})
test("spawn resolves only the fake executable and preserves argv", async () => {
  const log = join(directory, "argv.json")
  const result = await fakeSpawn(reply("Logged in using ChatGPT"), { FAKE_LOG: log })
  expect(result.stdout).toBe("Logged in using ChatGPT")
  expect(JSON.parse(readFileSync(log))).toEqual(["login", "status"])
})

test("a run-cap timeout kills the child process and rejects with a 502", async () => {
  let killed
  try { await _internal.spawnCodex([fixture], { env: { PATH: directory, FAKE_REPLY: JSON.stringify({ hang: true }) }, timeoutMs: 100 }) }
  catch (error) { killed = error }
  expect(killed?.status).toBe(502)
})
test("taskOf extracts plain task ids and URLs", () => {
  expect(_internal.taskOf("Created task_01J9ZK3F2M8Q").ref).toBe("task_01J9ZK3F2M8Q")
  expect(_internal.taskOf("queued https://chatgpt.com/codex/tasks/task_abc123").ref).toBe("task_abc123")
  expect(_internal.taskOf("https://chatgpt.com/codex/tasks/task_abc123").url).toBe("https://chatgpt.com/codex/tasks/task_abc123")
  expect(_internal.taskOf("no identifier here")).toBe(null)
})
test("stateOf matches vocabulary word-wise, so unfinished is not finish", () => {
  expect(_internal.stateOf("task unfinished, still working")).toBe("running")
  expect(_internal.stateOf("Completed successfully")).toBe("succeeded")
  expect(_internal.stateOf("done")).toBe("succeeded")
  expect(_internal.stateOf("FAILED")).toBe("failed")
  expect(_internal.stateOf("error: no such task")).toBe("running")
  expect(_internal.stateOf("cancelled by user")).toBe("failed")
  expect(_internal.stateOf("expired")).toBe("expired")
  expect(_internal.stateOf("in progress")).toBe("running")
})

for (const word of ["complete", "completed", "completion", "succeed", "succeeded", "done", "finish", "finished"]) test(`terminal success vocabulary: ${word}`, () => expect(_internal.stateOf(word)).toBe("succeeded"))
for (const word of ["fail", "failed", "failure", "error", "errors", "cancel", "canceled", "cancelled"]) test(`terminal failure vocabulary: ${word}`, () => expect(_internal.stateOf(word)).toBe("failed"))
for (const word of ["expire", "expired", "expiration"]) test(`expired vocabulary: ${word}`, () => expect(_internal.stateOf(word)).toBe("expired"))
for (const word of ["unfinished", "incomplete", "queued", "pending", "running", "working", "unknown"]) test(`nonterminal vocabulary: ${word}`, () => expect(_internal.stateOf(word)).toBe("running"))

test("create argv keeps the full prompt as one argument and account metadata wins", async () => {
  const script = scripted([reply("created task_abc123")])
  const driver = _internal.makeDriver({ codexCloud: { env: "option", attempts: 2 } }, script.cli)
  const prompt = 'line one\n"quotes"; $(not-a-command) & --model other'
  const run = await driver.create({ metadata: { env: "account" } }, { prompt, model: "ignored" })
  expect(run.ref).toBe("task_abc123")
  expect(script.calls[0].args).toEqual(["cloud", "exec", "--env", "account", "--attempts", "2", "--", prompt])
  expect(driver.followUp).toBeUndefined()
})
test("create falls back to codexCloud.env and defaults attempts to one", async () => {
  const script = scripted([reply("task_abc123")])
  await _internal.makeDriver({ codexCloud: { env: "option" } }, script.cli).create({}, { prompt: "hi" })
  expect(script.calls[0].args).toEqual(["cloud", "exec", "--env", "option", "--attempts", "1", "--", "hi"])
})
const stateFile = join(directory, ".codex-global-state.json")
const cloudState = JSON.stringify({
  "electron-local-remote-control-environment-id": "env_e_remote_control",
  "electron-persisted-atom-state": { "cloud-aeon-sidebar-cache-v1": { threads: [
    { environments: [{ environmentId: "ccarenv_b64_fixture" }] },
  ] } },
})
writeFileSync(stateFile, cloudState)

test("wrapped cached environment ids reach the CLI in canonical form", async () => {
  const canonical = "ccarenv_6abbe3611390819195c4b7833a95c978"
  const wrapped = "ccarenv_b64_" + Buffer.from(canonical).toString("base64url")
  const script = scripted([reply("task_abc123")])
  await _internal.makeDriver({}, script.cli, []).create({ metadata: { env: wrapped } }, { prompt: "hi" })
  expect(script.calls[0].args[3]).toBe(canonical)
})

test("sign-in probes a wrapped local cache id as canonical and leaves both forms unchanged on disk", async () => {
  const canonical = "ccarenv_6abbe3611390819195c4b7833a95c978"
  const wrapped = "ccarenv_b64_" + Buffer.from(canonical).toString("base64url")
  const path = join(directory, "wrapped-cache.json")
  const contents = JSON.stringify({ "electron-persisted-atom-state": { "cloud-aeon-sidebar-cache-v1": { threads: [{ environments: [{ environmentId: wrapped }, { environmentId: canonical }] }] } } })
  writeFileSync(path, contents)
  const script = scripted([reply("Logged in"), reply("")])
  const result = await makeCodexCloud({}, { ...script, statePaths: [path] }).auth.methods[0].authorize().callback()
  expect(result).toMatchObject({ type: "success", env: canonical, accountId: "env:" + canonical })
  expect(script.calls[1].args).toEqual(["cloud", "list", "--env", canonical, "--limit", "1"])
  expect(readFileSync(path, "utf8")).toBe(contents)
})

test("create rediscovers a refused saved environment and retries once", async () => {
  const script = scripted([reply(workspaceRefusal, 1), reply("task_abc123")])
  const run = await _internal.makeDriver({}, script.cli, [stateFile]).create({ metadata: { env: "stale" } }, { prompt: "hi" })
  expect(run.ref).toBe("task_abc123")
  expect(script.calls.map(call => call.args[3])).toEqual(["stale", "ccarenv_b64_fixture"])
})

for (const source of ["option", "same", "missing", "equivalent"]) test(`refused environment does not retry for ${source}`, async () => {
  const canonical = "ccarenv_unchanged"
  const wrapped = "ccarenv_b64_" + Buffer.from(canonical).toString("base64url")
  const path = join(directory, `no-retry-${source}.json`)
  writeFileSync(path, JSON.stringify({ "electron-persisted-atom-state": { "cloud-aeon-sidebar-cache-v1": { threads: [{ environments: [{ environmentId: source === "equivalent" ? wrapped : "env_cached" }] }] } } }))
  const script = scripted([reply(workspaceRefusal, 1)])
  const options = source === "option" ? { codexCloud: { env: "explicit" } } : {}
  const credential = source === "option" ? {} : { metadata: { env: source === "equivalent" ? canonical : "env_cached" } }
  await expect(_internal.makeDriver(options, script.cli, source === "missing" ? [] : [path]).create(credential, { prompt: "hi" })).rejects.toMatchObject({ status: 400, message: expect.stringContaining(workspaceRefusal.trim()) })
  expect(script.calls).toHaveLength(1)
})

test("cached environment is rediscovered after refusal and fallback list uses the new id", async () => {
  const path = join(directory, "changing-cache.json")
  const state = env => JSON.stringify({ "electron-persisted-atom-state": { "cloud-aeon-sidebar-cache-v1": { threads: [{ environments: [{ environmentId: env }] }] } } })
  writeFileSync(path, state("env_old"))
  const script = scripted([reply(workspaceRefusal, 1), reply("submitted"), reply("task_abc123")])
  const cli = async (...args) => {
    const result = await script.cli(...args)
    writeFileSync(path, state("env_new"))
    return result
  }
  expect((await _internal.makeDriver({}, cli, [path]).create({}, { prompt: "hi" })).ref).toBe("task_abc123")
  expect(script.calls.map(call => call.args[3])).toEqual(["env_old", "env_new", "env_new"])
})

test("rediscovery retry remains bounded when the new environment is also refused", async () => {
  const script = scripted([reply(workspaceRefusal, 1), reply(workspaceRefusal, 1)])
  await expect(_internal.makeDriver({}, script.cli, [stateFile]).create({ metadata: { env: "stale" } }, { prompt: "hi" })).rejects.toMatchObject({ status: 400 })
  expect(script.calls).toHaveLength(2)
})

for (const row of [reply("Not logged in", 1), reply("vendor unavailable", 1)]) test(`saved environment does not recover unrelated refusal: ${row.stdout}`, async () => {
  const script = scripted([row])
  await expect(_internal.makeDriver({}, script.cli, [stateFile]).create({ metadata: { env: "stale" } }, { prompt: "hi" })).rejects.toMatchObject({ status: row.stdout === "Not logged in" ? 401 : 502 })
  expect(script.calls).toHaveLength(1)
})

test("create discovers a cloud environment from Codex state without changing the file", async () => {
  const script = scripted([reply("task_abc123")])
  await _internal.makeDriver({}, script.cli, [stateFile]).create({}, { prompt: "hi" })
  expect(script.calls[0].args[3]).toBe("ccarenv_b64_fixture")
  expect(readFileSync(stateFile, "utf8")).toBe(cloudState)
})
for (const source of ["metadata", "option"]) test(`explicit ${source} environment wins over state discovery`, async () => {
  const script = scripted([reply("task_abc123")])
  const options = { codexCloud: { env: "option" } }
  await _internal.makeDriver(options, script.cli, [stateFile]).create(source === "metadata" ? { metadata: { env: "account" } } : {}, { prompt: "hi" })
  expect(script.calls[0].args[3]).toBe(source === "metadata" ? "account" : "option")
})
test("missing environment names every searched path and configuration location without spawning", async () => {
  const script = scripted([])
  const paths = [join(directory, "missing-custom.json"), join(directory, "missing-default.json")]
  let error
  try { await _internal.makeDriver({}, script.cli, paths).create({}, { prompt: "hi" }) } catch (caught) { error = caught }
  expect(error?.status).toBe(400)
  for (const location of ["metadata.env", "codexCloud.env", ...paths]) expect(error.message).toContain(location)
  expect(script.calls).toHaveLength(0)
})
test("sign-in discovers an environment and skips the environment prompt", async () => {
  const method = makeCodexCloud({}, { ...scripted([reply("Logged in"), reply("")]), statePaths: [stateFile] }).auth.methods[0]
  expect(method.prompts).toEqual([])
  expect(await method.authorize().callback()).toMatchObject({ type: "success", env: "ccarenv_b64_fixture" })
})
test("discovery skips corrupt state and never selects a remote-control environment", async () => {
  const corrupt = join(directory, "corrupt.json")
  const remoteOnly = join(directory, "remote-only.json")
  writeFileSync(corrupt, "{")
  writeFileSync(remoteOnly, JSON.stringify({ "electron-local-remote-control-environment-id": "env_e_remote_only" }))
  const script = scripted([reply("task_abc123")])
  await _internal.makeDriver({}, script.cli, [corrupt, remoteOnly, stateFile]).create({}, { prompt: "hi" })
  expect(script.calls[0].args[3]).toBe("ccarenv_b64_fixture")
  await expect(_internal.makeDriver({}, scripted([]).cli, [corrupt, remoteOnly]).create({}, { prompt: "hi" })).rejects.toThrow("no cloud task environment")
  expect(readFileSync(corrupt, "utf8")).toBe("{")
})
test("sign-in with configured environment skips the prompt and discovery", async () => {
  const method = makeCodexCloud({ codexCloud: { env: "configured" } }, { ...scripted([reply("Logged in"), reply("")]), statePaths: [stateFile] }).auth.methods[0]
  expect(method.prompts).toEqual([])
  expect(await method.authorize().callback()).toMatchObject({ type: "success", env: "configured" })
})
test("sign-in without discovery reports searched locations after optional blank input", async () => {
  const path = join(directory, "missing-signin.json")
  const method = makeCodexCloud({}, { ...scripted([]), statePaths: [path] }).auth.methods[0]
  expect(method.prompts[0].validate("")).toBeUndefined()
  expect(await method.authorize({ env: " " }).callback()).toMatchObject({ type: "failed", error: expect.stringContaining(path) })
})
test("unparsable create falls back to list then returns 502 carrying CLI output", async () => {
  const script = scripted([reply("submitted opaque output"), reply("task_abc123"), reply("no create identifier", 0, "create diagnostic"), reply("no list identifier")])
  const driver = _internal.makeDriver({ codexCloud: { env: "fake" } }, script.cli)
  expect((await driver.create({}, { prompt: "hi" })).ref).toBe("task_abc123")
  expect(script.calls[1].args).toEqual(["cloud", "list", "--env", "fake", "--limit", "1"])
  await expect(driver.create({}, { prompt: "hi" })).rejects.toMatchObject({ status: 502, message: "no create identifier\ncreate diagnostic\nno list identifier" })
})
test("successful status returns its short summary above a UTF-8 truncated diff", async () => {
  const script = scripted([reply("Completed: fixed issue"), reply("界".repeat(40000))])
  const result = await _internal.makeDriver({}, script.cli).poll({}, { ref: "task_abc123" })
  expect(result.state).toBe("succeeded")
  expect(result.text.startsWith("Completed: fixed issue\n\n")).toBe(true)
  expect(result.text.endsWith("[diff truncated at 100 KiB]")).toBe(true)
  expect(result.text).not.toContain("�")
  expect(script.calls[1].args).toEqual(["cloud", "diff", "task_abc123"])
})
test("long status summaries are omitted from the diff answer", async () => {
  const script = scripted([reply("Completed: " + "x".repeat(2048)), reply("diff --git a/a b/a")])
  expect((await _internal.makeDriver({}, script.cli).poll({}, { ref: "task_abc123" })).text).toBe("diff --git a/a b/a")
})
test("missing task exit is terminal failure and never requests a diff", async () => {
  const script = scripted([reply("no such task", 1)])
  expect(await _internal.makeDriver({}, script.cli).poll({}, { ref: "task_abc123" })).toEqual({ state: "failed", progress: "no such task" })
  expect(script.calls).toHaveLength(1)
})
for (const text of ["not logged in", "logged out", "not logged in but formerly logged in"]) test(`sign-in rejects logged-out wording: ${text}`, async () => {
  const plugin = makeCodexCloud({}, scripted([reply(text)]))
  expect(await plugin.auth.methods[0].authorize({ env: "fake" }).callback()).toMatchObject({ type: "failed", error: expect.stringContaining("codex login") })
})
// The real CLI writes its confirmation to stderr with exit code 0 and leaves stdout empty
// (measured on codex 0.x, 2026-10-12: stdout "", stderr "Logged in using ChatGPT\n", status 0).
// A check that reads only stdout therefore rejects a genuinely signed-in CLI.
test("sign-in accepts a confirmation the CLI wrote to stderr", async () => {
  const plugin = makeCodexCloud({}, scripted([reply("", 0, "Logged in using ChatGPT\n"), reply("")]))
  expect(await plugin.auth.methods[0].authorize({ env: "fake" }).callback()).toEqual({ type: "success", refresh: "codex-cli", access: "codex-cli", expires: 0, accountId: "env:fake", env: "fake" })
})
test("sign-in rejects logged-out wording the CLI wrote to stderr", async () => {
  const plugin = makeCodexCloud({}, scripted([reply("", 1, "Not logged in\n")]))
  expect(await plugin.auth.methods[0].authorize({ env: "fake" }).callback()).toMatchObject({ type: "failed", error: expect.stringContaining("codex login") })
})
test("oauth sign-in stores only markers and a distinct environment account id", async () => {
  const script = scripted([reply("Logged in using ChatGPT"), reply("")])
  const method = makeCodexCloud({}, { ...script, statePaths: [join(directory, "missing.json")] }).auth.methods[0]
  expect(method.type).toBe("oauth")
  expect(method.prompts[0].validate(" ")).toBeUndefined()
  expect(await method.authorize({ env: " fake " }).callback()).toEqual({ type: "success", refresh: "codex-cli", access: "codex-cli", expires: 0, accountId: "env:fake", env: "fake" })
  expect(script.calls[0].options.timeoutMs).toBe(10000)
})
test("loader logged out returns 401 expired with login guidance", async () => {
  const loader = await makeCodexCloud({}, scripted([reply("Not logged in", 1)])).auth.loader(async () => auth)
  const response = await loader.fetch(endpoint, request())
  expect(response.status).toBe(401)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe("expired")
  expect((await response.json()).error.message).toContain("codex login")
})
test("loader missing binary returns 401 kept with installation guidance", async () => {
  const cli = args => _internal.spawnCodex(args, { env: { PATH: join(directory, "missing") } })
  const loader = await makeCodexCloud({}, { cli }).auth.loader(async () => auth)
  const response = await loader.fetch(endpoint, request())
  expect(response.status).toBe(401)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect((await response.json()).error.message).toContain("install the `codex` CLI from OpenAI")
})
test("loader caches successful login checks for 60 seconds and rereads credentials", async () => {
  let clock = 0, current = auth
  const script = scripted([reply("Logged in"), reply("task_abc123"), reply("done"), reply("diff"), reply("done"), reply("diff"), reply("Not logged in", 1)])
  const loader = await makeCodexCloud({}, { ...script, now: () => clock }).auth.loader(async () => current)
  expect((await loader.fetch(endpoint, request())).status).toBe(200)
  clock = 59999
  expect((await loader.fetch(endpoint, request())).status).toBe(200)
  expect(script.calls.filter(call => call.args[0] === "login")).toHaveLength(1)
  clock = 60000
  expect((await loader.fetch(endpoint, request())).status).toBe(401)
  current = null
  expect((await loader.fetch(endpoint, request())).status).toBe(401)
  expect(script.calls.filter(call => call.args[0] === "login")).toHaveLength(2)
})
test("single-turn chat creates fresh tasks with folded full history and resends attach", async () => {
  const script = scripted([reply("Logged in"), reply("task_abc123"), reply("done"), reply("first diff"), reply("task_def456"), reply("done"), reply("second diff"), reply("done"), reply("second diff")])
  const loader = await makeCodexCloud({}, script).auth.loader(async () => auth)
  expect((await (await loader.fetch(endpoint, request())).json()).choices[0].message.content).toContain("first diff")
  const messages = [{ role: "user", content: "fix it" }, { role: "assistant", content: "first answer" }, { role: "user", content: "add tests" }]
  expect((await loader.fetch(endpoint, request(messages))).status).toBe(200)
  expect((await loader.fetch(endpoint, request(messages))).status).toBe(200)
  const creates = script.calls.filter(call => call.args[1] === "exec")
  expect(creates).toHaveLength(2)
  expect(creates[1].args.at(-1)).toContain("fix it")
  expect(creates[1].args.at(-1)).toContain("first answer")
  expect(creates[1].args.at(-1)).toContain("add tests")
})
test("static pseudo-model and guarded session header require no CLI", async () => {
  const plugin = makeCodexCloud({}, scripted([])), config = {}
  await plugin.config(config)
  expect(config.provider["codex-cloud"].models["cloud-task"]).toMatchObject({ name: "Codex Cloud task", tool_call: false })
  expect(await plugin.provider.models(config.provider["codex-cloud"])).toEqual(config.provider["codex-cloud"].models)
  const output = { headers: {} }
  await plugin["chat.headers"]({ sessionID: "real", model: { providerID: "other" } }, output)
  expect(output.headers).toEqual({})
  await plugin["chat.headers"]({ sessionID: "real", model: { providerID: "codex-cloud" } }, output)
  expect(output.headers["x-magpie-cloud-agents-session"]).toBe("real")
})
test("cancel kills only the local child and sends no cloud cancel or apply", async () => {
  const children = new Set()
  const pending = _internal.spawnCodex([fixture], { children, env: { PATH: directory, FAKE_REPLY: JSON.stringify({ hang: true }) } })
  expect(children.size).toBe(1)
  await _internal.makeDriver({}, scripted([]).cli).cancel({}, { children })
  expect((await pending).code).not.toBe(0)
  expect(children.size).toBe(0)
})
test("AbortSignal kills the fake process", async () => {
  const controller = new AbortController(), children = new Set()
  const pending = _internal.spawnCodex([fixture], { children, signal: controller.signal, env: { PATH: directory, FAKE_REPLY: JSON.stringify({ hang: true }) } })
  controller.abort(new Error("cancelled"))
  await expect(pending).rejects.toThrow("cancelled")
  expect(children.size).toBe(0)
})
for (const [row, status] of [[reply("rate limited", 1), 429], [reply("vendor unavailable", 1), 502]]) test(`create CLI errors preserve wording and status ${status}`, async () => {
  await expect(_internal.makeDriver({ codexCloud: { env: "fake" } }, scripted([row]).cli).create({}, { prompt: "hi" })).rejects.toMatchObject({ status, signIn: "kept", message: row.stdout })
})
test("a workspace without a cloud environment is a 400 configuration error naming cause and action", async () => {
  const script = scripted([reply(workspaceRefusal, 1)])
  let error
  try { await _internal.makeDriver({ codexCloud: { env: "fake" } }, script.cli).create({}, { prompt: "hi" }) } catch (caught) { error = caught }
  expect(error?.status).toBe(400)
  expect(error?.message).toContain("no cloud environments are available for this workspace")
  expect(error?.message).toContain("has no Codex Cloud environment")
  expect(error?.message).toContain("metadata.env")
  expect(error?.message).toContain("codexCloud.env")
})
test("loader reports a missing cloud environment as a 400 the client must act on", async () => {
  const script = scripted([reply("Logged in"), reply(workspaceRefusal, 1)])
  const loader = await makeCodexCloud({ codexCloud: { env: "fake" } }, { ...script, statePaths: [] }).auth.loader(async () => auth)
  const response = await loader.fetch(endpoint, request())
  expect(response.status).toBe(400)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe("kept")
  const body = await response.json()
  expect(body.error.code).toBe(400)
  expect(body.error.message).toContain("no cloud environments are available for this workspace")
  expect(body.error.message).toContain("codexCloud.env")
})
for (const [text, label] of [
  ["Error: no cloud environments are available for other workspaces\n", "a phrase about other workspaces"],
  ["Error: no environments are available for this workspace\n", "the same sentence without 'cloud'"],
]) test(`near-miss exit-1 output stays a plain 502: ${label}`, async () => {
  await expect(_internal.makeDriver({ codexCloud: { env: "fake" } }, scripted([reply(text, 1)]).cli).create({}, { prompt: "hi" })).rejects.toMatchObject({ status: 502, message: text })
})
for (const word of ["failed", "expired"]) test(`chat ${word} maps to 502 kept`, async () => {
  const loader = await makeCodexCloud({}, scripted([reply("Logged in"), reply("task_abc123"), reply(word)])).auth.loader(async () => auth)
  const response = await loader.fetch(endpoint, request())
  expect(response.status).toBe(502)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect((await response.json()).error.message).toContain("task_abc123")
})
for (const text of ["not finished", "not done", "not complete", "isn't done", "has not completed", "setup complete, starting agent"]) test(`prose is not status: ${text}`, () => expect(_internal.stateOf(text)).toBe("running"))
for (const text of ["Task completed. Fixed the failing test.", "Done — no errors.", "Completed: 12 tests passing, 0 failures", "Succeeded with 0 errors and 0 warnings", "Finished. Updated the error handling.", "Finished successfully, 1 cancelled job cleaned up", "Completed successfully, nothing expired"]) test(`explicit success survives summary: ${text}`, () => expect(_internal.stateOf(text)).toBe("succeeded"))
test("echoed prompt stays running and a resend never creates another task", async () => {
  let creates = 0, polls = 0
  const cli = async args => {
    if (args[0] === "login") return reply("Logged in")
    if (args[1] === "exec") { creates++; return reply("task_abc123") }
    if (args[1] === "diff") return reply("the diff")
    return reply(++polls === 1 ? "task_abc123  fix the failing test  [in progress]" : "Status: succeeded")
  }
  const loader = await makeCodexCloud({}, { cli }).auth.loader(async () => auth)
  const messages = [{ role: "user", content: "fix the failing test" }]
  expect((await loader.fetch(endpoint, request(messages))).status).toBe(200)
  expect((await loader.fetch(endpoint, request(messages))).status).toBe(200)
  expect(creates).toBe(1)
})
for (const prose of ["task-related", "task-oriented", "task_manager", "Tasks-running"]) test(`task prose has no reference: ${prose}`, () => expect(_internal.taskOf(prose)).toBe(null))
test("stderr warnings never override a running marker", async () => {
  const driver = _internal.makeDriver({}, scripted([reply("in progress", 0, "warning: error reading config, using defaults")]).cli)
  expect((await driver.poll({}, { ref: "task_abc123" })).state).toBe("running")
})
test("conflicting markers and echoed terminal prompts stay running", () => {
  expect(_internal.stateOf("Status: done\nStatus: running")).toBe("running")
  expect(_internal.stateOf("task_abc123  done  [in progress]", "done")).toBe("running")
  expect(_internal.stateOf("failed", "failed")).toBe("running")
})
test("fallback warns in the returned answer while a directly parsed task does not", async () => {
  for (const inferred of [true, false]) {
    const script = scripted([reply("Logged in"), reply(inferred ? "Applied task-related changes" : "task_abc123"), ...(inferred ? [reply("task_def456")] : []), reply("Status: succeeded"), reply("another diff")])
    const loader = await makeCodexCloud({}, script).auth.loader(async () => auth)
    const response = await loader.fetch(endpoint, request())
    const text = (await response.json()).choices[0].message.content
    expect(text.includes("ownership is unverified")).toBe(inferred)
    expect(text).toContain("another diff")
    expect(script.calls.some(call => call.args[1] === "list")).toBe(inferred)
  }
})
const continuingRows = ["Status: completed the refactor, now running the tests", "Status: failing test identified, fix in progress", "Done, starting the tests", "Done — still running the test suite", "Done with 3 retries, continuing", "Error: connection reset, retrying", "task_abc123  Please investigate.\nError: tests fail on Windows."]
for (const text of continuingRows) test(`continuation cannot terminate: ${text}`, () => expect(_internal.stateOf(text)).toBe("running"))
for (const text of continuingRows) test(`continuation remains attached through the core: ${text}`, async () => {
  let creates = 0, diffs = 0, polls = 0
  const cli = async args => {
    if (args[0] === "login") return reply("Logged in")
    if (args[1] === "exec") { creates++; return reply("task_abc123") }
    if (args[1] === "diff") { diffs++; return reply("partial diff") }
    polls++; return reply(text)
  }
  const loader = await makeCodexCloud({ maxRunMinutes: 0.001 }, { cli }).auth.loader(async () => auth)
  expect((await loader.fetch(endpoint, request())).status).toBe(504)
  expect((await loader.fetch(endpoint, request())).status).toBe(504)
  expect(creates).toBe(1)
  expect(diffs).toBe(0)
  expect(polls).toBe(2)
})
test("authorize instructions disclose unfinished-diff risk and named status limits", () => {
  const instructions = makeCodexCloud({}, scripted([])).auth.methods[0].authorize({ env: "fake" }).instructions
  for (const text of [
    "work continues on the parser", "the worker proceeds to packaging",
    "the agent keeps indexing the tree", "the migration is underway",
    "return an unfinished diff", "Verify task completion independently before using a returned diff",
    "tested only on constructed examples", "real CLI wording is unverified",
  ]) expect(instructions).toContain(text)
})
const grammaticalRows = [
  "Done; and then it uploads", "Done; after that the worker kerffufles the queue",
  "Done; the agent will deploy shortly", "Done; it might frobnicate artifacts",
  "Done; now the agent compiles modules", "Done; then it uploads the artifacts",
  "Done; meanwhile packaging continues", "Done; subsequently the worker uploads artifacts",
  "Done; to be verified", "Done; about to push the fix", "Done; to frobnicate artifacts",
]
for (const text of grammaticalRows) test(`grammatical continuation: ${text}`, async () => {
  expect(_internal.stateOf(text)).toBe("running")
  let creates = 0, diffs = 0
  const cli = async args => {
    if (args[0] === "login") return reply("Logged in")
    if (args[1] === "exec") { creates++; return reply("task_abc123") }
    if (args[1] === "status") return reply(text)
    if (args[1] === "diff") { diffs++; return reply("unfinished diff") }
    throw new Error("unexpected CLI invocation")
  }
  const loader = await makeCodexCloud({ maxRunMinutes: 0.001 }, { cli }).auth.loader(async () => auth)
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await loader.fetch(endpoint, request())
    expect(response.status).toBe(504)
    expect(await response.text()).not.toContain("unfinished diff")
  }
  expect(creates).toBe(1)
  expect(diffs).toBe(0)
})
const structuralRows = [
  "Done; checking the logs", "Completed; examining the failures", "Failed; investigating the cause",
  "Done; rebuilding the index", "Completed; downloading the artifacts",
  "Done; auditing the bundle", "Completed; encrypting archives", "Failed; diagnosing the fault",
  "Done; synchronizing", "Done; now packaging artifacts", "Done, compiling modules",
  "Done — uploading artifacts", "Completed. Scanning dependencies", "Done; the agent is indexing",
  "Done; artifacts saved, then compressing outputs", "Done; cautiously deploying services",
  "Done; frobniculating the fixture",
]
for (const text of structuralRows) test(`structural continuation: ${text}`, () => expect(_internal.stateOf(text)).toBe("running"))
for (const text of structuralRows) test(`structural continuation keeps its task through the core: ${text}`, async () => {
  let creates = 0, diffs = 0
  const cli = async args => {
    if (args[0] === "login") return reply("Logged in")
    if (args[1] === "exec") { creates++; return reply("task_abc123") }
    if (args[1] === "status") return reply(text)
    if (args[1] === "diff") { diffs++; return reply("unfinished diff") }
    throw new Error("unexpected CLI invocation")
  }
  const loader = await makeCodexCloud({ maxRunMinutes: 0.001 }, { cli }).auth.loader(async () => auth)
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await loader.fetch(endpoint, request())
    expect(response.status).toBe(504)
    expect(await response.text()).not.toContain("unfinished diff")
  }
  expect(creates).toBe(1)
  expect(diffs).toBe(0)
})
test("status argv uses the created bare task reference even when a URL exists", async () => {
  const script = scripted([reply("https://chatgpt.com/codex/tasks/task_abc123"), reply("running")])
  const driver = _internal.makeDriver({ codexCloud: { env: "fake" } }, script.cli)
  const run = await driver.create({}, { prompt: "repair parser" })
  await driver.poll({}, run)
  expect(script.calls[1].args).toEqual(["cloud", "status", "task_abc123"])
})
const clauseRows = [
  ["succeeded", "Completed: fixed the running indicator"],
  ["succeeded", "Done: updated the queued jobs panel"],
  ["succeeded", "Finished: removed the pending flag"],
  ["succeeded", "Succeeded: rewrote the in progress badge"],
  ["succeeded", "Completed: added a starting-state enum"],
  ["succeeded", "Completed: fixed the continuing education module"],
  ["succeeded", "Completed: the running total is 5"],
  ["succeeded", "Done: pending review cleared"],
  ["succeeded", "Done; the queued jobs panel was rewritten"],
  ["succeeded", "Completed, and the running total is 5"],
  ["failed", "Cancelled: the pending request was dropped"],
  ["failed", "Failed: the queued job was dropped"],
  ["running", "Failed: resuming from the last checkpoint"],
  ["running", "Failed, queuing a retry"],
  ["running", "Done, working through the failures"],
  ["running", "Status: completed. Now verifying the fix"],
  ["running", "Completed. Now verifying the fix"],
  ["running", "Done. Verifying the result"],
  ["running", "Done, running tests"],
  ["running", "Completed, retrying uploads"],
  ["running", "Done, pending checks"],
  ["running", "Completed, running integration tests now"],
  ["succeeded", "Completed: repaired the waiting room selector"],
  ["succeeded", "Finished: renamed the reconnecting-state constant"],
  ["succeeded", "Done; the verifying badge was removed"],
  ["succeeded", "Succeeded, and the working directory label is correct"],
  ["succeeded", "Done: pending approval cleared"],
  ["failed", "Failed: the resuming worker crashed"],
  ["failed", "Cancelled; the queued export was discarded"],
  ["running", "Done, reconnecting sockets"],
  ["running", "Completed. Now attempting recovery"],
  ["running", "Failed, trying another region"],
  ["running", "Status: completed the setup; waiting for allocation"],
  ["running", "Done, checks prepared; now verifying artifacts"],
  ["running", "Finished — working through remaining checks"],
  ["running", "Status: failed: resuming the upload"],
  ["running", "Completed; queuing exports"],
  ["running", "Error: transport unavailable"],
  ["expired", "Expired while waiting for allocation"],
  ["failed", "State: error"],
  ["succeeded", "Done; artifacts saved"],
  ["running", "not finished; artifacts missing"],
]
for (const [state, text] of clauseRows) test(`clause meaning: ${text}`, () => expect(_internal.stateOf(text)).toBe(state))
for (const text of ["Completed: fixed the running indicator", "Completed successfully"]) test(`stable completion delivers its diff on each attached request: ${text}`, async () => {
  let creates = 0, polls = 0, diffs = 0
  const cli = async args => {
    if (args[0] === "login") return reply("Logged in")
    if (args[1] === "exec") { creates++; return reply("task_abc123") }
    if (args[1] === "status") { polls++; return reply(text) }
    if (args[1] === "diff") { diffs++; return reply("complete diff") }
    throw new Error("unexpected CLI invocation")
  }
  const loader = await makeCodexCloud({ maxRunMinutes: 0.001 }, { cli }).auth.loader(async () => auth)
  for (let i = 0; i < 2; i++) {
    const response = await loader.fetch(endpoint, request())
    expect(response.status).toBe(200)
    expect((await response.json()).choices[0].message.content).toContain("complete diff")
  }
  expect(creates).toBe(1)
  expect(polls).toBe(2)
  expect(diffs).toBe(2)
})
for (const text of ["Done, reconnecting sockets", "Completed. Now verifying the fix", "Failed, queuing a retry"]) test(`clause continuation preserves the attachment: ${text}`, async () => {
  let creates = 0, diffs = 0, polls = 0
  const cli = async args => {
    if (args[0] === "login") return reply("Logged in")
    if (args[1] === "exec") { creates++; return reply("task_abc123") }
    if (args[1] === "diff") { diffs++; return reply("partial diff") }
    polls++; return reply(text)
  }
  const loader = await makeCodexCloud({ maxRunMinutes: 0.001 }, { cli }).auth.loader(async () => auth)
  expect((await loader.fetch(endpoint, request())).status).toBe(504)
  expect((await loader.fetch(endpoint, request())).status).toBe(504)
  expect(creates).toBe(1)
  expect(diffs).toBe(0)
  expect(polls).toBe(2)
})
test("expired prose preserves its terminal verdict", () => expect(_internal.stateOf("Expired before finishing")).toBe("expired"))
test("real diff timer retries the same completed task", async () => {
  let creates = 0, diffs = 0
  const cli = async (args, options) => {
    if (args[0] === "login") return reply("Logged in")
    if (args[1] === "exec") { creates++; return reply("task_abc123") }
    if (args[1] === "status") return reply("Status: succeeded")
    expect(options.timeoutMs).toBe(3000)
    if (++diffs === 1) return _internal.spawnCodex([fixture], { ...options, env: { PATH: directory, FAKE_REPLY: JSON.stringify({ hang: true }) } })
    return reply("retried diff")
  }
  const loader = await makeCodexCloud({}, { cli }).auth.loader(async () => auth)
  const response = await loader.fetch(endpoint, request())
  expect(response.status).toBe(200)
  expect((await response.json()).choices[0].message.content).toContain("retried diff")
  expect(creates).toBe(1)
  expect(diffs).toBe(2)
}, 10000)
test("real diff sign-in expiry surfaces 401 expired without retry", async () => {
  let diffs = 0
  const cli = async (args, options) => {
    if (args[0] === "login") return reply("Logged in")
    if (args[1] === "exec") return reply("task_abc123")
    if (args[1] === "status") return reply("Status: succeeded")
    diffs++
    return _internal.spawnCodex([fixture], { ...options, env: { PATH: directory, FAKE_REPLY: JSON.stringify(reply("Not logged in", 1)) } })
  }
  const loader = await makeCodexCloud({ maxRunMinutes: 0.02 }, { cli }).auth.loader(async () => auth)
  const response = await loader.fetch(endpoint, request())
  expect(response.status).toBe(401)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe("expired")
  expect(diffs).toBe(1)
})
test("aborting loader login kills the registered fake child promptly", async () => {
  let children
  const controller = new AbortController()
  const cli = (args, options) => {
    children = options.children
    const pending = _internal.spawnCodex([fixture], { ...options, env: { PATH: directory, FAKE_REPLY: JSON.stringify({ hang: true }) } })
    queueMicrotask(() => controller.abort(new Error("caller cancelled login")))
    return pending
  }
  const loader = await makeCodexCloud({}, { cli }).auth.loader(async () => auth)
  const started = Date.now()
  await loader.fetch(endpoint, { ...request(), signal: controller.signal })
  expect(Date.now() - started).toBeLessThan(2000)
  expect(children.size).toBe(0)
})
test("driver cancel can kill a registered login child", async () => {
  const cli = (args, options) => {
    const pending = _internal.spawnCodex([fixture], { ...options, env: { PATH: directory, FAKE_REPLY: JSON.stringify({ hang: true }) } })
    void _internal.makeDriver({}, scripted([]).cli).cancel({}, { children: options.children })
    return pending
  }
  const loader = await makeCodexCloud({}, { cli }).auth.loader(async () => auth)
  expect((await loader.fetch(endpoint, request())).status).toBe(401)
})
for (const options of [{ codexCloud: { env: 123 } }, {}]) test(`non-string environment is a 400: ${JSON.stringify(options)}`, async () => {
  const driver = _internal.makeDriver(options, scripted([]).cli)
  await expect(driver.create(options.codexCloud ? {} : { metadata: { env: 123 } }, { prompt: "hi" })).rejects.toMatchObject({ status: 400, message: "metadata.env and codexCloud.env must be strings" })
})
test("failed login checks are never cached", async () => {
  const script = scripted([reply("not logged in"), reply("not logged in")])
  const loader = await makeCodexCloud({}, script).auth.loader(async () => auth)
  expect((await loader.fetch(endpoint, request())).status).toBe(401)
  expect((await loader.fetch(endpoint, request())).status).toBe(401)
  expect(script.calls).toHaveLength(2)
})
test("wrong path and invalid JSON are 404 and 400",async () => {
  const loader = await makeCodexCloud({}, scripted([reply("Logged in")])).auth.loader(async () => auth)
  expect((await loader.fetch(endpoint + "/wrong", request())).status).toBe(404)
  expect((await loader.fetch(endpoint, { body: "not json" })).status).toBe(400)
})
