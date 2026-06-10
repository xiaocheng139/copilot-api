import { describe, test, expect, mock } from "bun:test"

import {
  extractFastCapableIds,
  getFastCapableIds,
} from "../src/services/models-dev/get-fast-capable"

// Captured shape of models.dev /api.json (trimmed to the relevant structure).
const fixture = {
  "github-copilot": {
    models: {
      "claude-opus-4.8": {
        experimental: {
          modes: {
            fast: {
              provider: {
                body: { speed: "fast" },
                headers: { "anthropic-beta": "fast-mode-2026-02-01" },
              },
            },
          },
        },
      },
      "claude-sonnet-4.5": {},
    },
  },
  openai: {
    models: {
      "gpt-5": { experimental: { modes: { fast: {} } } },
    },
  },
}

describe("extractFastCapableIds", () => {
  test("collects github-copilot ids that have experimental.modes.fast", () => {
    expect(extractFastCapableIds(fixture)).toEqual(new Set(["claude-opus-4.8"]))
  })

  test("ignores other providers' fast modes", () => {
    // openai/gpt-5 is fast-capable on models.dev but must not appear.
    expect(extractFastCapableIds(fixture).has("gpt-5")).toBe(false)
  })

  test("returns an empty set when github-copilot is absent", () => {
    expect(extractFastCapableIds({})).toEqual(new Set())
  })

  test("returns an empty set when github-copilot has no models", () => {
    expect(extractFastCapableIds({ "github-copilot": {} })).toEqual(new Set())
  })

  test("never throws on a null model value (malformed external JSON)", () => {
    // models.dev is untrusted JSON; a model entry could be null. The pure
    // extractor must defend against it, not rely on the fetch wrapper's catch.
    const malformed = { "github-copilot": { models: { foo: null } } }
    expect(
      extractFastCapableIds(
        malformed as unknown as Parameters<typeof extractFastCapableIds>[0],
      ),
    ).toEqual(new Set())
  })
})

describe("getFastCapableIds (fail-open)", () => {
  test("returns the parsed set on a successful fetch", async () => {
    const fetchMock = mock(() => ({ ok: true, json: () => fixture }))
    // @ts-expect-error - partial fetch mock
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock
    expect(await getFastCapableIds()).toEqual(new Set(["claude-opus-4.8"]))
  })

  test("returns an empty set when fetch throws", async () => {
    const fetchMock = mock(() => {
      throw new Error("network down")
    })
    // @ts-expect-error - partial fetch mock
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock
    expect(await getFastCapableIds()).toEqual(new Set())
  })

  test("returns an empty set on a non-ok response", async () => {
    const fetchMock = mock(() => ({ ok: false, json: () => ({}) }))
    // @ts-expect-error - partial fetch mock
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock
    expect(await getFastCapableIds()).toEqual(new Set())
  })
})
