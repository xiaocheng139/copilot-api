import { describe, expect, test } from "bun:test"

import {
  createStreamAccumulator,
  foldChunk,
} from "~/routes/_shared/stream-accumulator"
import { type ChatCompletionChunk } from "~/services/copilot/create-chat-completions"

// Minimal chunk builder — only the fields foldChunk reads.
function chunk(
  choices: ChatCompletionChunk["choices"],
  usage?: ChatCompletionChunk["usage"],
): ChatCompletionChunk {
  return {
    id: "chunk-1",
    object: "chat.completion.chunk",
    created: 0,
    model: "test-model",
    choices,
    ...(usage && { usage }),
  }
}

function textChoice(
  content: string,
  finish_reason: ChatCompletionChunk["choices"][number]["finish_reason"] = null,
): ChatCompletionChunk["choices"] {
  return [{ index: 0, delta: { content }, finish_reason, logprobs: null }]
}

describe("foldChunk — text accumulation", () => {
  test("concatenates text fragments and surfaces each delta", () => {
    const state = createStreamAccumulator()
    const d1 = foldChunk(state, chunk(textChoice("Hello")))
    const d2 = foldChunk(state, chunk(textChoice(", world")))

    expect(d1.textDelta).toBe("Hello")
    expect(d2.textDelta).toBe(", world")
    expect(state.textBuffer).toBe("Hello, world")
  })

  test("empty / absent content produces no textDelta", () => {
    const state = createStreamAccumulator()
    const d = foldChunk(state, chunk(textChoice("")))
    expect(d.textDelta).toBeUndefined()
    expect(state.textBuffer).toBe("")
  })

  test("no choices → empty delta, no throw", () => {
    const state = createStreamAccumulator()
    const d = foldChunk(state, chunk([]))
    expect(d.textDelta).toBeUndefined()
    expect(d.toolStarts).toHaveLength(0)
    expect(d.finishReason).toBeNull()
  })
})

describe("foldChunk — single tool call split across chunks", () => {
  test("id+name start once; argument fragments concatenate", () => {
    const state = createStreamAccumulator()

    const start = foldChunk(
      state,
      chunk([
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_a",
                type: "function",
                function: { name: "get_weather", arguments: "" },
              },
            ],
          },
          finish_reason: null,
          logprobs: null,
        },
      ]),
    )
    const frag1 = foldChunk(
      state,
      chunk([
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"city":' } }],
          },
          finish_reason: null,
          logprobs: null,
        },
      ]),
    )
    const frag2 = foldChunk(
      state,
      chunk([
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }],
          },
          finish_reason: null,
          logprobs: null,
        },
      ]),
    )

    expect(start.toolStarts).toHaveLength(1)
    expect(start.toolStarts[0].id).toBe("call_a")
    expect(start.toolStarts[0].name).toBe("get_weather")
    // Later fragments are NOT new starts.
    expect(frag1.toolStarts).toHaveLength(0)
    expect(frag2.toolStarts).toHaveLength(0)
    expect(frag1.toolArgDeltas).toEqual([{ index: 0, delta: '{"city":' }])

    const acc = state.toolCalls.get(0)
    expect(acc?.argumentsBuffer).toBe('{"city":"Paris"}')
    expect(state.toolCalls.size).toBe(1)
  })
})

describe("foldChunk — two concurrent tool calls (index alignment)", () => {
  test("interleaved indices accumulate independently, no cross-contamination", () => {
    const state = createStreamAccumulator()

    // Both tools start in one chunk, at indices 0 and 1.
    foldChunk(
      state,
      chunk([
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_0",
                type: "function",
                function: { name: "alpha", arguments: "" },
              },
              {
                index: 1,
                id: "call_1",
                type: "function",
                function: { name: "beta", arguments: "" },
              },
            ],
          },
          finish_reason: null,
          logprobs: null,
        },
      ]),
    )
    // Interleave argument fragments out of order.
    foldChunk(
      state,
      chunk([
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 1, function: { arguments: '{"b":1' } }],
          },
          finish_reason: null,
          logprobs: null,
        },
      ]),
    )
    foldChunk(
      state,
      chunk([
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"a":2' } }],
          },
          finish_reason: null,
          logprobs: null,
        },
      ]),
    )
    foldChunk(
      state,
      chunk([
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 1, function: { arguments: "}" } },
              { index: 0, function: { arguments: "}" } },
            ],
          },
          finish_reason: null,
          logprobs: null,
        },
      ]),
    )

    expect(state.toolCalls.size).toBe(2)
    expect(state.toolCalls.get(0)?.name).toBe("alpha")
    expect(state.toolCalls.get(0)?.id).toBe("call_0")
    expect(state.toolCalls.get(0)?.argumentsBuffer).toBe('{"a":2}')
    expect(state.toolCalls.get(1)?.name).toBe("beta")
    expect(state.toolCalls.get(1)?.id).toBe("call_1")
    expect(state.toolCalls.get(1)?.argumentsBuffer).toBe('{"b":1}')

    // First-seen iteration order is preserved (0 before 1).
    expect([...state.toolCalls.keys()]).toEqual([0, 1])
  })
})

describe("foldChunk — finish_reason and usage capture", () => {
  test("captures finish_reason on the terminal chunk", () => {
    const state = createStreamAccumulator()
    const d = foldChunk(state, chunk(textChoice("", "tool_calls")))
    expect(d.finishReason).toBe("tool_calls")
    expect(state.finishReason).toBe("tool_calls")
  })

  test("captures usage when present, independent of choices", () => {
    const state = createStreamAccumulator()
    const usage = {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    }
    const d = foldChunk(state, chunk([], usage))
    expect(d.usage).toEqual(usage)
    expect(state.usage).toEqual(usage)
  })
})
