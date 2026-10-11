const ID = "codex-cloud"
const NAME = "Codex Cloud (codex CLI)"
const CHAT = "@ai-sdk/openai-compatible"
const BASE = "https://codex-cloud.cloud-agents.invalid/v1"

const MODELS = {
  "cloud-task": { name: "Codex Cloud task", tool_call: false },
}

const errorResponse = ({ status, message, signIn = "kept" }) =>
  new Response(JSON.stringify({ error: { message, type: "cloud_agent_error", code: status } }), {
    status,
    headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": signIn },
  })

function codexCloudAuthorize() {
  return {
    url: "",
    instructions: NAME + " transport not implemented yet; sign-in is unavailable in this scaffold.",
    method: "auto",
    callback: async () => ({ type: "failed", error: NAME + " transport not implemented yet" }),
  }
}

export function makeCodexCloud(options = {}) {
  return {
    auth: {
      provider: ID,
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "oauth" || !auth.env) return {}
        return {
          baseURL: BASE,
          async fetch(input, init = {}) {
            const now = await getAuth()
            if (now?.type !== "oauth" || !now.env)
              return errorResponse({ status: 401, message: `${NAME} isn't signed in — magpie plugin login ${ID}`, signIn: "expired" })
            return errorResponse({ status: 501, message: `${NAME} transport not implemented yet — the ${ID} provider is a scaffold stub` })
          },
        }
      },
      methods: [
        {
          type: "oauth",
          label: "This machine's codex CLI login (ChatGPT)",
          prompts: [
            {
              type: "text",
              key: "env",
              message: "Codex Cloud environment id (Codex web → Environments; used as `codex cloud exec --env`)",
              validate: (v) => (v && v.trim() ? undefined : "an environment id is required"),
            },
          ],
          authorize: codexCloudAuthorize,
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
