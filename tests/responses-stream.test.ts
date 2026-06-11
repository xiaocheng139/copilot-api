import { describe, test, expect } from "bun:test"

import { type SyntheticToolMap } from "../src/routes/responses/request-translation"
import {
  createInitialStreamState,
  finalizeStream,
  translateChunkToResponsesEvents,
  translateNonStreamingResponse,
  type ResponsesStreamContext,
} from "../src/routes/responses/stream-translation"
import {
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "../src/services/copilot/create-chat-completions"

function ctx(map: SyntheticToolMap = new Map()): ResponsesStreamContext {
  return {
    responseId: "resp_test",
    model: "gpt-5",
    createdAt: 1_700_000_000,
    syntheticToolMap: map,
  }
}

function chunk(
  delta: NonNullable<ChatCompletionChunk["choices"]>[number]["delta"],
  finishReason:
    | ChatCompletionChunk["choices"][number]["finish_reason"]
    | null = null,
  usage?: ChatCompletionChunk["usage"],
): ChatCompletionChunk {
  return {
    id: "c0",
    object: "chat.completion.chunk",
    created: 0,
    model: "gpt-5",
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
    ...(usage && { usage }),
  }
}

function runChunks(
  chunks: Array<ChatCompletionChunk>,
  c: ResponsesStreamContext = ctx(),
) {
  const state = createInitialStreamState()
  const events = []
  for (const ch of chunks) {
    events.push(...translateChunkToResponsesEvents(ch, state, c))
  }
  return { state, events }
}

// Accumulate one text chunk, then finalize, and return the response.completed
// event (under either normal or transport-cut finalization).
function finalizeFromText(options: { transportCut?: boolean } = {}) {
  const state = createInitialStreamState()
  const c = ctx()
  const events = [
    ...translateChunkToResponsesEvents(chunk({ content: "partial" }), state, c),
    ...finalizeStream(state, c, options),
  ]
  return events.find((e) => e.type === "response.completed")
}

// Pull the status of the first message-typed output_item.done event, if any.
function messageDoneStatus(
  events: ReturnType<typeof finalizeStream>,
): string | undefined {
  const done = events.find((e) => e.type === "response.output_item.done")
  if (done?.type !== "response.output_item.done") return undefined
  return done.item.type === "message" ? done.item.status : undefined
}

describe("stream translation - text only", () => {
  test("emits created/in_progress, deltas, output_item.done, completed", () => {
    const { events } = runChunks([
      chunk({ content: "Hel" }),
      chunk({ content: "lo" }),
      chunk({}, "stop"),
    ])
    const types = events.map((e) => e.type)
    expect(types[0]).toBe("response.created")
    expect(types[1]).toBe("response.in_progress")
    expect(types).toContain("response.output_item.added")
    expect(
      types.filter((t) => t === "response.output_text.delta"),
    ).toHaveLength(2)
    expect(types).toContain("response.output_item.done")
    expect(types.at(-1)).toBe("response.completed")

    const completed = events.at(-1)
    if (completed?.type === "response.completed") {
      expect(completed.response.status).toBe("completed")
      const item = completed.response.output[0]
      if (item.type === "message") {
        expect(item.content[0].text).toBe("Hello")
      }
    }
  })
})

describe("stream translation - tool calls", () => {
  test("single function call passes args through", () => {
    const { events } = runChunks([
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "search", arguments: "" },
          },
        ],
      }),
      chunk({
        tool_calls: [{ index: 0, function: { arguments: '{"q":"hi"}' } }],
      }),
      chunk({}, "tool_calls"),
    ])
    const done = events.find((e) => e.type === "response.output_item.done")
    if (done?.type === "response.output_item.done") {
      const item = done.item
      if (item.type === "function_call") {
        expect(item.name).toBe("search")
        expect(item.arguments).toBe('{"q":"hi"}')
        expect(item.call_id).toBe("call_1")
      }
    }
  })

  test("parallel function calls produce two output items", () => {
    const { events } = runChunks([
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "c1",
            type: "function",
            function: { name: "a", arguments: "{}" },
          },
          {
            index: 1,
            id: "c2",
            type: "function",
            function: { name: "b", arguments: "{}" },
          },
        ],
      }),
      chunk({}, "tool_calls"),
    ])
    const dones = events.filter((e) => e.type === "response.output_item.done")
    expect(dones).toHaveLength(2)
  })

  test("local_shell raise: synthetic name → local_shell_call item", () => {
    const map: SyntheticToolMap = new Map([
      ["__cp_local_shell", { family: "local_shell" }],
    ])
    const { events } = runChunks(
      [
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "lsc1",
              type: "function",
              function: {
                name: "__cp_local_shell",
                arguments: '{"command":["ls","-la"]}',
              },
            },
          ],
        }),
        chunk({}, "tool_calls"),
      ],
      ctx(map),
    )
    const done = events.find((e) => e.type === "response.output_item.done")
    if (done?.type === "response.output_item.done") {
      expect(done.item.type).toBe("local_shell_call")
      if (done.item.type === "local_shell_call") {
        expect(done.item.action.command).toEqual(["ls", "-la"])
      }
    }
  })

  test("custom tool raise: synthetic → custom_tool_call with original name", () => {
    const map: SyntheticToolMap = new Map([
      ["__cp_custom_0", { family: "custom", originalName: "my_tool" }],
    ])
    const { events } = runChunks(
      [
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "ctc1",
              type: "function",
              function: {
                name: "__cp_custom_0",
                arguments: '{"input":"raw text"}',
              },
            },
          ],
        }),
        chunk({}, "tool_calls"),
      ],
      ctx(map),
    )
    const done = events.find((e) => e.type === "response.output_item.done")
    if (done?.type === "response.output_item.done") {
      expect(done.item.type).toBe("custom_tool_call")
      if (done.item.type === "custom_tool_call") {
        expect(done.item.name).toBe("my_tool")
        expect(done.item.input).toBe("raw text")
      }
    }
  })
})

describe("stream translation - error / failure paths", () => {
  test("malformed args on plain function call passes through", () => {
    const { events } = runChunks([
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "c1",
            type: "function",
            function: { name: "search", arguments: "{not json" },
          },
        ],
      }),
      chunk({}, "tool_calls"),
    ])
    const done = events.find((e) => e.type === "response.output_item.done")
    expect(done).toBeDefined()
    const completed = events.find((e) => e.type === "response.completed")
    expect(completed).toBeDefined()
  })

  test("malformed args on synthetic local_shell → response.failed", () => {
    const map: SyntheticToolMap = new Map([
      ["__cp_local_shell", { family: "local_shell" }],
    ])
    const { events } = runChunks(
      [
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "lsc1",
              type: "function",
              function: {
                name: "__cp_local_shell",
                arguments: "garbage",
              },
            },
          ],
        }),
        chunk({}, "tool_calls"),
      ],
      ctx(map),
    )
    const failed = events.find((e) => e.type === "response.failed")
    expect(failed).toBeDefined()
    if (failed?.type === "response.failed") {
      expect(failed.response.error?.code).toBe(
        "upstream_malformed_tool_arguments",
      )
    }
    expect(events.find((e) => e.type === "response.completed")).toBeUndefined()
  })

  test("malformed shape on synthetic custom → response.failed", () => {
    const map: SyntheticToolMap = new Map([
      ["__cp_custom_0", { family: "custom", originalName: "my_tool" }],
    ])
    const { events } = runChunks(
      [
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "ctc1",
              type: "function",
              function: {
                name: "__cp_custom_0",
                arguments: '{"wrong":"shape"}',
              },
            },
          ],
        }),
        chunk({}, "tool_calls"),
      ],
      ctx(map),
    )
    const failed = events.find((e) => e.type === "response.failed")
    expect(failed).toBeDefined()
  })

  test("undeclared __cp_* from upstream → response.failed", () => {
    const { events } = runChunks([
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "x1",
            type: "function",
            function: { name: "__cp_unknown", arguments: "{}" },
          },
        ],
      }),
      chunk({}, "tool_calls"),
    ])
    const failed = events.find((e) => e.type === "response.failed")
    expect(failed).toBeDefined()
    if (failed?.type === "response.failed") {
      expect(failed.response.error?.code).toBe("undeclared_synthetic_tool")
    }
  })
})

describe("stream translation - finish_reason mapping", () => {
  test("stop → completed", () => {
    const { events } = runChunks([chunk({ content: "ok" }), chunk({}, "stop")])
    const completed = events.find((e) => e.type === "response.completed")
    if (completed?.type === "response.completed") {
      expect(completed.response.status).toBe("completed")
    }
  })

  test("tool_calls → completed", () => {
    const { events } = runChunks([
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "c1",
            type: "function",
            function: { name: "a", arguments: "{}" },
          },
        ],
      }),
      chunk({}, "tool_calls"),
    ])
    const completed = events.find((e) => e.type === "response.completed")
    if (completed?.type === "response.completed") {
      expect(completed.response.status).toBe("completed")
    }
  })

  test("length → incomplete + max_output_tokens", () => {
    const { events } = runChunks([chunk({ content: "x" }), chunk({}, "length")])
    const completed = events.find((e) => e.type === "response.completed")
    if (completed?.type === "response.completed") {
      expect(completed.response.status).toBe("incomplete")
      expect(completed.response.incomplete_details?.reason).toBe(
        "max_output_tokens",
      )
    }
  })

  test("content_filter → incomplete + content_filter", () => {
    const { events } = runChunks([
      chunk({ content: "x" }),
      chunk({}, "content_filter"),
    ])
    const completed = events.find((e) => e.type === "response.completed")
    if (completed?.type === "response.completed") {
      expect(completed.response.incomplete_details?.reason).toBe(
        "content_filter",
      )
    }
  })
})

describe("stream translation - transport-cut handling", () => {
  test("text-only mid-stream cut emits valid item + incomplete completion", () => {
    const state = createInitialStreamState()
    const c = ctx()
    const events = [
      ...translateChunkToResponsesEvents(
        chunk({ content: "partial" }),
        state,
        c,
      ),
      ...finalizeStream(state, c, { transportCut: true }),
    ]
    const dones = events.filter((e) => e.type === "response.output_item.done")
    expect(dones).toHaveLength(1)
    const completed = events.find((e) => e.type === "response.completed")
    if (completed?.type === "response.completed") {
      expect(completed.response.status).toBe("incomplete")
    }
  })

  test("parallel cut with one valid + one malformed synthetic emits ONLY response.failed", () => {
    const map: SyntheticToolMap = new Map([
      ["__cp_local_shell", { family: "local_shell" }],
    ])
    const state = createInitialStreamState()
    const c = ctx(map)
    const events = [
      ...translateChunkToResponsesEvents(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "c_valid",
              type: "function",
              function: { name: "search", arguments: '{"q":"x"}' },
            },
            {
              index: 1,
              id: "c_bad",
              type: "function",
              function: {
                name: "__cp_local_shell",
                arguments: "broken",
              },
            },
          ],
        }),
        state,
        c,
      ),
      ...finalizeStream(state, c, { transportCut: true }),
    ]
    const dones = events.filter((e) => e.type === "response.output_item.done")
    expect(dones).toHaveLength(0)
    const failed = events.find((e) => e.type === "response.failed")
    expect(failed).toBeDefined()
    if (failed?.type === "response.failed") {
      expect(failed.response.error?.code).toBe(
        "stream_interrupted_malformed_tool_arguments",
      )
    }
    expect(events.find((e) => e.type === "response.completed")).toBeUndefined()
  })
})

describe("stream translation - usage propagation", () => {
  test("usage from terminal chunk surfaces in response.completed", () => {
    const { events } = runChunks([
      chunk({ content: "hi" }),
      chunk({}, "stop", {
        prompt_tokens: 12,
        completion_tokens: 3,
        total_tokens: 15,
      }),
    ])
    const completed = events.find((e) => e.type === "response.completed")
    if (completed?.type === "response.completed") {
      expect(completed.response.usage).toEqual({
        input_tokens: 12,
        output_tokens: 3,
        total_tokens: 15,
      })
    }
  })
})

describe("stream translation - [DONE] without finish_reason finalizes completed", () => {
  // The handler finalizes on a terminating [DONE] by calling finalizeStream
  // with no transportCut option. This pins that this path yields a *completed*
  // response (spec: "null + [DONE] -> completed"), not an incomplete one.
  test("default finalize (no transportCut) on accumulated text -> completed", () => {
    const state = createInitialStreamState()
    const c = ctx()
    const events = [
      ...translateChunkToResponsesEvents(chunk({ content: "hello" }), state, c),
      ...finalizeStream(state, c),
    ]
    const completed = events.find((e) => e.type === "response.completed")
    expect(completed).toBeDefined()
    if (completed?.type === "response.completed") {
      expect(completed.response.status).toBe("completed")
    }
    // The message item itself is completed, not incomplete.
    expect(messageDoneStatus(events)).toBe("completed")
  })

  test("default finalize differs from transportCut finalize (completed vs incomplete)", () => {
    const normal = finalizeFromText()
    const cut = finalizeFromText({ transportCut: true })
    if (normal?.type === "response.completed") {
      expect(normal.response.status).toBe("completed")
    }
    if (cut?.type === "response.completed") {
      expect(cut.response.status).toBe("incomplete")
    }
  })
})

describe("stream translation - non-streaming empty-string content", () => {
  // An assistant turn with content === "" is a legitimate (empty) text item and
  // must still be emitted as a message item, not silently dropped.
  test('content: "" still emits a message output item', () => {
    const response: ChatCompletionResponse = {
      id: "cmpl_empty",
      object: "chat.completion",
      created: 0,
      model: "gpt-5",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "" },
          logprobs: null,
          finish_reason: "stop",
        },
      ],
    }
    const envelope = translateNonStreamingResponse(response, ctx())
    expect(envelope.status).toBe("completed")
    const messageItems = envelope.output.filter((o) => o.type === "message")
    expect(messageItems).toHaveLength(1)
  })
})
