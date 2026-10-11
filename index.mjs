import { makeCodexCloud } from "./providers/codex-cloud.mjs"
import { makeCodexAgents } from "./providers/codex-agents.mjs"
import { makeCursorCloud } from "./providers/cursor-cloud.mjs"
import { makeDevinCloud } from "./providers/devin-cloud.mjs"
import { makeDotsDriver } from "./providers/dots.mjs"
import { makeGrokBotDriver } from "./providers/grok-bot.mjs"

export async function CodexCloudPlugin(input, options) { return makeCodexCloud(options ?? {}) }
export async function CodexAgentsPlugin(input, options) { return makeCodexAgents(options ?? {}) }
export async function CursorCloudPlugin(input, options) { return makeCursorCloud(options ?? {}) }
export async function DevinCloudPlugin(input, options) { return makeDevinCloud(options ?? {}) }
export async function DotsPlugin(input, options) { return makeDotsDriver(input, options ?? {}) }
export async function GrokBotPlugin(input, options) { return makeGrokBotDriver(input, options ?? {}) }

export const _internal = {}
