// Neutral, render-agnostic accumulation of an in-progress streamed turn.
//
// Both client-facing stream translators (Anthropic `messages/` and
// Codex/Responses `responses/`) fold Copilot ChatCompletions chunks into the
// same underlying facts: a text buffer, tool calls keyed by their UPSTREAM
// `tool_call.index`, the terminal `finish_reason`, and usage. The rendering
// then diverges completely (Anthropic content_block open/close vs. Responses
// output_item.added/done), so only the ACCUMULATION lives here.
//
// In particular this module is the single home of the tool-call index
// alignment rule that CLAUDE.md flags as subtle: a tool call is "new" the
// first time a chunk carries both `id` and `function.name` at a given index;
// every later fragment at that index appends to the same argument buffer.

import { type ChatCompletionChunk } from "~/services/copilot/create-chat-completions"

// A single tool call, accumulated across chunks. Keyed externally by `index`.
export interface ToolCallAccumulator {
  // Upstream OpenAI `tool_call.index` — the alignment key. Stable across the
  // chunks that make up one tool call.
  index: number
  // Set once, on the chunk that first carries them.
  id?: string
  name?: string
  // Concatenation of every `function.arguments` fragment seen at this index.
  argumentsBuffer: string
}

// The neutral in-progress-turn model. Translators keep their own rendering
// state separately and map onto these facts.
export interface StreamAccumulator {
  textBuffer: string
  // Insertion-ordered: a Map keyed by upstream tool index. Iteration order is
  // first-seen order, which both renderers rely on for output ordering.
  toolCalls: Map<number, ToolCallAccumulator>
  finishReason: ChatCompletionChunk["choices"][number]["finish_reason"] | null
  usage?: ChatCompletionChunk["usage"]
}

export function createStreamAccumulator(): StreamAccumulator {
  return {
    textBuffer: "",
    toolCalls: new Map(),
    finishReason: null,
  }
}

// What a single chunk changed. Renderers read this instead of re-walking the
// raw `delta` themselves, so the fold logic is never duplicated.
export interface ChunkDelta {
  // Present (and non-empty) when this chunk carried a text fragment.
  textDelta?: string
  // Tool calls whose `id` + `name` arrived on THIS chunk (i.e. just started).
  // Same accumulator objects held in `StreamAccumulator.toolCalls`.
  toolStarts: Array<ToolCallAccumulator>
  // Argument fragments carried on this chunk, paired with their tool index.
  toolArgDeltas: Array<{ index: number; delta: string }>
  // The chunk's `finish_reason`, if any (also stored on the accumulator).
  finishReason: ChatCompletionChunk["choices"][number]["finish_reason"] | null
  // The chunk's usage, if any (also stored on the accumulator).
  usage?: ChatCompletionChunk["usage"]
}

// Fold one chunk into `state`, returning what changed for the renderer.
//
// This is the ONE place that:
//   - decides when a tool call is "new" (`id` && `function.name` at an index
//     not yet seen), and
//   - appends streamed `function.arguments` fragments to the right buffer.
export function foldChunk(
  state: StreamAccumulator,
  chunk: ChatCompletionChunk,
): ChunkDelta {
  const delta: ChunkDelta = {
    toolStarts: [],
    toolArgDeltas: [],
    finishReason: null,
  }

  if (chunk.usage) {
    state.usage = chunk.usage
    delta.usage = chunk.usage
  }

  if (chunk.choices.length === 0) {
    return delta
  }

  const choice = chunk.choices[0]
  const { delta: chunkDelta } = choice

  if (typeof chunkDelta.content === "string" && chunkDelta.content.length > 0) {
    state.textBuffer += chunkDelta.content
    delta.textDelta = chunkDelta.content
  }

  if (chunkDelta.tool_calls) {
    for (const tc of chunkDelta.tool_calls) {
      let acc = state.toolCalls.get(tc.index)
      if (!acc && tc.id && tc.function?.name) {
        acc = {
          index: tc.index,
          id: tc.id,
          name: tc.function.name,
          argumentsBuffer: "",
        }
        state.toolCalls.set(tc.index, acc)
        delta.toolStarts.push(acc)
      }
      if (!acc) continue

      if (tc.function?.arguments) {
        acc.argumentsBuffer += tc.function.arguments
        delta.toolArgDeltas.push({
          index: tc.index,
          delta: tc.function.arguments,
        })
      }
    }
  }

  if (choice.finish_reason) {
    state.finishReason = choice.finish_reason
    delta.finishReason = choice.finish_reason
  }

  return delta
}
