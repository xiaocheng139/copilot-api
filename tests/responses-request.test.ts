import { describe, test, expect } from "bun:test"

import {
  ResponsesValidationError,
  translateResponsesToOpenAI,
} from "../src/routes/responses/request-translation"
import { type ResponsesRequest } from "../src/routes/responses/responses-types"

function basePayload(
  overrides: Partial<ResponsesRequest> = {},
): ResponsesRequest {
  return {
    model: "gpt-5",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    ],
    ...overrides,
  }
}

describe("translateResponsesToOpenAI - basic shapes", () => {
  test("translates a minimal text-only payload", () => {
    const { payload, syntheticToolMap } =
      translateResponsesToOpenAI(basePayload())
    expect(payload.model).toBe("gpt-5")
    expect(payload.messages).toEqual([{ role: "user", content: "hello" }])
    expect(syntheticToolMap.size).toBe(0)
  })

  test("forwards instructions as a system message", () => {
    const { payload } = translateResponsesToOpenAI(
      basePayload({ instructions: "be terse" }),
    )
    expect(payload.messages[0]).toEqual({
      role: "system",
      content: "be terse",
    })
    expect(payload.messages[1]).toEqual({ role: "user", content: "hello" })
  })

  test("maps developer role to system", () => {
    const { payload } = translateResponsesToOpenAI(
      basePayload({
        input: [
          {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "rules" }],
          },
        ],
      }),
    )
    expect(payload.messages[0].role).toBe("system")
  })

  test("emits image content parts when an input_image is present", () => {
    const { payload } = translateResponsesToOpenAI(
      basePayload({
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "look" },
              {
                type: "input_image",
                image_url: "https://example.com/x.png",
                detail: "high",
              },
            ],
          },
        ],
      }),
    )
    const content = payload.messages[0].content
    expect(Array.isArray(content)).toBe(true)
    if (Array.isArray(content)) {
      expect(content[0]).toEqual({ type: "text", text: "look" })
      expect(content[1]).toEqual({
        type: "image_url",
        image_url: { url: "https://example.com/x.png", detail: "high" },
      })
    }
  })

  test("forwards metadata.user_id as user", () => {
    const { payload } = translateResponsesToOpenAI(
      basePayload({ metadata: { user_id: "u_123" } }),
    )
    expect(payload.user).toBe("u_123")
  })
})

describe("translateResponsesToOpenAI - tool lowering", () => {
  test("function tool passes through verbatim", () => {
    const { payload, syntheticToolMap } = translateResponsesToOpenAI(
      basePayload({
        tools: [
          {
            type: "function",
            name: "search",
            description: "do a search",
            parameters: { type: "object", properties: {} },
          },
        ],
      }),
    )
    expect(payload.tools).toHaveLength(1)
    expect(payload.tools?.[0]).toEqual({
      type: "function",
      function: {
        name: "search",
        description: "do a search",
        parameters: { type: "object", properties: {} },
      },
    })
    expect(syntheticToolMap.size).toBe(0)
  })

  test("local_shell lowers to __cp_local_shell with mapping", () => {
    const { payload, syntheticToolMap } = translateResponsesToOpenAI(
      basePayload({ tools: [{ type: "local_shell" }] }),
    )
    expect(payload.tools).toHaveLength(1)
    expect(payload.tools?.[0].function.name).toBe("__cp_local_shell")
    expect(syntheticToolMap.get("__cp_local_shell")?.family).toBe("local_shell")
  })

  test("custom tool lowers to __cp_custom_<n> with original name retained", () => {
    const { payload, syntheticToolMap } = translateResponsesToOpenAI(
      basePayload({
        tools: [
          { type: "custom", name: "my_tool", description: "my desc" },
          { type: "custom", name: "other_tool" },
        ],
      }),
    )
    expect(payload.tools?.[0].function.name).toBe("__cp_custom_0")
    expect(payload.tools?.[1].function.name).toBe("__cp_custom_1")
    expect(syntheticToolMap.get("__cp_custom_0")).toEqual({
      family: "custom",
      originalName: "my_tool",
    })
    expect(syntheticToolMap.get("__cp_custom_1")).toEqual({
      family: "custom",
      originalName: "other_tool",
    })
  })

  test("web_search tool is silently dropped", () => {
    const { payload } = translateResponsesToOpenAI(
      basePayload({ tools: [{ type: "web_search" }] }),
    )
    expect(payload.tools).toBeUndefined()
  })

  test("rejects user-declared __cp_*-prefixed function tool", () => {
    expect(() =>
      translateResponsesToOpenAI(
        basePayload({
          tools: [{ type: "function", name: "__cp_evil", parameters: {} }],
        }),
      ),
    ).toThrow(ResponsesValidationError)
  })

  test("rejects __cp_*-prefixed historical function_call", () => {
    expect(() =>
      translateResponsesToOpenAI(
        basePayload({
          input: [
            {
              type: "function_call",
              call_id: "c1",
              name: "__cp_evil",
              arguments: "{}",
            },
          ],
        }),
      ),
    ).toThrow(ResponsesValidationError)
  })
})

describe("translateResponsesToOpenAI - tool_choice", () => {
  test("string tool_choice passes through", () => {
    const { payload } = translateResponsesToOpenAI(
      basePayload({ tool_choice: "auto" }),
    )
    expect(payload.tool_choice).toBe("auto")
  })

  test("function tool_choice maps to {type:function,function:{name}}", () => {
    const { payload } = translateResponsesToOpenAI(
      basePayload({
        tools: [{ type: "function", name: "search", parameters: {} }],
        tool_choice: { type: "function", name: "search" },
      }),
    )
    expect(payload.tool_choice).toEqual({
      type: "function",
      function: { name: "search" },
    })
  })

  test("custom tool_choice resolves to synthetic name", () => {
    const { payload } = translateResponsesToOpenAI(
      basePayload({
        tools: [{ type: "custom", name: "my_tool" }],
        tool_choice: { type: "custom", name: "my_tool" },
      }),
    )
    expect(payload.tool_choice).toEqual({
      type: "function",
      function: { name: "__cp_custom_0" },
    })
  })

  test("allowed_tools with single match pins that tool", () => {
    const { payload } = translateResponsesToOpenAI(
      basePayload({
        tools: [
          { type: "function", name: "a", parameters: {} },
          { type: "function", name: "b", parameters: {} },
        ],
        tool_choice: {
          type: "allowed_tools",
          tools: [{ type: "function", name: "a" }],
        },
      }),
    )
    expect(payload.tool_choice).toEqual({
      type: "function",
      function: { name: "a" },
    })
  })

  test("allowed_tools with multiple matches falls back to mode", () => {
    const { payload } = translateResponsesToOpenAI(
      basePayload({
        tools: [
          { type: "function", name: "a", parameters: {} },
          { type: "function", name: "b", parameters: {} },
        ],
        tool_choice: {
          type: "allowed_tools",
          mode: "required",
          tools: [
            { type: "function", name: "a" },
            { type: "function", name: "b" },
          ],
        },
      }),
    )
    expect(payload.tool_choice).toBe("required")
  })

  test("allowed_tools resolves local_shell to synthetic", () => {
    const { payload } = translateResponsesToOpenAI(
      basePayload({
        tools: [{ type: "local_shell" }],
        tool_choice: {
          type: "allowed_tools",
          tools: ["local_shell"],
        },
      }),
    )
    expect(payload.tool_choice).toEqual({
      type: "function",
      function: { name: "__cp_local_shell" },
    })
  })

  test("rejects allowed_tools referencing unknown function", () => {
    expect(() =>
      translateResponsesToOpenAI(
        basePayload({
          tools: [{ type: "function", name: "a", parameters: {} }],
          tool_choice: {
            type: "allowed_tools",
            tools: [{ type: "function", name: "missing" }],
          },
        }),
      ),
    ).toThrow(ResponsesValidationError)
  })

  test("rejects allowed_tools with empty tool list", () => {
    try {
      translateResponsesToOpenAI(
        basePayload({
          tools: [{ type: "function", name: "a", parameters: {} }],
          tool_choice: {
            type: "allowed_tools",
            tools: [],
          },
        }),
      )
      throw new Error("expected to throw")
    } catch (e) {
      expect(e).toBeInstanceOf(ResponsesValidationError)
      expect((e as ResponsesValidationError).code).toBe("empty_allowed_tools")
    }
  })

  test("rejects allowed_tools referencing web_search", () => {
    try {
      translateResponsesToOpenAI(
        basePayload({
          tool_choice: {
            type: "allowed_tools",
            tools: [
              { type: "function", name: "x" } as never,
              { type: "web_search" } as never,
            ],
          },
        }),
      )
      throw new Error("expected to throw")
    } catch (e) {
      expect(e).toBeInstanceOf(ResponsesValidationError)
      expect(
        ["unknown_tool_in_choice", "unsupported_tool_in_choice"].includes(
          (e as ResponsesValidationError).code,
        ),
      ).toBe(true)
    }
  })
})

describe("translateResponsesToOpenAI - reasoning effort → thinking_budget", () => {
  test("only applied for claude- models", () => {
    const { payload } = translateResponsesToOpenAI(
      basePayload({ model: "gpt-5", reasoning: { effort: "high" } }),
    )
    expect(payload.thinking_budget).toBeUndefined()
  })

  test("maps low/medium/high to anchored budgets for claude- models", () => {
    const low = translateResponsesToOpenAI(
      basePayload({ model: "claude-sonnet-4-5", reasoning: { effort: "low" } }),
    ).payload
    const medium = translateResponsesToOpenAI(
      basePayload({
        model: "claude-sonnet-4-5",
        reasoning: { effort: "medium" },
      }),
    ).payload
    const high = translateResponsesToOpenAI(
      basePayload({
        model: "claude-sonnet-4-5",
        reasoning: { effort: "high" },
      }),
    ).payload
    expect(low.thinking_budget).toBe(4000)
    expect(medium.thinking_budget).toBe(10000)
    expect(high.thinking_budget).toBe(31999)
  })

  test("minimal effort keeps thinking off", () => {
    const { payload } = translateResponsesToOpenAI(
      basePayload({
        model: "claude-sonnet-4-5",
        reasoning: { effort: "minimal" },
      }),
    )
    expect(payload.thinking_budget).toBeUndefined()
  })

  test("clamps thinking_budget to max_output_tokens - 1", () => {
    const { payload } = translateResponsesToOpenAI(
      basePayload({
        model: "claude-sonnet-4-5",
        reasoning: { effort: "high" },
        max_output_tokens: 1000,
      }),
    )
    expect(payload.thinking_budget).toBe(999)
  })

  test("dropping temperature/top_p when thinking is on", () => {
    const { payload } = translateResponsesToOpenAI(
      basePayload({
        model: "claude-sonnet-4-5",
        reasoning: { effort: "high" },
        temperature: 0.7,
        top_p: 0.9,
      }),
    )
    expect(payload.temperature).toBeUndefined()
    expect(payload.top_p).toBeUndefined()
  })
})

describe("translateResponsesToOpenAI - input lowering", () => {
  test("coalesces consecutive function_call items into one assistant msg", () => {
    const { payload } = translateResponsesToOpenAI(
      basePayload({
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "go" }],
          },
          {
            type: "function_call",
            call_id: "c1",
            name: "a",
            arguments: "{}",
          },
          {
            type: "function_call",
            call_id: "c2",
            name: "b",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "c1",
            output: "ok",
          },
        ],
      }),
    )
    // user, assistant(tool_calls=[c1,c2]), tool(c1)
    expect(payload.messages).toHaveLength(3)
    expect(payload.messages[1].role).toBe("assistant")
    expect(payload.messages[1].tool_calls).toHaveLength(2)
    expect(payload.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: "ok",
    })
  })

  test("local_shell_call lowers to assistant tool_call with synthetic name", () => {
    const { payload, syntheticToolMap } = translateResponsesToOpenAI(
      basePayload({
        input: [
          {
            type: "local_shell_call",
            call_id: "lsc1",
            action: { type: "exec", command: ["ls"] },
          },
        ],
      }),
    )
    expect(payload.messages[0].tool_calls?.[0].function.name).toBe(
      "__cp_local_shell",
    )
    expect(syntheticToolMap.has("__cp_local_shell")).toBe(true)
  })

  test("custom_tool_call without declared tool falls back to plain function call", () => {
    const { payload } = translateResponsesToOpenAI(
      basePayload({
        input: [
          {
            type: "custom_tool_call",
            call_id: "ctc1",
            name: "unmapped",
            input: "raw",
          },
        ],
      }),
    )
    const tc = payload.messages[0].tool_calls?.[0]
    expect(tc?.function.name).toBe("unmapped")
    expect(JSON.parse(tc?.function.arguments ?? "{}")).toEqual({
      input: "raw",
    })
  })

  test("custom_tool_call with declared tool uses synthetic name", () => {
    const { payload } = translateResponsesToOpenAI(
      basePayload({
        tools: [{ type: "custom", name: "my_tool" }],
        input: [
          {
            type: "custom_tool_call",
            call_id: "ctc1",
            name: "my_tool",
            input: "raw",
          },
        ],
      }),
    )
    const tc = payload.messages[0].tool_calls?.[0]
    expect(tc?.function.name).toBe("__cp_custom_0")
  })

  test("reasoning items are dropped", () => {
    const { payload } = translateResponsesToOpenAI(
      basePayload({
        input: [
          { type: "reasoning", summary: "thinking…" },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hi" }],
          },
        ],
      }),
    )
    expect(payload.messages).toHaveLength(1)
    expect(payload.messages[0].role).toBe("user")
  })
})

describe("translateResponsesToOpenAI - rejected continuation features", () => {
  test("previous_response_id is rejected", () => {
    expect(() =>
      translateResponsesToOpenAI(
        basePayload({ previous_response_id: "resp_x" }),
      ),
    ).toThrow(ResponsesValidationError)
  })

  test("store: true is rejected", () => {
    expect(() =>
      translateResponsesToOpenAI(basePayload({ store: true })),
    ).toThrow(ResponsesValidationError)
  })

  test("background: true is rejected", () => {
    expect(() =>
      translateResponsesToOpenAI(basePayload({ background: true })),
    ).toThrow(ResponsesValidationError)
  })
})
