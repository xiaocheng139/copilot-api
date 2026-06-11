import {
  foldChunk,
  type StreamAccumulator,
} from "~/routes/_shared/stream-accumulator"
import { toAnthropicUsage } from "~/services/copilot/chat-completions-wire"
import { type ChatCompletionChunk } from "~/services/copilot/create-chat-completions"

import {
  type AnthropicStreamEventData,
  type AnthropicStreamState,
} from "./anthropic-types"
import { mapOpenAIStopReasonToAnthropic } from "./utils"

function isToolBlockOpen(state: AnthropicStreamState): boolean {
  if (!state.contentBlockOpen) {
    return false
  }
  // Check if the current block index corresponds to any known tool call
  return Object.values(state.toolCalls).some(
    (tc) => tc.anthropicBlockIndex === state.contentBlockIndex,
  )
}

function messageStartEvent(
  chunk: ChatCompletionChunk,
): AnthropicStreamEventData {
  return {
    type: "message_start",
    message: {
      id: chunk.id,
      type: "message",
      role: "assistant",
      content: [],
      model: chunk.model,
      stop_reason: null,
      stop_sequence: null,
      usage: toAnthropicUsage(chunk.usage, { outputTokens: 0 }),
    },
  }
}

export function translateChunkToAnthropicEvents(
  chunk: ChatCompletionChunk,
  state: AnthropicStreamState,
  accumulator: StreamAccumulator,
): Array<AnthropicStreamEventData> {
  const events: Array<AnthropicStreamEventData> = []

  // Fold the chunk into the neutral accumulator first; render from the delta.
  const delta = foldChunk(accumulator, chunk)

  if (chunk.choices.length === 0) {
    return events
  }

  const choice = chunk.choices[0]

  if (!state.messageStartSent) {
    events.push(messageStartEvent(chunk))
    state.messageStartSent = true
  }

  if (delta.textDelta !== undefined) {
    if (isToolBlockOpen(state)) {
      // A tool block was open, so close it before starting a text block.
      events.push({
        type: "content_block_stop",
        index: state.contentBlockIndex,
      })
      state.contentBlockIndex++
      state.contentBlockOpen = false
    }

    if (!state.contentBlockOpen) {
      events.push({
        type: "content_block_start",
        index: state.contentBlockIndex,
        content_block: {
          type: "text",
          text: "",
        },
      })
      state.contentBlockOpen = true
    }

    events.push({
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: {
        type: "text_delta",
        text: delta.textDelta,
      },
    })
  }

  // New tool calls (id + name arrived this chunk): open an Anthropic tool_use
  // block for each, mapping the upstream tool index to its block index.
  for (const started of delta.toolStarts) {
    if (state.contentBlockOpen) {
      // Close any previously open block.
      events.push({
        type: "content_block_stop",
        index: state.contentBlockIndex,
      })
      state.contentBlockIndex++
      state.contentBlockOpen = false
    }

    const anthropicBlockIndex = state.contentBlockIndex
    state.toolCalls[started.index] = {
      id: started.id ?? "",
      name: started.name ?? "",
      anthropicBlockIndex,
    }

    events.push({
      type: "content_block_start",
      index: anthropicBlockIndex,
      content_block: {
        type: "tool_use",
        id: started.id ?? "",
        name: started.name ?? "",
        input: {},
      },
    })
    state.contentBlockOpen = true
  }

  // Argument fragments: render an input_json_delta against the block index the
  // upstream tool index maps to.
  for (const { index, delta: partialJson } of delta.toolArgDeltas) {
    const toolCallInfo = state.toolCalls[index]
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (toolCallInfo) {
      events.push({
        type: "content_block_delta",
        index: toolCallInfo.anthropicBlockIndex,
        delta: {
          type: "input_json_delta",
          partial_json: partialJson,
        },
      })
    }
  }

  if (choice.finish_reason) {
    events.push(...finishEvents(state, choice.finish_reason, chunk.usage))
  }

  return events
}

function finishEvents(
  state: AnthropicStreamState,
  finishReason: NonNullable<
    ChatCompletionChunk["choices"][number]["finish_reason"]
  >,
  usage: ChatCompletionChunk["usage"],
): Array<AnthropicStreamEventData> {
  const events: Array<AnthropicStreamEventData> = []
  if (state.contentBlockOpen) {
    events.push({
      type: "content_block_stop",
      index: state.contentBlockIndex,
    })
    state.contentBlockOpen = false
  }
  events.push(
    {
      type: "message_delta",
      delta: {
        stop_reason: mapOpenAIStopReasonToAnthropic(finishReason),
        stop_sequence: null,
      },
      usage: toAnthropicUsage(usage),
    },
    {
      type: "message_stop",
    },
  )
  return events
}

export function translateErrorToAnthropicErrorEvent(): AnthropicStreamEventData {
  return {
    type: "error",
    error: {
      type: "api_error",
      message: "An unexpected error occurred during streaming.",
    },
  }
}
