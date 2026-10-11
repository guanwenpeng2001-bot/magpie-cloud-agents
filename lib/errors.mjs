export class FollowupRejected extends Error {
  constructor(message = "follow-up rejected") { super(message); this.name = "FollowupRejected" }
}
export function chatError(status, message, signIn = status === 401 ? "expired" : "kept") {
  return Object.assign(new Error(String(message).slice(0, 4096)), { status, signIn })
}
export function normalizeError(error, driver = {}) {
  const status = error?.signIn === "expired" ? 401 : Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 502
  let message = String(error?.message ?? error).slice(0, 4096)
  if (status === 401 && driver.id) message += ` — sign in again with magpie plugin login ${driver.id}`
  const mapped = chatError(status, message, error?.signIn ?? (status === 401 ? "expired" : "kept"))
  if (error?.retryAfter != null) mapped.retryAfter = error.retryAfter
  return mapped
}
export const errorBody = error => ({ error: { message: error.message, type: "cloud_agent_error", code: error.status } })
export function errorResponse(error, driver) {
  const mapped = normalizeError(error, driver)
  return Response.json(errorBody(mapped), { status: mapped.status, headers: { "X-Magpie-Sign-In": mapped.signIn, ...(mapped.retryAfter != null ? { "Retry-After": String(mapped.retryAfter) } : {}) } })
}
