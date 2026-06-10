import { HTTPError } from "~/lib/error"

// Shared upstream-fetch helper: owns fetch + the !response.ok -> throw HTTPError
// check + the typed response.json() cast. Each json-returning service collapses
// to a URL + headers + type argument. Streaming responses (events(...)) and any
// non-throwing polling flows are intentionally NOT routed through this helper.
export async function requestJson<T>(
  url: string,
  init: RequestInit,
  errorMessage: string,
): Promise<T> {
  const response = await fetch(url, init)

  if (!response.ok) throw new HTTPError(errorMessage, response)

  return (await response.json()) as T
}
