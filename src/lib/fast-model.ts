export const FAST_SUFFIX = "-fast"
export const FAST_BETA_HEADER = "fast-mode-2026-02-01"

export interface ParsedFastModel {
  baseModel: string
  isFast: boolean
}

/**
 * Split a `-fast` variant id into its base model and a fast flag.
 *
 * "claude-opus-4.8-fast" -> { baseModel: "claude-opus-4.8", isFast: true }
 * "claude-opus-4.8"      -> { baseModel: "claude-opus-4.8", isFast: false }
 *
 * Strips exactly one trailing `-fast`. Case sensitive. The only edge input is
 * "" (-> { baseModel: "", isFast: false }); a bare "-fast" yields
 * { baseModel: "", isFast: true }.
 */
export function parseFastModel(model: string): ParsedFastModel {
  if (model.endsWith(FAST_SUFFIX)) {
    return { baseModel: model.slice(0, -FAST_SUFFIX.length), isFast: true }
  }
  return { baseModel: model, isFast: false }
}

/**
 * Given real model entries and the fast-capable id set, return each base entry
 * immediately followed by a synthesized `-fast` twin when its id is fast-capable.
 * `makeTwin` is supplied by the caller so the twin matches that surface's object
 * shape (the /models response shape, or the picker's id-bearing model object).
 */
export function withFastVariants<T extends { id: string }>(
  models: Array<T>,
  fastCapableIds: Set<string>,
  makeTwin: (base: T) => T,
): Array<T> {
  const result: Array<T> = []
  for (const model of models) {
    result.push(model)
    if (fastCapableIds.has(model.id)) {
      result.push(makeTwin(model))
    }
  }
  return result
}
