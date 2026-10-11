import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { chatError } from "../lib/errors.mjs"

export const MISSING_SIGN_IN = "Grok Bot direct: no local Grok Bot sign-in found — install the app and sign in once (or use the app-drive sign-in instead)"
export const UNWRAP_FAILED = "Grok Bot direct: couldn't read the app's sealed sign-in (OS refused) — sign in to the app again, or use the app-drive mode"
const refused = () => chatError(401, UNWRAP_FAILED, "kept")
const missing = () => chatError(401, MISSING_SIGN_IN, "expired")

const base64 = /^[A-Za-z0-9+/]+={0,2}$/
function decode(value) {
  if (typeof value !== "string" || !value.length || !base64.test(value) || value.length % 4 !== 0) throw refused()
  return Buffer.from(value, "base64")
}

export async function unprotect(bytes) {
  if (process.platform !== "win32" || process.arch !== "x64") throw refused()
  const { dlopen, ptr, toArrayBuffer } = await import("bun:ffi")
  const kernel = dlopen("kernel32.dll", { LocalFree: { args: ["ptr"], returns: "ptr" } })
  let crypt, unsealed
  const input = Buffer.alloc(16), output = Buffer.alloc(16)
  try {
    crypt = dlopen("crypt32.dll", { CryptUnprotectData: { args: ["ptr", "ptr", "ptr", "ptr", "ptr", "u32", "ptr"], returns: "i32" } })
    input.writeUInt32LE(bytes.length)
    input.writeBigUInt64LE(BigInt(ptr(bytes)), 8)
    // CRYPTPROTECT_UI_FORBIDDEN keeps the OS from ever prompting on an unreadable blob.
    if (!crypt.symbols.CryptUnprotectData(ptr(input), null, null, null, null, 1, ptr(output))) throw refused()
    unsealed = new Uint8Array(toArrayBuffer(Number(output.readBigUInt64LE(8)), 0, output.readUInt32LE(0)))
    const key = new Uint8Array(unsealed)
    unsealed.fill(0)
    return key
  } finally {
    unsealed?.fill(0)
    const address = Number(output.readBigUInt64LE(8))
    if (address) kernel.symbols.LocalFree(address)
    crypt?.close(); kernel.close()
  }
}

// Decrypts a Chromium safeStorage v10 blob: "v10" prefix, 12-byte AES-GCM nonce, ciphertext+tag.
export async function decryptBlob(sealed, key) {
  const imported = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"])
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.subarray(3, 15) }, imported, sealed.subarray(15)))
}

export async function unwrapToken(localState, secrets, dependencies = {}) {
  let key, token
  try {
    let accounts, entry
    try { accounts = JSON.parse(secrets["cursor-accounts"]) } catch { throw refused() }
    entry = accounts?.accounts?.[accounts.active]
    if (!entry || !entry["cursor-access-token"]) throw missing()
    const wrapped = decode(localState?.os_crypt?.encrypted_key)
    if (wrapped.length <= 5 || wrapped.subarray(0, 5).toString() !== "DPAPI") throw refused()
    const sealed = decode(entry["cursor-access-token"])
    if (sealed.length < 32 || sealed.subarray(0, 3).toString() !== "v10") throw refused()
    const machineId = secrets["cursor-machine-id"]
    if (typeof machineId !== "string" || !machineId || /[\r\n]/.test(machineId)) throw refused()
    key = await (dependencies.unprotect ?? unprotect)(wrapped.subarray(5))
    if (!(key instanceof Uint8Array) || key.length !== 32) throw refused()
    try {
      token = await (dependencies.decryptBlob ?? decryptBlob)(sealed, key)
    } finally { key.fill(0) }
    if (!token.length || token.some(byte => byte <= 32 || byte >= 127)) throw refused()
    return { token, machineId }
  } catch (error) {
    token?.fill(0)
    throw error?.message === MISSING_SIGN_IN ? missing() : refused()
  } finally { if (key instanceof Uint8Array) key.fill(0) }
}

export function makeTokenStore(dependencies = {}) {
  let current, pending, disposed = false
  const load = async () => {
    let localState, secrets
    try {
      const profile = dependencies.profilePath ?? (process.env.APPDATA && join(process.env.APPDATA, "Grok Bot"))
      if (!profile) throw missing()
      const reader = dependencies.readFile ?? readFile
      localState = JSON.parse(await reader(join(profile, "Local State"), "utf8"))
      secrets = JSON.parse(await reader(join(profile, "sand-secrets.json"), "utf8"))
    } catch (error) {
      if (error?.code === "ENOENT" || error?.message === MISSING_SIGN_IN) throw missing()
      throw refused()
    }
    const result = await unwrapToken(localState, secrets, dependencies)
    if (disposed) { result.token.fill(0); throw refused() }
    current = result
    return result
  }
  return {
    async get(refresh = false) {
      if (disposed) throw refused()
      if (pending) return pending
      if (refresh) { current?.token.fill(0); current = undefined }
      if (current) return current
      pending = load()
      try { return await pending } finally { pending = undefined }
    },
    dispose() { disposed = true; current?.token.fill(0); current = undefined },
  }
}
