export function debug(provider, event) {
  if (!/^(1|true|yes|on)$/i.test(process.env.MAGPIE_CLOUD_AGENTS_DEBUG?.trim() ?? "")) return
  console.error(`[magpie-cloud-agents] ${provider}: ${event}`)
}
