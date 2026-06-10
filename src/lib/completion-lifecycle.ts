import type { Context } from "hono"

import { awaitApproval } from "~/lib/approval"
import { forwardError } from "~/lib/error"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  type ChatCompletionResponse,
  type createChatCompletions,
} from "~/services/copilot/create-chat-completions"

// Shared request-lifecycle primitives for the OpenAI / Anthropic / Responses
// route handlers. The per-endpoint translators and streaming loops genuinely
// differ and stay handler-local; only the policy that is byte-identical across
// all three lives here.

/**
 * Streaming-detection predicate. A non-streaming Copilot response is a plain
 * object carrying `choices`; a streaming response is an async iterable.
 */
export const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

/**
 * Entry gate run at the very start of a completion: enforce the configured
 * rate limit before any work is done.
 */
export async function enterCompletion(): Promise<void> {
  await checkRateLimit(state)
}

/**
 * Gate run after the request has been translated but before the upstream call:
 * block on manual approval when enabled.
 */
export async function applyRequestGating(): Promise<void> {
  if (state.manualApprove) await awaitApproval()
}

/** Client-facing error-envelope `type` vocabularies. */
export type ErrorVocabulary = "anthropic" | "openai"

/**
 * Map an HTTP status to the error-envelope `type` string for a given client
 * vocabulary. `"anthropic"` mirrors the Responses endpoint's prior bespoke
 * mapping; `"openai"` matches `forwardError`'s generic `"error"` type.
 */
export function errorTypeForStatus(
  status: number,
  vocab: ErrorVocabulary,
): string {
  if (vocab === "anthropic") {
    if (status === 400) return "invalid_request_error"
    if (status === 401) return "authentication_error"
    if (status === 403) return "permission_error"
    if (status === 404) return "not_found_error"
    if (status === 408 || status === 504) return "timeout_error"
    if (status === 429) return "rate_limit_error"
    return "api_error"
  }
  return "error"
}

/**
 * Wrap a route handler so any thrown error is rendered through the shared
 * `forwardError` envelope. Centralizes the try/catch every route.ts repeated.
 */
export const withErrorForwarding =
  (handler: (c: Context) => Promise<Response>) =>
  async (c: Context): Promise<Response> => {
    try {
      return await handler(c)
    } catch (error) {
      return await forwardError(c, error)
    }
  }
