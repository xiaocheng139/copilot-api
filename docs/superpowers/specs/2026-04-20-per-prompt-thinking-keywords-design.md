# Per-Prompt Thinking Budget via Keyword Triggers

**Status:** Approved
**Date:** 2026-04-20

## Goal

Let users override the `thinking_budget` for a single request from the prompt
itself, mirroring Claude Code's original natural-language convention. Behavior
is sticky-per-task naturally and resets on the next user prompt.

This solves the gap left by the existing `MAX_THINKING_TOKENS` env var, which
is a process-scoped fixed budget — there's no way to dial it up or down
per-prompt without restarting Claude Code.

## Behavior

### Keyword → budget mapping

Case-insensitive, word-boundary matched.

| Keyword | Budget |
|---|---|
| `think` | 4000 |
| `think hard`, `megathink` | 10000 |
| `think harder`, `ultrathink` | 31999 |

### Scan target

Only the **last `user` message** in `payload.messages[]`. Concatenates all
`text` blocks (or the `string` form). Ignores `tool_result`, `image`, and
other non-text blocks.

This naturally produces sticky-per-task behavior: in Claude Code's agentic
loop, the original user message stays in `messages[]` across tool-use turns,
so the keyword keeps firing for the duration of that task. As soon as the
user types a fresh prompt, the new message becomes the last user message and
re-evaluates.

### Match rule

If multiple keywords appear in the scanned text, **highest budget wins**. The
keyword table is iterated high → low and returns on first match.

### Precedence over Claude Code's payload

If a keyword matches, its budget **overrides**
`payload.thinking.budget_tokens` for that request. If no keyword matches,
fall through to existing behavior (use whatever Claude Code sent, including
the env-driven `MAX_THINKING_TOKENS`).

### No keyword stripping

The user's message text is forwarded verbatim. The model sees the trigger
word in the prompt; this is harmless (and arguably reinforcing) and avoids
edge cases around stripping inside code blocks or quoted text.

## Implementation

One new function and a 3-line wiring change in
`src/routes/messages/non-stream-translation.ts`. No other files in `src/`
require modification — `anthropic-types.ts` already declares `thinking`,
`create-chat-completions.ts` already declares `thinking_budget`,
`stream-translation.ts` shares the request translator with the non-stream
path.

```ts
const THINKING_KEYWORDS: ReadonlyArray<{ pattern: RegExp; budget: number }> = [
  { pattern: /\b(?:think harder|ultrathink)\b/i, budget: 31999 },
  { pattern: /\b(?:think hard|megathink)\b/i,    budget: 10000 },
  { pattern: /\bthink\b/i,                        budget: 4000  },
]

function detectKeywordBudget(messages: Array<AnthropicMessage>): number | undefined {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")
  if (!lastUser) return undefined

  const text =
    typeof lastUser.content === "string"
      ? lastUser.content
      : lastUser.content
          .filter((b): b is AnthropicTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")

  for (const { pattern, budget } of THINKING_KEYWORDS) {
    if (pattern.test(text)) return budget
  }
  return undefined
}
```

Wired into `translateToOpenAI`:

```ts
const keywordBudget = detectKeywordBudget(payload.messages)
const requestedBudget =
  keywordBudget ??
  (payload.thinking?.type === "enabled" ? payload.thinking.budget_tokens : undefined)

const thinkingBudget = resolveThinkingBudget(requestedBudget, payload.max_tokens)
const thinkingOn = thinkingBudget !== undefined
```

The existing `resolveThinkingBudget` (clamp to `max_tokens - 1`) and the
existing `temperature` / `top_p` drop logic are reused unchanged.

## Edge cases

| Case | Behavior |
|---|---|
| `max_tokens` smaller than requested budget | `resolveThinkingBudget` clamps to `max_tokens - 1`. `ultrathink` with `max_tokens=500` → `thinking_budget=499`. |
| Keyword inside a code block / quoted text | Triggers (no stripping). Documented as intentional. |
| No `user` messages (only system/assistant) | Returns `undefined`; falls through to existing behavior. |
| Claude Code already sent `thinking.budget_tokens` AND keyword matches | Keyword wins. |
| Last user message has only images / tool_results | Joined text is empty; no match; falls through. |
| Streaming and non-streaming paths | Both share `translateToOpenAI`; both get the feature. |

## Testing

Unit tests in `tests/non-stream-translation.test.ts` (or a new file if that
doesn't exist — to be checked at implementation time):

| Test | Assertion |
|---|---|
| `"please think about this"` | budget = 4000 |
| `"think hard about X"` | budget = 10000 |
| `"ultrathink: refactor"` | budget = 31999 |
| `"think hard, then ultrathink"` | budget = 31999 (highest wins) |
| `"do X"` (no keyword) | budget = whatever payload.thinking sent (or undefined) |
| `"thinking about it"` (substring) | budget = undefined (word boundary) |
| `payload.thinking.budget_tokens=5000` + prompt has `ultrathink` | budget = 31999 (override) |
| `max_tokens=500` + `ultrathink` | budget = 499 (clamp) |
| Last user msg = image only; prior user msg has `think` | budget = undefined (only last scanned) |

Plus a live smoke test against the running server using `curl`, matching the
pattern used to verify the original `thinking_budget` patch.

## Documentation

Add a "Per-prompt budget override" sub-subsection under "Extended Thinking
(Claude models)" in `README.md`:

> ### Per-prompt budget override
>
> Override the budget per-request using natural-language triggers in your prompt:
>
> | Trigger | Budget |
> |---|---|
> | `think` | 4000 |
> | `think hard` / `megathink` | 10000 |
> | `think harder` / `ultrathink` | 31999 |
>
> The translator scans the last user message; the highest-budget match wins;
> the keyword is left in the prompt verbatim. Triggers override
> `MAX_THINKING_TOKENS` for that request only — the next user prompt
> re-evaluates.

Add one sentence to `CLAUDE.md` in the fork-specific section noting keyword
override.

## Files touched

- `src/routes/messages/non-stream-translation.ts` — add `THINKING_KEYWORDS`,
  `detectKeywordBudget`, and 3-line wiring in `translateToOpenAI`
- `tests/non-stream-translation.test.ts` (or new file) — 9 new test cases
- `README.md` — sub-subsection on per-prompt override
- `CLAUDE.md` — one sentence in fork-specific section

## Out of scope (YAGNI)

- Custom keyword config via env var
- Numeric override syntax like `[think:N]`
- Stripping keywords from forwarded text
- Dedicated logging when a keyword fires (verbose log already shows
  `thinking_budget`, which is sufficient)
