import { test, expect, mock } from "bun:test"

import type { State } from "../src/lib/state"
import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"

import { state } from "../src/lib/state"
import { createChatCompletions } from "../src/services/copilot/create-chat-completions"

// These tests prove the ARCH-005 injection seam: a service can be driven by an
// explicitly-injected State *parameter* without touching the module-global
// singleton, which is what lets parallel tests stop racing on shared mutable
// state. We deliberately never assign to `state.*` here.

const installFetchMock = () => {
  const fetchMock = mock(
    (_url: string, opts: { headers: Record<string, string> }) => ({
      ok: true,
      json: () => ({ id: "123", object: "chat.completion", choices: [] }),
      headers: opts.headers,
    }),
  )
  // @ts-expect-error - Mock fetch doesn't implement all fetch properties
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock
  return fetchMock
}

const makeState = (overrides: Partial<State> = {}): State => ({
  accountType: "individual",
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
  ...overrides,
})

test("createChatCompletions uses an injected state without mutating the module global", async () => {
  // Snapshot the singleton so we can prove the injected call leaves it untouched,
  // regardless of what other test files may have set it to.
  const globalTokenBefore = state.copilotToken

  const fetchMock = installFetchMock()

  const injected = makeState({
    copilotToken: "injected-token",
    vsCodeVersion: "9.9.9",
  })

  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-test",
  }

  await createChatCompletions(payload, injected)

  // The outgoing request authenticated with the INJECTED token...
  const call = fetchMock.mock.calls.at(-1)
  if (!call) throw new Error("fetch was not called")
  const url = call[0]
  const headers = (call[1] as { headers: Record<string, string> }).headers
  expect(headers.Authorization).toBe("Bearer injected-token")
  expect(headers["editor-version"]).toBe("vscode/9.9.9")
  expect(url).toBe("https://api.githubcopilot.com/chat/completions")

  // ...and the module-global singleton was NOT mutated by the call.
  expect(state.copilotToken).toBe(globalTokenBefore)
})

test("createChatCompletions consults the injected state, not the singleton, for the token guard", async () => {
  installFetchMock()

  // Injected state has no copilotToken -> the guard must trip based on the
  // injected param, proving the parameter (not the global) is what's read.
  const injected = makeState()

  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-test",
  }

  try {
    await createChatCompletions(payload, injected)
    throw new Error("expected to throw")
  } catch (e) {
    expect((e as Error).message).toBe("Copilot token not found")
  }
})
