import { test, expect } from "bun:test"
import { startMcp } from "./dots-mcp.mjs"
import { DotsQueue, mintToken } from "./dots-queue.mjs"

test("unauthorized traffic cannot consume the authenticated principal's quota", async () => {
  const token = mintToken()
  let time = 0
  const server = startMcp({ token, queue: new DotsQueue(), ratePerMinute: 2, now: () => time })
  const request = (suffix = "", authorization) => fetch(server.url + suffix, {
    method: "POST", headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  })
  try {
    for (const suffix of ["", "/wrong", "/%ZZ", ""]) {
      expect((await request(suffix, "Bearer wrong")).status).toBe(401)
    }
    expect((await request("", "Bearer " + token)).status).toBe(200)
    expect((await request("/" + token)).status).toBe(200)
    const limited = await request("", "Bearer " + token)
    expect(limited.status).toBe(429)
    expect(limited.headers.get("retry-after")).toBe("60")
    expect((await request("", "Bearer wrong")).status).toBe(401)
    time = 60000
    expect((await request("", "Bearer " + token)).status).toBe(200)
  } finally { await server.close() }
})
