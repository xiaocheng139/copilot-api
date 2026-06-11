import { describe, test, expect } from "bun:test"

import { translateModelName } from "../src/routes/messages/non-stream-translation"

describe("translateModelName fast-suffix preservation", () => {
  test("preserves -fast on a dotted opus id (today's models)", () => {
    expect(translateModelName("claude-opus-4.8-fast")).toBe(
      "claude-opus-4.8-fast",
    )
  })

  test("preserves -fast on a hyphenated/date-stamped opus id (the bug)", () => {
    // Base collapses (claude-opus-4-20250514 -> claude-opus-4) but the -fast
    // suffix must survive so the chokepoint can engage fast mode.
    expect(translateModelName("claude-opus-4-20250514-fast")).toBe(
      "claude-opus-4-fast",
    )
  })

  test("preserves -fast on a hyphenated sonnet id", () => {
    expect(translateModelName("claude-sonnet-4-20250514-fast")).toBe(
      "claude-sonnet-4-fast",
    )
  })

  test("non-fast hyphenated ids still collapse unchanged (no regression)", () => {
    expect(translateModelName("claude-opus-4-20250514")).toBe("claude-opus-4")
    expect(translateModelName("claude-sonnet-4-20250514")).toBe(
      "claude-sonnet-4",
    )
  })

  test("non-claude / passthrough ids are returned as-is", () => {
    expect(translateModelName("gpt-4o")).toBe("gpt-4o")
    expect(translateModelName("gpt-4o-fast")).toBe("gpt-4o-fast")
  })
})
