import { test, expect } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

// Mirrors iconOf in Magpie's plugin host; the package additionally pins its PNG identity.
const ICON_LENGTH_CAP = 3 << 19
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
const license = readFileSync(new URL("../LICENSE", import.meta.url), "utf8")

function hostIcon(value) {
  const icon = typeof value === "string" ? value.trim() : ""
  return icon.length <= ICON_LENGTH_CAP && /^(https:\/\/|data:image\/)/i.test(icon) ? icon : ""
}

for (const field of ["name", "version", "description"]) {
  test(`listing ${field} is a non-empty string`, () => {
    expect(typeof pkg[field] === "string" && pkg[field].trim().length > 0).toBe(true)
  })
}

test("listing repository names the published GitHub repository", () => {
  expect(pkg.repository?.url).toBe("git+https://github.com/guanwenpeng2001-bot/magpie-cloud-agents.git")
})

test("listing license is MIT", () => {
  expect(pkg.license).toBe("MIT")
})

test("listing license matches LICENSE", () => {
  expect(license.split(/\r?\n/)[0]).toBe(`${pkg.license} License`)
})

test("listing keywords include the discovery topic", () => {
  expect(pkg.keywords ?? []).toContain("magpie-plugin")
})

for (const length of [1048577, 1200000, 3 << 19]) {
  test(`host accepts an icon of length ${length}`, () => {
    expect(hostIcon("data:image/".padEnd(length, "x")).length).toBe(length)
  })
}

test("host rejects an icon one character over its cap", () => {
  expect(hostIcon("data:image/".padEnd((3 << 19) + 1, "x")).length).toBe(0)
})

for (const icon of ["https://example.invalid/icon.png", "HTTPS://example.invalid/icon.png", "DATA:IMAGE/png;base64,AA=="]) {
  test(`host accepts scheme ${icon}`, () => {
    expect(hostIcon(icon)).toBe(icon)
  })
}

test("host trims whitespace before measuring at the cap", () => {
  const icon = "data:image/".padEnd(3 << 19, "x")
  expect(hostIcon(` \t${icon}\r\n`).length).toBe(icon.length)
})

test("host returns the trimmed icon", () => {
  expect(hostIcon(" \tdata:image/png;base64,AA==\r\n")).toBe("data:image/png;base64,AA==")
})
const EXPECTED_PNG_SHA256 = "46efee528d82657f60703961166b462f5da4cf79bed821dcffc1a3dd10a69f2b"
const EXPECTED_PNG_BYTES = 54130
const EXPECTED_WIDTH = 256
const EXPECTED_HEIGHT = 256

test("package.json declares a magpie icon the plugin host accepts", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  const icon = pkg.magpie?.icon
  expect(typeof icon).toBe("string")
  expect(icon.length).toBeGreaterThan(0)
  expect(/^data:image\//i.test(icon)).toBe(true)
  expect(icon.length).toBeLessThanOrEqual(ICON_LENGTH_CAP)
  expect(hostIcon(icon)).toBe(icon)
  const payload = Buffer.from(icon.slice(icon.indexOf(",") + 1), "base64")
  expect(payload.length).toBe(EXPECTED_PNG_BYTES)
  expect(createHash("sha256").update(payload).digest("hex")).toBe(EXPECTED_PNG_SHA256)
  expect(payload.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
  expect(payload.readUInt32BE(16)).toBe(EXPECTED_WIDTH)
  expect(payload.readUInt32BE(20)).toBe(EXPECTED_HEIGHT)
})
