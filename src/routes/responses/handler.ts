import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"
import { streamSSE } from "hono/streaming"
import { randomBytes } from "node:crypto"

import {
  applyRequestGating,
  enterCompletion,
  errorTypeForStatus,
  isNonStreaming,
} from "~/lib/completion-lifecycle"
import { HTTPError } from "~/lib/error"
import {
  createChatCompletions,
  type ChatCompletionChunk,
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
  await enterCompletion()

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
            type: errorTypeForStatus(error.status, "anthropic"),
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

  await applyRequestGating()

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
            type: errorTypeForStatus(status, "anthropic"),
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

    try {
      for await (const rawEvent of response) {
        if (rawEvent.data === "[DONE]") {
          break
        }
        if (!rawEvent.data) continue

        const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
        receivedAnyChunk = true
        const events = translateChunkToResponsesEvents(chunk, streamState, ctx)
        for (const event of events) {
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          })
        }
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
      const events = finalizeStream(streamState, ctx, { transportCut: true })
      for (const event of events) {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }
  })
}
