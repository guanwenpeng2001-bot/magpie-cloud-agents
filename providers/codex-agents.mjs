const ID = "codex-agents"
const NAME = "Codex Agents API"
const CHAT = "@ai-sdk/openai-compatible"
const BASE = "https://codex-agents.cloud-agents.invalid/v1"

const MODELS = {
  "gpt-6-astra": { name: "GPT-6 Astra", tool_call: false },
}

const errorResponse = ({ status, message, signIn = "kept" }) =>
  new Response(JSON.stringify({ error: { message, type: "cloud_agent_error", code: status } }), {
    status,
    headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": signIn },
  })

export function makeCodexAgents(options = {}) {
  return {
    auth: {
      provider: ID,
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        return {
          baseURL: BASE,
          async fetch(input, init = {}) {
            const now = await getAuth()
            if (now?.type !== "api" || !now.key)
              return errorResponse({ status: 401, message: `${NAME} isn't signed in — magpie plugin login ${ID}`, signIn: "expired" })
            return errorResponse({ status: 501, message: `${NAME} transport not implemented yet — the ${ID} provider is a scaffold stub` })
          },
        }
      },
      methods: [
        {
          type: "api",
          label: "OpenAI API key",
          placeholder: "sk-… (platform.openai.com → API keys)",
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
