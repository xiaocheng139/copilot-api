import { test, expect, mock, afterAll } from "bun:test"

import { HTTPError } from "../src/lib/error"
import { requestJson } from "../src/lib/request"

const originalFetch = globalThis.fetch

afterAll(() => {
  globalThis.fetch = originalFetch
})

function mockFetch(result: {
  ok: boolean
  status?: number
  json?: unknown
  text?: string
}) {
  const fetchMock = mock((_url: string, _init: RequestInit) =>
    Promise.resolve({
      ok: result.ok,
      status: result.status ?? (result.ok ? 200 : 500),
      headers: new Headers(),
      json: () => Promise.resolve(result.json ?? {}),
      text: () => Promise.resolve(result.text ?? ""),
    } as unknown as Response),
  )
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
  return fetchMock
}

interface SampleResponse {
  id: string
}

test("requestJson returns the typed parsed json on an ok response", async () => {
  mockFetch({ ok: true, json: { id: "abc" } })

  const result = await requestJson<SampleResponse>(
    "https://example.test/resource",
    { headers: { accept: "application/json" } },
    "Failed to fetch resource",
  )

  expect(result).toEqual({ id: "abc" })
})

test("requestJson forwards url and init to fetch", async () => {
  const fetchMock = mockFetch({ ok: true, json: {} })
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ a: 1 }),
  }

  await requestJson("https://example.test/create", init, "Failed to create")

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(fetchMock.mock.calls[0][0]).toBe("https://example.test/create")
  expect(fetchMock.mock.calls[0][1]).toBe(init)
})

test("requestJson throws HTTPError carrying the message and response when not ok", async () => {
  mockFetch({ ok: false, status: 403, text: "forbidden" })

  let caught: unknown
  try {
    await requestJson(
      "https://example.test/denied",
      { headers: {} },
      "Failed to reach resource",
    )
  } catch (error) {
    caught = error
  }

  expect(caught).toBeInstanceOf(HTTPError)
  const httpError = caught as HTTPError
  expect(httpError.message).toBe("Failed to reach resource")
  expect(httpError.response.status).toBe(403)
})
