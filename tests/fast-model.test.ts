import { describe, test, expect } from "bun:test"

import {
  FAST_SUFFIX,
  FAST_BETA_HEADER,
  parseFastModel,
  withFastVariants,
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

const makeTwin = (base: { id: string; label: string }) => ({
  ...base,
  id: `${base.id}-fast`,
})

describe("withFastVariants", () => {
  const capable = new Set(["a", "c"])

  test("emits a twin after each fast-capable entry, base-then-twin order", () => {
    const input = [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
    ]
    const out = withFastVariants(input, capable, makeTwin)
    expect(out.map((m) => m.id)).toEqual(["a", "a-fast", "b", "c", "c-fast"])
  })

  test("emits nothing extra when the set is empty", () => {
    const input = [{ id: "a", label: "A" }]
    const out = withFastVariants(input, new Set(), makeTwin)
    expect(out.map((m) => m.id)).toEqual(["a"])
  })

  test("the twin is produced by makeTwin (carries other fields)", () => {
    const input = [{ id: "a", label: "A" }]
    const out = withFastVariants(input, capable, makeTwin)
    expect(out[0]).toBe(input[0]) // base passed through by reference, not copied
    expect(out[1]).toEqual({ id: "a-fast", label: "A" })
  })
})
