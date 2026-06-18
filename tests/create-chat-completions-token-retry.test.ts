import { test, expect, mock, beforeEach, afterEach } from "bun:test"

import type { State } from "../src/lib/state"
import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"

import { HTTPError } from "../src/lib/error"
import { createChatCompletions } from "../src/services/copilot/create-chat-completions"

// These tests pin the auto-recovery contract: when Copilot rejects a request
// with an expired token (401/403) — which happens on the request path when the
// proactive refresh timer was frozen by a host suspend/resume — the proxy must
// refresh the Copilot token once and retry, in-process, instead of surfacing
// the error and depending on a crash + process-manager restart.
//
// They drive everything through the ARCH-005 injected-state seam and a single
// URL-routing fetch mock, so they never touch (or race on) the module global.

const GITHUB_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token"
const CHAT_URL = "https://api.githubcopilot.com/chat/completions"

interface MockResponse {
  ok: boolean
  status: number
  json: () => unknown
}

const ok = (): MockResponse => ({
  ok: true,
  status: 200,
  json: () => ({ id: "123", object: "chat.completion", choices: [] }),
})

const authFail = (status: number): MockResponse => ({
  ok: false,
  status,
  json: () => ({}),
})

const serverError = (): MockResponse => ({
  ok: false,
  status: 500,
  json: () => ({}),
})

const makeState = (overrides: Partial<State> = {}): State => ({
  accountType: "individual",
  fastCapableIds: new Set(),
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
  copilotToken: "stale-token",
  vsCodeVersion: "1.0.0",
  ...overrides,
})

const installFetchMock = (
  chatResponses: Array<MockResponse>,
  { tokenOk = true, newToken = "fresh-token" } = {},
) => {
  let chatCall = 0
  const fetchMock = mock((url: string) => {
    if (url === GITHUB_TOKEN_URL) {
      return Promise.resolve({
        ok: tokenOk,
        status: tokenOk ? 200 : 500,
        headers: new Headers(),
        text: () => Promise.resolve(""),
        json: () =>
          Promise.resolve({ token: newToken, expires_at: 0, refresh_in: 3600 }),
      } as unknown as Response)
    }
    if (url === CHAT_URL) {
      const r = chatResponses[Math.min(chatCall, chatResponses.length - 1)]
      chatCall += 1
      return Promise.resolve({
        ok: r.ok,
        status: r.status,
        headers: new Headers(),
        text: () => Promise.resolve(""),
        json: () => Promise.resolve(r.json()),
      } as unknown as Response)
    }
    throw new Error(`unexpected fetch url: ${url}`)
  })
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
  return fetchMock
}

const payload: ChatCompletionsPayload = {
  messages: [{ role: "user", content: "hi" }],
  model: "gpt-test",
}

type FetchMock = ReturnType<typeof installFetchMock>

const callsTo = (fetchMock: FetchMock, url: string) =>
  fetchMock.mock.calls.filter((c) => c[0] === url)

const authHeaderOf = (call: unknown) =>
  (call as [string, { headers: Record<string, string> }])[1].headers
    .Authorization

const captureError = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run()
  } catch (error) {
    return error
  }
  throw new Error("expected the call to throw, but it resolved")
}

// mock.restore() resets Bun mocks but does NOT undo a direct
// `globalThis.fetch = …` assignment, so capture the real fetch and put it back
// after each test to keep this mock from leaking into other test files.
const originalFetch = globalThis.fetch

beforeEach(() => {
  mock.restore()
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("401 on the request path refreshes the token and retries once, then succeeds", async () => {
  const fetchMock = installFetchMock([authFail(401), ok()])
  const state = makeState()

  const response = await createChatCompletions(payload, state)

  // The retry succeeded, so the caller sees a normal response, not an error.
  expect(response).toMatchObject({ object: "chat.completion" })
  // Exactly one refresh + exactly one retry (two chat calls total).
  expect(callsTo(fetchMock, GITHUB_TOKEN_URL)).toHaveLength(1)
  expect(callsTo(fetchMock, CHAT_URL)).toHaveLength(2)
  // The refreshed token landed in state and was used on the retry.
  expect(state.copilotToken).toBe("fresh-token")
  expect(authHeaderOf(callsTo(fetchMock, CHAT_URL)[0])).toBe(
    "Bearer stale-token",
  )
  expect(authHeaderOf(callsTo(fetchMock, CHAT_URL)[1])).toBe(
    "Bearer fresh-token",
  )
})

test("403 is treated the same as 401 (refresh + retry)", async () => {
  const fetchMock = installFetchMock([authFail(403), ok()])
  const state = makeState()

  const response = await createChatCompletions(payload, state)

  expect(response).toMatchObject({ object: "chat.completion" })
  expect(callsTo(fetchMock, GITHUB_TOKEN_URL)).toHaveLength(1)
  expect(callsTo(fetchMock, CHAT_URL)).toHaveLength(2)
  expect(authHeaderOf(callsTo(fetchMock, CHAT_URL)[1])).toBe(
    "Bearer fresh-token",
  )
})

test("a still-failing auth error after retry surfaces as an error (one refresh, one retry)", async () => {
  const fetchMock = installFetchMock([authFail(401), authFail(401)])
  const state = makeState()

  const error = await captureError(() => createChatCompletions(payload, state))

  expect(error).toBeInstanceOf(HTTPError)
  // We refresh once and retry once — we do NOT loop.
  expect(callsTo(fetchMock, GITHUB_TOKEN_URL)).toHaveLength(1)
  expect(callsTo(fetchMock, CHAT_URL)).toHaveLength(2)
})

test("a non-auth failure (500) is not retried and does not refresh the token", async () => {
  const fetchMock = installFetchMock([serverError()])
  const state = makeState()

  const error = await captureError(() => createChatCompletions(payload, state))

  expect(error).toBeInstanceOf(HTTPError)
  // No token refresh, no retry — only the single original chat call.
  expect(callsTo(fetchMock, GITHUB_TOKEN_URL)).toHaveLength(0)
  expect(callsTo(fetchMock, CHAT_URL)).toHaveLength(1)
})

test("a token refresh failure surfaces the original auth error without a wasted retry", async () => {
  // The GitHub token endpoint itself is down, so the refresh throws. Retrying
  // the chat call with the same stale token would just 401 again, so we skip
  // the retry and surface the ORIGINAL auth error — behavior is unchanged for a
  // genuinely unrecoverable auth failure, and we don't burn a pointless call.
  const fetchMock = installFetchMock([authFail(401)], { tokenOk: false })
  const state = makeState()

  const error = await captureError(() => createChatCompletions(payload, state))

  expect(error).toBeInstanceOf(HTTPError)
  // Refresh was attempted once; the original chat call is the only chat call.
  expect(callsTo(fetchMock, GITHUB_TOKEN_URL)).toHaveLength(1)
  expect(callsTo(fetchMock, CHAT_URL)).toHaveLength(1)
})
