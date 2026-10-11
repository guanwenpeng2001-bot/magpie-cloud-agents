import { test, expect } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

// The plugin host (function iconOf) accepts an auth/package icon only when it
// starts with "data:image/" (case-insensitive) and fits its length cap. The
// declared icon must also decode to the exact audited PNG: 54,130 bytes with
// a pinned sha256, the PNG signature, and a 256x256 RGBA IHDR.
const ICON_LENGTH_CAP = 1048576
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
  const payload = Buffer.from(icon.slice(icon.indexOf(",") + 1), "base64")
  expect(payload.length).toBe(EXPECTED_PNG_BYTES)
  expect(createHash("sha256").update(payload).digest("hex")).toBe(EXPECTED_PNG_SHA256)
  expect(payload.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
  expect(payload.readUInt32BE(16)).toBe(EXPECTED_WIDTH)
  expect(payload.readUInt32BE(20)).toBe(EXPECTED_HEIGHT)
})
