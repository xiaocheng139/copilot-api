import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"
import { streamSSE } from "hono/streaming"
import { randomBytes } from "node:crypto"

import { awaitApproval } from "~/lib/approval"
import { HTTPError } from "~/lib/error"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import {
  ResponsesValidationError,
  translateResponsesToOpenAI,
} from "./request-translation"
import { type ResponsesRequest } from "./responses-types"
import {
  createInitialStreamState,
  finalizeStream,
  translateChunkToResponsesEvents,
  translateNonStreamingResponse,
  translateStreamErrorToResponsesEvent,
  type ResponsesStreamContext,
} from "./stream-translation"

// eslint-disable-next-line max-lines-per-function
export async function handleResponses(c: Context) {
  await checkRateLimit(state)

  const responsesPayload = await c.req.json<ResponsesRequest>()
  consola.debug("Responses request payload:", JSON.stringify(responsesPayload))

  let translation
  try {
    translation = translateResponsesToOpenAI(responsesPayload)
  } catch (error) {
    if (error instanceof ResponsesValidationError) {
      return c.json(
        {
          error: {
            type: errorTypeForStatus(error.status),
            message: error.message,
            code: error.code,
          },
        },
        error.status as ContentfulStatusCode,
      )
    }
    throw error
  }

  const { payload: openAIPayload, syntheticToolMap } = translation
  consola.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  if (state.manualApprove) {
    await awaitApproval()
  }

  const ctx: ResponsesStreamContext = {
    responseId: `resp_${randomBytes(12).toString("hex")}`,
    model: responsesPayload.model,
    createdAt: Math.floor(Date.now() / 1000),
    syntheticToolMap,
  }

  let response
  try {
    response = await createChatCompletions(openAIPayload)
  } catch (error) {
    // Pre-stream upstream failure → HTTP error envelope.
    if (error instanceof HTTPError) {
      const status = error.response.status
      const text = await error.response.text()
      return c.json(
        {
          error: {
            type: errorTypeForStatus(status),
            message: text || error.message,
          },
        },
        status as ContentfulStatusCode,
      )
    }
    throw error
  }

  if (isNonStreaming(response)) {
    consola.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response).slice(-400),
    )
    const envelope = translateNonStreamingResponse(response, ctx)
    return c.json(envelope)
  }

  consola.debug("Streaming response from Copilot")
  return streamSSE(c, async (stream) => {
    const streamState = createInitialStreamState()
    let receivedAnyChunk = false

    const writeEvents = async (events: ReturnType<typeof finalizeStream>) => {
      for (const event of events) {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }

    try {
      for await (const rawEvent of response) {
        if (rawEvent.data === "[DONE]") {
          // Normal termination. If the stream never carried a terminal chunk
          // with a non-null finish_reason, finalize here as a completed
          // response (spec: "null + [DONE] → completed") rather than letting
          // the post-loop guard treat it as a transport cut.
          if (receivedAnyChunk && !streamState.finalized) {
            streamState.finalized = true
            await writeEvents(finalizeStream(streamState, ctx))
          }
          break
        }
        if (!rawEvent.data) continue

        const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
        receivedAnyChunk = true
        await writeEvents(
          translateChunkToResponsesEvents(chunk, streamState, ctx),
        )
      }
    } catch (error) {
      consola.error("Stream translation error:", error)
      if (streamState.responseCreatedSent) {
        const failed = translateStreamErrorToResponsesEvent(error, ctx)
        await stream.writeSSE({
          event: failed.type,
          data: JSON.stringify(failed),
        })
      }
      return
    }

    // Detect transport cut: stream ended without finish_reason and without
    // a [DONE] terminator that would have triggered finalization.
    if (!streamState.finalized) {
      if (!receivedAnyChunk) {
        // Should not happen — pre-stream errors are caught earlier.
        const failed = translateStreamErrorToResponsesEvent(
          new Error("Upstream stream produced no content."),
          ctx,
        )
        await stream.writeSSE({
          event: failed.type,
          data: JSON.stringify(failed),
        })
        return
      }
      await writeEvents(
        finalizeStream(streamState, ctx, { transportCut: true }),
      )
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

function errorTypeForStatus(status: number): string {
  if (status === 400) return "invalid_request_error"
  if (status === 401) return "authentication_error"
  if (status === 403) return "permission_error"
  if (status === 404) return "not_found_error"
  if (status === 408 || status === 504) return "timeout_error"
  if (status === 429) return "rate_limit_error"
  if (status >= 500) return "api_error"
  return "api_error"
}
