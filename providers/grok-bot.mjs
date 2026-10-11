import { emulate } from "../lib/emulate.mjs"
import { chatError, errorResponse } from "../lib/errors.mjs"
import { sessionOf, SESSION_HEADER } from "../lib/sessions.mjs"
import { createGrokBotCdp } from "./grok-bot-cdp.mjs"

const ID = "grok-bot"
const NAME = "Grok Bot (xAI desktop)"
const BASE = "https://grok-bot.cloud-agents.invalid/v1"
const MODELS = { "app-bot": { name: "App bot (the currently selected bot)", tool_call: false } }
const directFailure = () => chatError(502, "Grok Bot direct couldn't load — reinstall the plugin or pick the app-drive sign-in", "kept")
const mechanism = auth => auth?.mechanism === "direct" || auth?.accountId === "grok-bot-direct" || auth?.refresh === "dpapi-derive" ? "direct" : "cdp"

export function makeGrokBotDriver(input, options = {}, dependencies = {}) {
  const cdp = createGrokBotCdp(options.grokBot ?? {}, dependencies.cdp ?? options.grokBot?.dependencies)
  let direct
  async function driverFor(choice) {
    if (choice !== "direct") return cdp
    if (!direct) {
      try {
        const module = await (dependencies.importDirect ? dependencies.importDirect() : import("./grok-bot-direct.mjs"))
        const driver = module.makeGrokBotDirect(input, options)
        if (!["create", "authorize", "verify", "dispose"].every(key => typeof driver?.[key] === "function")) throw directFailure()
        direct = driver
      } catch { throw directFailure() }
    }
    return direct
  }
  return {
    auth: {
      provider: ID,
      methods: [
        { type: "oauth", label: "Drive the installed Grok Bot desktop app (default; zero credential)", authorize: () => cdp.authorize() },
        { type: "oauth", label: "Direct Connect protocol (reads the app's local sign-in)", async authorize() {
          try {
            const flow = await (await driverFor("direct")).authorize()
            return { ...flow, callback: async (...args) => { const result = await flow.callback(...args); return result.type === "success" ? { ...result, mechanism: "direct" } : result } }
          } catch { return { url: "", method: "auto", instructions: directFailure().message, callback: async () => ({ type: "failed", error: directFailure().message }) } }
        } },
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "oauth" || !auth.access) return {}
        const choice = mechanism(auth)
        let driver
        try { driver = await driverFor(choice) }
        catch (error) { return { baseURL: BASE, fetch: async () => errorResponse(error) } }
        const fetch = emulate(driver, async () => {
          const current = await getAuth()
          return current?.type === "oauth" && mechanism(current) === choice ? current : null
        }, options, dependencies.timers ? { timers: dependencies.timers } : {})
        return { baseURL: BASE, fetch }
      },
    },
    "chat.headers": async (request, output) => {
      if (request?.model?.providerID !== ID && request?.provider?.info?.id !== ID) return
      const session = sessionOf(request)
      if (session) { output.headers ??= {}; output.headers[SESSION_HEADER] = session }
    },
    async config(config) {
      config.provider ??= {}
      const previous = config.provider[ID] ?? {}
      config.provider[ID] = { name: NAME, npm: "@ai-sdk/openai-compatible", api: BASE, ...previous, models: { ...MODELS, ...(previous.models ?? {}) } }
    },
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        const floor = { ...MODELS, ...provider.models }
        if (auth?.type !== "oauth") return floor
        try {
          const driver = await driverFor(mechanism(auth))
          const live = await driver.liveModels?.(auth)
          return { ...floor, ...Object.fromEntries(Object.entries(live ?? {}).map(([id, model]) => [id, { ...model, id, api: { id, url: BASE, npm: "@ai-sdk/openai-compatible" }, capabilities: { ...model.capabilities, toolcall: false } }])) }
        } catch (error) { if (error.signIn === "expired") throw error; return floor }
      },
    },
  }
}
