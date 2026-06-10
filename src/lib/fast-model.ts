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
