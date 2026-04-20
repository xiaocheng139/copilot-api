import { describe, expect, test } from "bun:test"

import type {
  AnthropicMessage,
  AnthropicUserMessage,
} from "~/routes/messages/anthropic-types"

import { detectKeywordBudget } from "../src/routes/messages/non-stream-translation"

const userText = (text: string): AnthropicUserMessage => ({
  role: "user",
  content: [{ type: "text", text }],
})

const userString = (text: string): AnthropicUserMessage => ({
  role: "user",
  content: text,
})

describe("detectKeywordBudget", () => {
  test("bare `think` at start of message → 4000", () => {
    expect(detectKeywordBudget([userText("think about this")])).toBe(4000)
  })

  test("bare `think` mid-sentence → undefined", () => {
    expect(
      detectKeywordBudget([userText("I think we should refactor")]),
    ).toBeUndefined()
  })

  test("`think hard` → 10000", () => {
    expect(detectKeywordBudget([userText("think hard about X")])).toBe(10000)
  })

  test("`megathink` anywhere → 10000", () => {
    expect(detectKeywordBudget([userText("please megathink this one")])).toBe(
      10000,
    )
  })

  test("`ultrathink` → 31999", () => {
    expect(detectKeywordBudget([userText("ultrathink: refactor")])).toBe(31999)
  })

  test("`think harder` → 31999", () => {
    expect(detectKeywordBudget([userText("think harder about it")])).toBe(31999)
  })

  test("highest budget wins when multiple keywords present", () => {
    expect(detectKeywordBudget([userText("think hard, then ultrathink")])).toBe(
      31999,
    )
  })

  test("no keyword → undefined", () => {
    expect(detectKeywordBudget([userText("just do X")])).toBeUndefined()
  })

  test("substring `thinking` does not trigger (word boundary)", () => {
    expect(detectKeywordBudget([userText("thinking about it")])).toBeUndefined()
  })

  test("string-form user content is supported", () => {
    expect(detectKeywordBudget([userString("ultrathink please")])).toBe(31999)
  })

  test("empty messages → undefined", () => {
    expect(detectKeywordBudget([])).toBeUndefined()
  })

  test("only assistant/system messages → undefined", () => {
    const messages: Array<AnthropicMessage> = [
      { role: "assistant", content: "ultrathink" },
    ]
    expect(detectKeywordBudget(messages)).toBeUndefined()
  })

  test("walks back past image-only user turn", () => {
    const messages: Array<AnthropicMessage> = [
      userText("ultrathink the bug"),
      { role: "assistant", content: "ok" },
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "abc",
            },
          },
        ],
      },
    ]
    expect(detectKeywordBudget(messages)).toBe(31999)
  })

  test("walks back past tool_result-only user turn", () => {
    const messages: Array<AnthropicMessage> = [
      userText("ultrathink the refactor"),
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool_1",
            name: "read",
            input: { path: "x" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_1",
            content: "file contents",
          },
        ],
      },
    ]
    expect(detectKeywordBudget(messages)).toBe(31999)
  })

  test("sticky across multi-step tool loop", () => {
    const messages: Array<AnthropicMessage> = [
      userText("ultrathink: implement feature X"),
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "read", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "..." }],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t2", name: "edit", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }],
      },
    ]
    expect(detectKeywordBudget(messages)).toBe(31999)
  })

  test("all user turns are tool_result/image only → undefined", () => {
    const messages: Array<AnthropicMessage> = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }],
      },
    ]
    expect(detectKeywordBudget(messages)).toBeUndefined()
  })

  test("`think` inside fenced code block does not trigger", () => {
    const text = "review this:\n```\nthink about state\n```\n"
    expect(detectKeywordBudget([userText(text)])).toBeUndefined()
  })

  test("`ultrathink` inside fenced code block does NOT trigger", () => {
    // Compound triggers can match anywhere in the message, but fenced code
    // is stripped first — so they don't fire from inside ``` blocks.
    const text = "review this:\n```\nultrathink everything\n```\n"
    expect(detectKeywordBudget([userText(text)])).toBeUndefined()
  })

  test("trigger outside code block still fires when other text is fenced", () => {
    const text = "ultrathink this:\n```\njust some code\n```\n"
    expect(detectKeywordBudget([userText(text)])).toBe(31999)
  })
})
