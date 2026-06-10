import { describe, test, expect } from "bun:test"

import {
  errorTypeForStatus,
  isNonStreaming,
} from "../src/lib/completion-lifecycle"
import {
  type ChatCompletionResponse,
  type createChatCompletions,
} from "../src/services/copilot/create-chat-completions"

type CopilotResponse = Awaited<ReturnType<typeof createChatCompletions>>

describe("isNonStreaming", () => {
  test("returns true for an object carrying choices", () => {
    const response = {
      id: "cmpl-1",
      object: "chat.completion",
      created: 0,
      model: "gpt-4",
      choices: [],
    } as unknown as ChatCompletionResponse

    expect(isNonStreaming(response)).toBe(true)
  })

  test("returns false for a streaming async iterable", () => {
    const stream = {
      async *[Symbol.asyncIterator]() {
        // no chunks; presence of choices is what matters, not contents
      },
    } as unknown as CopilotResponse

    expect(isNonStreaming(stream)).toBe(false)
  })
})

describe("errorTypeForStatus", () => {
  test("maps statuses to anthropic-vocabulary type strings", () => {
    expect(errorTypeForStatus(400, "anthropic")).toBe("invalid_request_error")
    expect(errorTypeForStatus(401, "anthropic")).toBe("authentication_error")
    expect(errorTypeForStatus(403, "anthropic")).toBe("permission_error")
    expect(errorTypeForStatus(404, "anthropic")).toBe("not_found_error")
    expect(errorTypeForStatus(408, "anthropic")).toBe("timeout_error")
    expect(errorTypeForStatus(504, "anthropic")).toBe("timeout_error")
    expect(errorTypeForStatus(429, "anthropic")).toBe("rate_limit_error")
    expect(errorTypeForStatus(500, "anthropic")).toBe("api_error")
  })

  test("uses the generic error type for the openai vocabulary", () => {
    expect(errorTypeForStatus(401, "openai")).toBe("error")
    expect(errorTypeForStatus(500, "openai")).toBe("error")
  })
})
