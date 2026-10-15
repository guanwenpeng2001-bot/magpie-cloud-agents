import { sessionOf, SESSION_HEADER } from "./sessions.mjs"

export function chatHeaders(providerID) {
  return async (input, output) => {
    if ((input?.model?.providerID ?? input?.provider?.info?.id) !== providerID) return
    const session = sessionOf(input)
    if (session) {
      output.headers ??= {}
      output.headers[SESSION_HEADER] = session
    }
  }
}
