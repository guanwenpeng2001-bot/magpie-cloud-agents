import { test, expect } from "bun:test"
import { mkdtemp, writeFile, rm, symlink, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executeLocalTool, _internal } from "./self-hosted-tools.mjs"

async function withCwd(run) {
  const cwd = await mkdtemp(join(tmpdir(), "self-hosted-tools-"))
  try { return await run(cwd) } finally { await rm(cwd, { recursive: true, force: true }) }
}
const event = (name, input) => ({ id: "evt_1", name, input })

test("bash runs in cwd and reports exit codes", () => withCwd(async cwd => {
  await writeFile(join(cwd, "cwd-marker.txt"), "cwd-marker")
  const ok = await executeLocalTool(event("Bash", { command: "cat cwd-marker.txt && echo hi" }), { cwd })
  expect(ok.isError).toBe(false)
  expect(ok.text).toContain("cwd-marker")
  expect(ok.text).toContain("hi")
  const bad = await executeLocalTool(event("bash", { command: "exit 3" }), { cwd })
  expect(bad.isError).toBe(true)
  expect(bad.text).toContain("exit code 3")
}))

test("read shows numbered lines and honors view_range", () => withCwd(async cwd => {
  await writeFile(join(cwd, "f.txt"), "alpha\nbeta\ngamma\n")
  const all = await executeLocalTool(event("Read", { file_path: "f.txt" }), { cwd })
  expect(all.text).toContain("1\talpha")
  const range = await executeLocalTool(event("read", { file_path: "f.txt", view_range: [2, 3] }), { cwd })
  expect(range.text).toContain("2\tbeta")
  expect(range.text).not.toContain("alpha")
}))

test("file tools refuse paths escaping cwd, including symlinks", () => withCwd(async cwd => {
  const outside = await mkdtemp(join(tmpdir(), "self-hosted-outside-"))
  try {
    await writeFile(join(outside, "secret.txt"), "secret")
    await symlink(join(outside, "secret.txt"), join(cwd, "link.txt"))
    const direct = await executeLocalTool(event("read", { file_path: "../" + outside.split("/").pop() + "/secret.txt" }), { cwd })
    expect(direct.isError).toBe(true)
    expect(direct.text).toContain("escapes")
    const viaLink = await executeLocalTool(event("read", { file_path: "link.txt" }), { cwd })
    expect(viaLink.isError).toBe(true)
    const glob = await executeLocalTool(event("glob", { pattern: "**/*", path: ".." }), { cwd })
    expect(glob.isError).toBe(true)
  } finally { await rm(outside, { recursive: true, force: true }) }
}))

test("glob matches nested patterns; grep finds lines", () => withCwd(async cwd => {
  await mkdir(join(cwd, "src"), { recursive: true })
  await writeFile(join(cwd, "src", "a.mjs"), "export const needle = 1\n")
  await writeFile(join(cwd, "top.txt"), "nothing\n")
  const glob = await executeLocalTool(event("glob", { pattern: "src/*.mjs" }), { cwd })
  expect(glob.text).toContain("src/a.mjs")
  expect(glob.text).not.toContain("top.txt")
  const grep = await executeLocalTool(event("grep", { pattern: "needle" }), { cwd })
  expect(grep.text).toContain("src/a.mjs:1:")
}))

test("disabled and unknown tools return error results instead of executing", () => withCwd(async cwd => {
  const disabled = await executeLocalTool(event("bash", { command: "echo should-not-run" }), { cwd, tools: ["read"] })
  expect(disabled.isError).toBe(true)
  expect(disabled.text).toContain("not enabled")
  const unknown = await executeLocalTool(event("WebFetch", { url: "https://example.com" }), { cwd })
  expect(unknown.isError).toBe(true)
}))

test("bash respects timeout_ms with a hard kill", () => withCwd(async cwd => {
  const started = Date.now()
  const result = await executeLocalTool(event("bash", { command: "sleep 10; echo too-late", timeout_ms: 200 }), { cwd })
  expect(result.isError).toBe(true)
  expect(result.text).not.toContain("too-late")
  expect(Date.now() - started).toBeLessThan(4000)
}))

test("already cancelled bash never starts", () => withCwd(async cwd => {
  const controller = new AbortController()
  controller.abort(new Error("cancelled before start"))
  await expect(executeLocalTool(event("bash", { command: "echo should-not-run" }), { cwd }, controller.signal)).rejects.toThrow("cancelled before start")
}))
