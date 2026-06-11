import { describe, expect, test } from "bun:test"

import {
  applyThinkingBudget,
  buildFunctionTool,
  combineBudgetFloor,
  lowerContentParts,
  resolveThinkingBudget,
  toAnthropicUsage,
  type WireContentPiece,
} from "~/services/copilot/chat-completions-wire"

describe("resolveThinkingBudget", () => {
  test("undefined / non-positive requested → undefined", () => {
    expect(resolveThinkingBudget(undefined, 1000)).toBeUndefined()
    expect(resolveThinkingBudget(0, 1000)).toBeUndefined()
    expect(resolveThinkingBudget(-5, 1000)).toBeUndefined()
  })

  test("clamps to max_tokens - 1", () => {
    expect(resolveThinkingBudget(5000, 500)).toBe(499)
  })

  test("passes through when under the ceiling", () => {
    expect(resolveThinkingBudget(4000, 64000)).toBe(4000)
  })

  test("absent maxTokens forwards requested unclamped (Responses path)", () => {
    expect(resolveThinkingBudget(31999, undefined)).toBe(31999)
  })

  test("maxTokens <= 1 disables thinking (no budget can satisfy budget < max_tokens)", () => {
    expect(resolveThinkingBudget(10, 1)).toBeUndefined()
    expect(resolveThinkingBudget(10, 0)).toBeUndefined()
  })
})

describe("combineBudgetFloor", () => {
  test("both present → the larger wins (floor semantics)", () => {
    expect(combineBudgetFloor(4000, 10000)).toBe(10000)
    expect(combineBudgetFloor(31999, 4000)).toBe(31999)
  })

  test("only one present → that one wins", () => {
    expect(combineBudgetFloor(4000, undefined)).toBe(4000)
    expect(combineBudgetFloor(undefined, 10000)).toBe(10000)
  })

  test("neither present → undefined", () => {
    expect(combineBudgetFloor(undefined, undefined)).toBeUndefined()
  })
})

describe("applyThinkingBudget", () => {
  test("thinking off → sampling params pass through, no thinking_budget", () => {
    const out = applyThinkingBudget(undefined, { temperature: 0.7, top_p: 0.9 })
    expect(out).toEqual({ temperature: 0.7, top_p: 0.9 })
    expect("thinking_budget" in out).toBe(false)
  })

  test("thinking on → drops temperature/top_p, spreads thinking_budget", () => {
    const out = applyThinkingBudget(8000, { temperature: 0.7, top_p: 0.9 })
    expect(out.temperature).toBeUndefined()
    expect(out.top_p).toBeUndefined()
    expect(out.thinking_budget).toBe(8000)
  })
})

describe("buildFunctionTool", () => {
  test("emits the Copilot {type:function,function} shape", () => {
    expect(
      buildFunctionTool({
        name: "search",
        description: "do a search",
        parameters: { type: "object", properties: {} },
      }),
    ).toEqual({
      type: "function",
      function: {
        name: "search",
        description: "do a search",
        parameters: { type: "object", properties: {} },
      },
    })
  })

  test("defaults parameters to an empty object schema", () => {
    expect(buildFunctionTool({ name: "noop" }).function.parameters).toEqual({
      type: "object",
      properties: {},
    })
  })
})

describe("lowerContentParts", () => {
  test("text-only collapses to a newline-joined string", () => {
    const pieces: Array<WireContentPiece> = [
      { kind: "text", text: "a" },
      { kind: "text", text: "b" },
    ]
    expect(lowerContentParts(pieces)).toBe("a\n\nb")
  })

  test("empty text input → empty string", () => {
    expect(lowerContentParts([])).toBe("")
  })

  test("any image switches to ContentPart[] and keeps order", () => {
    const pieces: Array<WireContentPiece> = [
      { kind: "text", text: "look" },
      { kind: "image", url: "https://x/y.png", detail: "high" },
    ]
    expect(lowerContentParts(pieces)).toEqual([
      { type: "text", text: "look" },
      {
        type: "image_url",
        image_url: { url: "https://x/y.png", detail: "high" },
      },
    ])
  })

  test("image without detail omits the detail key", () => {
    const out = lowerContentParts([
      { kind: "image", url: "data:image/png;base64,AA" },
    ])
    expect(out).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
    ])
  })
})

describe("toAnthropicUsage", () => {
  test("subtracts cached tokens from prompt for input_tokens", () => {
    expect(
      toAnthropicUsage({
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 30 },
      }),
    ).toEqual({
      input_tokens: 70,
      output_tokens: 20,
      cache_read_input_tokens: 30,
    })
  })

  test("no cached details → no cache_read_input_tokens key", () => {
    const out = toAnthropicUsage({ prompt_tokens: 9, completion_tokens: 12 })
    expect(out).toEqual({ input_tokens: 9, output_tokens: 12 })
    expect("cache_read_input_tokens" in out).toBe(false)
  })

  test("undefined usage → zeroed", () => {
    expect(toAnthropicUsage(undefined)).toEqual({
      input_tokens: 0,
      output_tokens: 0,
    })
  })

  test("outputTokens override pins output (streaming message_start)", () => {
    const out = toAnthropicUsage(
      { prompt_tokens: 50, completion_tokens: 12 },
      { outputTokens: 0 },
    )
    expect(out.output_tokens).toBe(0)
    expect(out.input_tokens).toBe(50)
  })
})
