import { describe, test, expect } from "bun:test"

import {
  FAST_SUFFIX,
  FAST_BETA_HEADER,
  parseFastModel,
} from "../src/lib/fast-model"

describe("parseFastModel", () => {
  test("strips a trailing -fast suffix", () => {
    expect(parseFastModel("claude-opus-4.8-fast")).toEqual({
      baseModel: "claude-opus-4.8",
      isFast: true,
    })
  })

  test("leaves a non-fast model untouched", () => {
    expect(parseFastModel("claude-opus-4.8")).toEqual({
      baseModel: "claude-opus-4.8",
      isFast: false,
    })
  })

  test("strips exactly one suffix when doubled", () => {
    expect(parseFastModel("claude-opus-4.8-fast-fast")).toEqual({
      baseModel: "claude-opus-4.8-fast",
      isFast: true,
    })
  })

  test("treats a bare suffix as fast with empty base", () => {
    expect(parseFastModel("-fast")).toEqual({ baseModel: "", isFast: true })
  })

  test("handles the empty string", () => {
    expect(parseFastModel("")).toEqual({ baseModel: "", isFast: false })
  })

  test("is case sensitive — -FAST is not matched", () => {
    expect(parseFastModel("claude-opus-4.8-FAST")).toEqual({
      baseModel: "claude-opus-4.8-FAST",
      isFast: false,
    })
  })
})

describe("constants", () => {
  test("expose the agreed suffix and beta header", () => {
    expect(FAST_SUFFIX).toBe("-fast")
    expect(FAST_BETA_HEADER).toBe("fast-mode-2026-02-01")
  })
})
