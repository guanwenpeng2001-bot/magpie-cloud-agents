const ID = "grok-bot"
const NAME = "Grok Bot (xAI desktop)"
const CHAT = "@ai-sdk/openai-compatible"
const BASE = "https://grok-bot.cloud-agents.invalid/v1"

const MODELS = {
  "app-bot": { name: "App bot (the currently selected bot)", tool_call: false },
}

const errorResponse = ({ status, message, signIn = "kept" }) =>
  new Response(JSON.stringify({ error: { message, type: "cloud_agent_error", code: status } }), {
    status,
    headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": signIn },
  })

function grokBotCdpAuthorize() {
  return {
    url: "",
    instructions: NAME + " transport not implemented yet; sign-in is unavailable in this scaffold.",
    method: "auto",
    callback: async () => ({ type: "failed", error: NAME + " transport not implemented yet" }),
  }
}

function grokBotDirectAuthorize() {
  return {
    url: "",
    instructions: NAME + " transport not implemented yet; sign-in is unavailable in this scaffold.",
    method: "auto",
    callback: async () => ({ type: "failed", error: NAME + " transport not implemented yet" }),
  }
}

export function makeGrokBotDriver(input, options = {}) {
  return {
    auth: {
      provider: ID,
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "oauth") return {}
        return {
          baseURL: BASE,
          async fetch(input, init = {}) {
            const now = await getAuth()
            if (now?.type !== "oauth")
              return errorResponse({ status: 401, message: `${NAME} isn't signed in — magpie plugin login ${ID}`, signIn: "expired" })
            return errorResponse({ status: 501, message: `${NAME} transport not implemented yet — the ${ID} provider is a scaffold stub` })
          },
        }
      },
      methods: [
        {
          type: "oauth",
          label: "Drive the installed Grok Bot desktop app (default; zero credential)",
          authorize: grokBotCdpAuthorize,
        },
        {
          type: "oauth",
          label: "Direct Connect protocol (reads the app's local sign-in)",
          authorize: grokBotDirectAuthorize,
        },
      ],
    },
    async config(config) {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      config.provider[ID] = {
        name: NAME,
        npm: CHAT,
        api: BASE,
        ...was,
        models: { ...MODELS, ...(was.models ?? {}) },
      }
    },
    provider: {
      id: ID,
      async models(provider) {
        return provider.models
      },
    },
  }
}
