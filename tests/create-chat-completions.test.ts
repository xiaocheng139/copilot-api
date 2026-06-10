import { test, expect, mock } from "bun:test"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"

import { state } from "../src/lib/state"
import { createChatCompletions } from "../src/services/copilot/create-chat-completions"

// Mock state
state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

// Helper to mock fetch
const fetchMock = mock(
  (_url: string, opts: { headers: Record<string, string> }) => {
    return {
      ok: true,
      json: () => ({ id: "123", object: "chat.completion", choices: [] }),
      headers: opts.headers,
    }
  },
)
// @ts-expect-error - Mock fetch doesn't implement all fetch properties
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

test("sets X-Initiator to agent if tool/assistant present", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "tool", content: "tool call" },
    ],
    model: "gpt-test",
  }
  await createChatCompletions(payload)
  expect(fetchMock).toHaveBeenCalled()
  const headers = (
    fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("agent")
})

test("sets X-Initiator to user if only user present", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "user", content: "hello again" },
    ],
    model: "gpt-test",
  }
  await createChatCompletions(payload)
  expect(fetchMock).toHaveBeenCalled()
  const headers = (
    fetchMock.mock.calls[1][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("user")
})

test("fast model: strips -fast, sends base model + speed + beta header", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "claude-opus-4.8-fast",
  }
  await createChatCompletions(payload)

  const call = fetchMock.mock.calls.at(-1) as [
    string,
    { headers: Record<string, string>; body: string },
  ]
  const sentBody = JSON.parse(call[1].body) as { model: string; speed?: string }
  expect(sentBody.model).toBe("claude-opus-4.8")
  expect(sentBody.speed).toBe("fast")
  expect(call[1].headers["anthropic-beta"]).toBe("fast-mode-2026-02-01")
})

test("non-fast model: no speed field, no beta header", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "claude-opus-4.8",
  }
  await createChatCompletions(payload)

  const call = fetchMock.mock.calls.at(-1) as [
    string,
    { headers: Record<string, string>; body: string },
  ]
  const sentBody = JSON.parse(call[1].body) as { model: string; speed?: string }
  expect(sentBody.model).toBe("claude-opus-4.8")
  expect(sentBody.speed).toBeUndefined()
  expect(call[1].headers["anthropic-beta"]).toBeUndefined()
})

test("does not mutate the caller's payload object", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "claude-opus-4.8-fast",
  }
  await createChatCompletions(payload)

  // The clone must leave the caller's object pristine for logging/reuse.
  expect(payload.model).toBe("claude-opus-4.8-fast")
  expect((payload as { speed?: string }).speed).toBeUndefined()
})
