import { describe, test, expect, mock, beforeEach } from "bun:test"

import { state } from "../src/lib/state"
import { responseRoutes } from "../src/routes/responses/route"

// Minimal in-memory fetch mock used by createChatCompletions.
state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

interface FetchMockResult {
  ok?: boolean
  status?: number
  text?: string
  json?: unknown
}

let nextFetchResult: FetchMockResult = { ok: true, status: 200, json: {} }

const fetchMock = mock(() => {
  const r = nextFetchResult
  return Promise.resolve({
    ok: r.ok ?? true,
    status: r.status ?? 200,
    headers: new Headers(),
    text: () => Promise.resolve(r.text ?? ""),
    json: () => Promise.resolve(r.json ?? {}),
  } as unknown as Response)
})
;(globalThis as unknown as { fetch: typeof fetch }).fetch =
  fetchMock as unknown as typeof fetch

async function postResponses(body: unknown): Promise<Response> {
  return responseRoutes.fetch(
    new Request("http://test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )
}

beforeEach(() => {
  state.manualApprove = false
  state.rateLimitWait = false
  state.rateLimitSeconds = undefined
  state.lastRequestTimestamp = undefined
  nextFetchResult = { ok: true, status: 200, json: {} }
})

const minimalRequest = {
  model: "gpt-5",
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hi" }],
    },
  ],
}

describe("pre-stream errors", () => {
  test("rejects previous_response_id with 400 + invalid_request_error", async () => {
    const res = await postResponses({
      ...minimalRequest,
      previous_response_id: "resp_x",
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { type: string; code: string } }
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.code).toBe("unsupported_responses_field")
  })

  test("rejects store: true with 400", async () => {
    const res = await postResponses({ ...minimalRequest, store: true })
    expect(res.status).toBe(400)
  })

  test("rejects background: true with 400", async () => {
    const res = await postResponses({ ...minimalRequest, background: true })
    expect(res.status).toBe(400)
  })

  test("rejects reserved tool name in tools[]", async () => {
    const res = await postResponses({
      ...minimalRequest,
      tools: [{ type: "function", name: "__cp_oops", parameters: {} }],
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("reserved_tool_name")
  })

  test("rejects reserved tool name in historical input function_call", async () => {
    const res = await postResponses({
      ...minimalRequest,
      input: [
        ...minimalRequest.input,
        {
          type: "function_call",
          call_id: "c1",
          name: "__cp_evil",
          arguments: "{}",
        },
      ],
    })
    expect(res.status).toBe(400)
  })

  test("rate-limit denial returns 429 envelope", async () => {
    state.rateLimitSeconds = 60
    state.lastRequestTimestamp = Date.now()
    state.rateLimitWait = false

    const res = await postResponses(minimalRequest)
    expect(res.status).toBe(429)
  })

  test("upstream non-OK before first chunk → HTTP envelope (not SSE)", async () => {
    nextFetchResult = {
      ok: false,
      status: 502,
      text: "bad gateway",
    }
    const res = await postResponses(minimalRequest)
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe("api_error")
  })

  test("upstream 401 produces authentication_error", async () => {
    nextFetchResult = { ok: false, status: 401, text: "no auth" }
    const res = await postResponses(minimalRequest)
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe("authentication_error")
  })

  test("upstream 429 produces rate_limit_error", async () => {
    nextFetchResult = { ok: false, status: 429, text: "slow down" }
    const res = await postResponses(minimalRequest)
    expect(res.status).toBe(429)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe("rate_limit_error")
  })
})
