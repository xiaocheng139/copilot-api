// Neutral primitives for talking to GitHub Copilot's ChatCompletions wire
// shape. Both client-facing translators (Anthropic `messages/` and
// Codex/Responses `responses/`) reshape their own vocabulary onto these
// shared transforms, so the invariants below live in exactly one place:
//
//   - thinking-budget resolution (the budget < max_tokens-1 clamp, the
//     keyword/explicit floor combine, and the "thinking-on → drop
//     temperature/top_p, spread thinking_budget" rule),
//   - function-tool lowering into Copilot's {type,function} shape,
//   - text/image content-part lowering (hasImage gate),
//   - Anthropic usage reshaping (input_tokens = prompt_tokens - cached_tokens).
//
// `detectKeywordBudget` also lives here so the responses translator no longer
// reaches across into the messages translator's file for it.

import {
  type ContentPart,
  type Tool,
} from "~/services/copilot/create-chat-completions"

// ----- Thinking-budget resolution ------------------------------------------

// vscode-copilot-chat clamps the budget to [min, maxBudget, max_tokens-1].
// We don't know the per-model min/max here, so we only enforce the max_tokens-1
// invariant Anthropic requires (budget < max_tokens). Copilot's broker handles
// per-model clamping on its side. When maxTokens is unknown (Responses allows
// an absent max_output_tokens) the requested value is forwarded unclamped.
// When maxTokens <= 1 no positive budget can satisfy budget < max_tokens, so
// thinking is disabled (undefined) rather than emitting an invalid payload.
export function resolveThinkingBudget(
  requested: number | undefined,
  maxTokens: number | undefined,
): number | undefined {
  if (requested === undefined || requested <= 0) return undefined
  if (maxTokens === undefined) return requested
  if (maxTokens <= 1) return undefined
  return Math.min(requested, maxTokens - 1)
}

// Floor semantics: a per-prompt keyword can raise an explicitly requested
// budget but must never silently lower it. When only one source is present it
// wins outright.
export function combineBudgetFloor(
  keywordBudget: number | undefined,
  explicitBudget: number | undefined,
): number | undefined {
  if (keywordBudget !== undefined && explicitBudget !== undefined) {
    return Math.max(keywordBudget, explicitBudget)
  }
  return keywordBudget ?? explicitBudget
}

interface ThinkingSampling {
  temperature?: number | null
  top_p?: number | null
}

interface ThinkingWireFields {
  temperature?: number | null
  top_p?: number | null
  thinking_budget?: number
}

// Anthropic forbids temperature/top_p when extended thinking is on; Copilot's
// broker mirrors that constraint. When a budget resolves we drop both sampling
// params and surface `thinking_budget`; otherwise the sampling params pass
// through untouched. The result is meant to be spread into the payload literal.
export function applyThinkingBudget(
  thinkingBudget: number | undefined,
  sampling: ThinkingSampling,
): ThinkingWireFields {
  if (thinkingBudget === undefined) {
    return { temperature: sampling.temperature, top_p: sampling.top_p }
  }
  return {
    temperature: undefined,
    top_p: undefined,
    thinking_budget: thinkingBudget,
  }
}

// ----- Per-prompt thinking-budget keyword detection ------------------------

// Compound forms (megathink, ultrathink, think hard/harder) match anywhere;
// bare `think` requires start-of-line to avoid firing on incidental
// "I think we should..." prose.
const THINKING_KEYWORDS: ReadonlyArray<{ pattern: RegExp; budget: number }> = [
  { pattern: /\b(?:think harder|ultrathink)\b/i, budget: 31999 },
  { pattern: /\b(?:think hard|megathink)\b/i, budget: 10000 },
  { pattern: /(?:^|\n)\s*think\b/i, budget: 4000 },
]

const FENCED_CODE_BLOCK = /```[\s\S]*?```/g

// Structural shape both AnthropicMessage and the chat-completions Message
// satisfy. We only inspect user-role text content, so any message whose
// content is a string or an array of typed blocks works.
export interface KeywordSourceMessage {
  role: string
  content?: unknown
}

function extractUserText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: Array<string> = []
  for (const block of content) {
    if (
      typeof block === "object"
      && block !== null
      && "type" in block
      && (block as { type: unknown }).type === "text"
      && "text" in block
      && typeof (block as { text: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text)
    }
  }
  return parts.join("\n")
}

export function detectKeywordBudget(
  messages: ReadonlyArray<KeywordSourceMessage>,
): number | undefined {
  // Walk back to the most recent user-authored TEXT message, skipping
  // user-role turns that contain only tool_result / image blocks (they
  // appear after every assistant tool_use in agentic loops).
  let text: string | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== "user") continue
    const candidate = extractUserText(m.content)
    if (candidate.trim().length > 0) {
      text = candidate
      break
    }
  }
  if (text === undefined) return undefined

  // Strip fenced code blocks so triggers inside code samples don't fire.
  const scrubbed = text.replaceAll(FENCED_CODE_BLOCK, "")

  for (const { pattern, budget } of THINKING_KEYWORDS) {
    if (pattern.test(scrubbed)) return budget
  }
  return undefined
}

// ----- Function-tool lowering ----------------------------------------------

interface FunctionToolSpec {
  name: string
  description?: string
  /** Defaults to an empty object schema when omitted. */
  parameters?: Record<string, unknown>
}

export function buildFunctionTool(spec: FunctionToolSpec): Tool {
  return {
    type: "function",
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters ?? { type: "object", properties: {} },
    },
  }
}

// ----- Content-part (text/image) lowering ----------------------------------

// Neutral content piece both client vocabularies normalise onto before the
// shared hasImage gate runs.
export type WireContentPiece =
  | { kind: "text"; text: string }
  | { kind: "image"; url: string; detail?: "low" | "high" | "auto" }

// If any piece is an image, Copilot requires the structured ContentPart[]
// form; otherwise we collapse the text pieces into a single newline-joined
// string (cheaper, and what Copilot expects for text-only turns).
export function lowerContentParts(
  pieces: Array<WireContentPiece>,
): string | Array<ContentPart> {
  const hasImage = pieces.some((piece) => piece.kind === "image")
  if (!hasImage) {
    return pieces
      .filter(
        (piece): piece is Extract<WireContentPiece, { kind: "text" }> =>
          piece.kind === "text",
      )
      .map((piece) => piece.text)
      .join("\n\n")
  }

  const parts: Array<ContentPart> = []
  for (const piece of pieces) {
    if (piece.kind === "text") {
      parts.push({ type: "text", text: piece.text })
    } else {
      parts.push({
        type: "image_url",
        image_url: {
          url: piece.url,
          ...(piece.detail !== undefined && { detail: piece.detail }),
        },
      })
    }
  }
  return parts
}

// ----- Anthropic usage reshaping -------------------------------------------

// The upstream Copilot/OpenAI usage shape we read from (a subset of both the
// streaming and non-streaming usage objects).
interface UpstreamUsageLike {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
}

// Anthropic bills the prompt minus cache hits as `input_tokens` and surfaces
// the cache hits separately. The streaming `message_start` event knows the
// prompt size but not yet the output, so callers can pin `outputTokens` to 0
// for that case.
export function toAnthropicUsage(
  usage: UpstreamUsageLike | undefined,
  options: { outputTokens?: number } = {},
): AnthropicUsage {
  const cached = usage?.prompt_tokens_details?.cached_tokens
  return {
    input_tokens: (usage?.prompt_tokens ?? 0) - (cached ?? 0),
    output_tokens: options.outputTokens ?? usage?.completion_tokens ?? 0,
    ...(cached !== undefined && { cache_read_input_tokens: cached }),
  }
}
