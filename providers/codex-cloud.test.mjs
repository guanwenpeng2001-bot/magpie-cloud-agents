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
  expect(_internal.stateOf("error: no such task")).toBe("failed")
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
test("missing environment returns 400 naming both configuration locations without spawning", async () => {
  const script = scripted([])
  await expect(_internal.makeDriver({}, script.cli).create({}, { prompt: "hi" })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("metadata.env") })
  await expect(_internal.makeDriver({}, script.cli).create({}, { prompt: "hi" })).rejects.toThrow("codexCloud.env")
  expect(script.calls).toHaveLength(0)
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
  const script = scripted([reply("Completed " + "x".repeat(2048)), reply("diff --git a/a b/a")])
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
test("oauth sign-in stores only markers and a distinct environment account id", async () => {
  const script = scripted([reply("Logged in using ChatGPT")])
  const method = makeCodexCloud({}, script).auth.methods[0]
  expect(method.type).toBe("oauth")
  expect(method.prompts[0].validate(" ")).toBe("an environment id is required")
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
for (const word of ["failed", "expired"]) test(`chat ${word} maps to 502 kept`, async () => {
  const loader = await makeCodexCloud({}, scripted([reply("Logged in"), reply("task_abc123"), reply(word)])).auth.loader(async () => auth)
  const response = await loader.fetch(endpoint, request())
  expect(response.status).toBe(502)
  expect(response.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect((await response.json()).error.message).toContain("task_abc123")
})
test("wrong path and invalid JSON are 404 and 400", async () => {
  const loader = await makeCodexCloud({}, scripted([reply("Logged in")])).auth.loader(async () => auth)
  expect((await loader.fetch(endpoint + "/wrong", request())).status).toBe(404)
  expect((await loader.fetch(endpoint, { body: "not json" })).status).toBe(400)
})
