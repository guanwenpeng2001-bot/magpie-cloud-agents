const ID = "devin-cloud"
const NAME = "Devin Cloud"
const CHAT = "@ai-sdk/openai-compatible"
const BASE = "https://devin-cloud.cloud-agents.invalid/v1"

const MODELS = {
  "devin-session": { name: "Devin session", tool_call: false },
}

const errorResponse = ({ status, message, signIn = "kept" }) =>
  new Response(JSON.stringify({ error: { message, type: "cloud_agent_error", code: status } }), {
    status,
    headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": signIn },
  })

export function makeDevinCloud(options = {}) {
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
          label: "Devin API key",
          placeholder: "apk_user_… (app.devin.ai → Settings → API)",
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
