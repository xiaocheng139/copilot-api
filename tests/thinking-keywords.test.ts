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
})
