import { makeCodexCloud } from "./providers/codex-cloud.mjs"
import { makeCodexAgents } from "./providers/codex-agents.mjs"
import { makeCursorCloud } from "./providers/cursor-cloud.mjs"
import { makeDevinCloud } from "./providers/devin-cloud.mjs"
import { makeDotsDriver } from "./providers/dots.mjs"
import { makeGrokBotDriver } from "./providers/grok-bot.mjs"

import { debug } from "./lib/log.mjs"

function validateOptions(options) {
  const invalid = (path, expected) => { throw new TypeError(`Invalid plugin configuration: ${path} must be ${expected}`) }
  const object = (value, path) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid(path, "an object")
  }
  const number = (value, path, zero = false, integer = false) => {
    if (!Number.isFinite(value) || (zero ? value < 0 : value <= 0) || (integer && !Number.isSafeInteger(value))) invalid(path, `${zero ? "a non-negative" : "a positive"}${integer ? " integer" : " finite number"}`)
  }
  const text = (value, path) => { if (typeof value !== "string" || !value.trim()) invalid(path, "a non-empty string") }
  const url = (value, path) => {
    text(value, path)
    let parsed
    try { parsed = new URL(value) } catch { invalid(path, "an absolute HTTP(S) URL") }
    if (!["http:", "https:"].includes(parsed.protocol)) invalid(path, "an absolute HTTP(S) URL")
  }
  object(options, "options")
  if (options.progress !== undefined && typeof options.progress !== "boolean") invalid("progress", "a boolean")
  if (options.maxRunMinutes !== undefined) number(options.maxRunMinutes, "maxRunMinutes")
  if (options.maxPromptBytes !== undefined) number(options.maxPromptBytes, "maxPromptBytes", false, true)
  for (const name of ["apiBase", "codexCloud", "codexAgents", "cursorCloud", "devinCloud", "dots", "dotsApp", "grokBot"]) {
    if (options[name] !== undefined) object(options[name], name)
  }
  for (const [provider, base] of Object.entries(options.apiBase ?? {})) url(base, `apiBase.${provider}`)
  if (options.codexCloud?.env !== undefined) text(options.codexCloud.env, "codexCloud.env")
  if (options.codexCloud?.attempts !== undefined) number(options.codexCloud.attempts, "codexCloud.attempts", false, true)
  if (options.devinCloud?.maxAcuLimit !== undefined) number(options.devinCloud.maxAcuLimit, "devinCloud.maxAcuLimit", true)
  if (options.codexAgents?.environment !== undefined) {
    object(options.codexAgents.environment, "codexAgents.environment")
    text(options.codexAgents.environment.type, "codexAgents.environment.type")
  }
  for (const name of ["dotsApp", "grokBot"]) {
    const settings = options[name] ?? {}
    for (const key of ["keepAliveMinutes", "launchTimeoutMs", ...(name === "dotsApp" ? ["appBootMs", "surfaceTimeoutMs", "stableMs", "streamIntervalMs"] : [])]) {
      if (settings[key] !== undefined) number(settings[key], `${name}.${key}`)
    }
    if (settings.reattachPorts !== undefined && (!Array.isArray(settings.reattachPorts) || settings.reattachPorts.some(port => !Number.isInteger(port) || port < 1 || port > 65535))) invalid(`${name}.reattachPorts`, "an array of ports from 1 to 65535")
  }
  if (options.grokBot?.ghostMode !== undefined && typeof options.grokBot.ghostMode !== "boolean") invalid("grokBot.ghostMode", "a boolean")
  const dots = options.dots ?? options
  const prefix = options.dots ? "dots." : ""
  if (dots.taskTtlMinutes !== undefined) number(dots.taskTtlMinutes, `${prefix}taskTtlMinutes`)
  if (options.cursorCloud?.repos !== undefined && !Array.isArray(options.cursorCloud.repos)) invalid("cursorCloud.repos", "an array")
  if (dots.tunnelCommand !== undefined && (!Array.isArray(dots.tunnelCommand) || !dots.tunnelCommand.length || dots.tunnelCommand.some(part => typeof part !== "string" || !part))) invalid(`${prefix}tunnelCommand`, "a non-empty argv array of strings")
  if (dots.publicUrl !== undefined) {
    url(dots.publicUrl, `${prefix}publicUrl`)
    const parsed = new URL(dots.publicUrl)
    if (parsed.protocol !== "https:" || parsed.origin !== dots.publicUrl) invalid(`${prefix}publicUrl`, "an HTTPS origin without a path")
  }
}

async function initialize(provider, options, factory) {
  debug(provider, "startup")
  try {
    const settings = options ?? {}
    validateOptions(settings)
    return await factory(settings)
  } catch (error) {
    // Vendor errors can contain credentials or prompts; log only the lifecycle event.
    debug(provider, "startup failed")
    throw error
  }
}

export async function CodexCloudPlugin(input, options) { return initialize("codex-cloud", options, makeCodexCloud) }
export async function CodexAgentsPlugin(input, options) { return initialize("codex-agents", options, makeCodexAgents) }
export async function CursorCloudPlugin(input, options) { return initialize("cursor-cloud", options, makeCursorCloud) }
export async function DevinCloudPlugin(input, options) { return initialize("devin-cloud", options, makeDevinCloud) }
export async function DotsPlugin(input, options) { return initialize("dots", options, settings => makeDotsDriver(input, settings)) }
export async function GrokBotPlugin(input, options) { return initialize("grok-bot", options, settings => makeGrokBotDriver(input, settings)) }

export const _internal = {}
