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

The **most recent `user` message that contains text content** in
`payload.messages[]`. Concatenates all `text` blocks (or the `string` form)
of that message. Ignores `tool_result`, `image`, and other non-text blocks.
User messages whose content is *only* `tool_result` / `image` blocks (i.e.
have no text) are **skipped** — the scan walks backwards until it finds a
real user-authored text turn, or hits the start of `messages[]`.

**Why skip tool-result turns:** in Anthropic's agentic loop, after each
`assistant` `tool_use`, Claude Code sends the tool output back as a
`user`-role message containing only `tool_result` blocks. If the scanner
naively took the literal "last user message" it would see only tool output,
the keyword would silently stop firing mid-task, and the budget would drop
back to the default. Walking back to the most recent user-authored text
preserves sticky-per-task behavior across arbitrarily long tool loops. As
soon as the user types a fresh prompt, that new message is the most recent
text-bearing user turn and re-evaluates.

### Match rule

If multiple keywords appear in the scanned text, **highest budget wins**. The
keyword table is iterated high → low and returns on first match.

To avoid false positives from untrusted content (pasted issues, file
contents, model output the user is asking the model to review, etc.), the
keyword must appear in one of these positions:

- **Anywhere** for the unambiguous compound triggers: `megathink`,
  `ultrathink`, `think hard`, `think harder`. These are coined / rare enough
  that incidental occurrences are negligible.
- **At the start of a line** (after optional whitespace) for the bare
  `think` trigger. This matches natural usage (`think about X`,
  `think: refactor Y`) while skipping `think` buried inside a pasted
  paragraph or code comment.

Fenced code blocks (text between triple backticks) are stripped before
matching, so `think` inside a code sample does not trigger.

### Precedence: floor, not override

The keyword budget acts as a **floor**, not an unconditional override:

```
finalBudget = max(keywordBudget ?? 0, payloadBudget ?? 0)
```

So `MAX_THINKING_TOKENS=10000` plus a prompt containing the bare word
`think` (which would map to 4000) yields a final budget of **10000** — the
casual keyword cannot silently downgrade an explicit higher budget. But
`MAX_THINKING_TOKENS=4000` plus `ultrathink` yields **31999**, which is the
intended dial-up case.

If neither side requested a budget, no thinking is enabled (existing
behavior).

### No keyword stripping

The user's message text is forwarded verbatim. The model sees the trigger
word in the prompt; this is harmless (and arguably reinforcing). The
position-based match rule above means keyword stripping is unnecessary even
for the bare `think` trigger.

## Implementation

One new function and a 3-line wiring change in
`src/routes/messages/non-stream-translation.ts`. No other files in `src/`
require modification — `anthropic-types.ts` already declares `thinking`,
`create-chat-completions.ts` already declares `thinking_budget`,
`stream-translation.ts` shares the request translator with the non-stream
path.

```ts
// Compound triggers match anywhere; bare `think` only at start of a line.
const THINKING_KEYWORDS: ReadonlyArray<{ pattern: RegExp; budget: number }> = [
  { pattern: /\b(?:think harder|ultrathink)\b/i,  budget: 31999 },
  { pattern: /\b(?:think hard|megathink)\b/i,     budget: 10000 },
  { pattern: /(?:^|\n)\s*think\b/i,               budget: 4000  },
]

const FENCED_CODE_BLOCK = /```[\s\S]*?```/g

function extractUserText(message: AnthropicUserMessage): string {
  if (typeof message.content === "string") return message.content
  return message.content
    .filter((b): b is AnthropicTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
}

function detectKeywordBudget(
  messages: Array<AnthropicMessage>,
): number | undefined {
  // Walk back to the most recent user-authored TEXT message, skipping
  // user-role turns that contain only tool_result / image blocks (these
  // appear after every assistant tool_use in agentic loops).
  let text: string | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== "user") continue
    const candidate = extractUserText(m)
    if (candidate.trim().length > 0) {
      text = candidate
      break
    }
  }
  if (text === undefined) return undefined

  // Strip fenced code blocks so triggers inside code samples don't fire.
  const scrubbed = text.replace(FENCED_CODE_BLOCK, "")

  for (const { pattern, budget } of THINKING_KEYWORDS) {
    if (pattern.test(scrubbed)) return budget
  }
  return undefined
}
```

Wired into `translateToOpenAI` (floor semantics — keyword raises, never
lowers):

```ts
const keywordBudget = detectKeywordBudget(payload.messages)
const payloadBudget =
  payload.thinking?.type === "enabled" ? payload.thinking.budget_tokens : undefined

const requestedBudget =
  keywordBudget !== undefined && payloadBudget !== undefined
    ? Math.max(keywordBudget, payloadBudget)
    : (keywordBudget ?? payloadBudget)

const thinkingBudget = resolveThinkingBudget(requestedBudget, payload.max_tokens)
const thinkingOn = thinkingBudget !== undefined
```

The existing `resolveThinkingBudget` (clamp to `max_tokens - 1`) and the
existing `temperature` / `top_p` drop logic are reused unchanged.

## Edge cases

| Case | Behavior |
|---|---|
| `max_tokens` smaller than requested budget | `resolveThinkingBudget` clamps to `max_tokens - 1`. `ultrathink` with `max_tokens=500` → `thinking_budget=499`. |
| Keyword inside a fenced code block | Stripped before matching; does not trigger. |
| Bare `think` mid-paragraph (e.g. `"I think we should..."`) | Does not trigger — bare `think` requires start-of-line. |
| `megathink` / `ultrathink` mid-paragraph or in pasted content | Triggers (compound forms are unambiguous and rare). Documented as intentional; if the user is reviewing untrusted text containing these literal words, budget will spike. |
| No `user` messages, or all user messages are tool_result/image only | Returns `undefined`; falls through to existing behavior. |
| Last user turn = tool_result (mid agentic loop), prior user turn has `ultrathink` | Scanner walks back to the prior user-authored text turn → triggers. Sticky-per-task preserved. |
| `MAX_THINKING_TOKENS=10000` + prompt has bare `think` (4000) | Floor semantics → final budget = 10000. Casual keyword cannot downgrade. |
| `MAX_THINKING_TOKENS=4000` + prompt has `ultrathink` (31999) | Floor semantics → final budget = 31999. Dial-up works. |
| Last user message has only images / tool_results | Joined text is empty; scanner walks back further; if no prior user text, falls through. |
| Streaming and non-streaming paths | Both share `translateToOpenAI`; both get the feature. |

## Testing

Unit tests in `tests/non-stream-translation.test.ts` (or a new file if that
doesn't exist — to be checked at implementation time):

| Test | Assertion |
|---|---|
| `"think about this"` (start of message) | budget = 4000 |
| `"I think we should refactor"` (mid-sentence bare `think`) | budget = undefined (start-of-line required) |
| `"think hard about X"` | budget = 10000 |
| `"ultrathink: refactor"` | budget = 31999 |
| `"think hard, then ultrathink"` | budget = 31999 (highest wins) |
| `"do X"` (no keyword) | budget = whatever payload.thinking sent (or undefined) |
| `"thinking about it"` (substring) | budget = undefined (word boundary) |
| ``"```\nthink\n```"`` (inside fenced code) | budget = undefined (code stripped) |
| `payload.thinking.budget_tokens=10000` + prompt has bare `think` | budget = 10000 (floor: keyword does not lower) |
| `payload.thinking.budget_tokens=4000` + prompt has `ultrathink` | budget = 31999 (floor: keyword raises) |
| `payload.thinking.budget_tokens=5000` + prompt has `ultrathink` | budget = 31999 (override upward) |
| `max_tokens=500` + `ultrathink` | budget = 499 (clamp) |
| Last user msg = image only; prior user msg has `think` (start of line) | budget = 4000 (walks back past image-only turn) |
| Last user msg = tool_result blocks only; prior user msg has `ultrathink` | budget = 31999 (sticky across tool loop) |
| Two assistant tool_use turns interleaved with tool_result user turns; original user prompt has `ultrathink` | budget = 31999 (still sticky after multi-step tool loop) |

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
> | `think` (at start of a line) | 4000 |
> | `think hard` / `megathink` | 10000 |
> | `think harder` / `ultrathink` | 31999 |
>
> The translator scans the most recent user message that contains text
> (skipping tool-result-only turns mid-loop), strips fenced code blocks,
> then matches. The highest-budget trigger wins. Triggers act as a **floor**
> — they raise `MAX_THINKING_TOKENS` for that request but cannot lower it,
> so a casual `think` in your prompt won't downgrade an explicit higher
> budget. The keyword is left in the prompt verbatim. The next user prompt
> re-evaluates.

Add one sentence to `CLAUDE.md` in the fork-specific section noting keyword
override.

## Files touched

- `src/routes/messages/non-stream-translation.ts` — add `THINKING_KEYWORDS`,
  `extractUserText`, `detectKeywordBudget`, and ~5-line wiring in
  `translateToOpenAI` (floor semantics)
- `tests/non-stream-translation.test.ts` (or new file) — ~14 new test cases
  including agentic-loop sticky-behavior coverage
- `README.md` — sub-subsection on per-prompt override
- `CLAUDE.md` — one sentence in fork-specific section

## Out of scope (YAGNI)

- Custom keyword config via env var
- Numeric override syntax like `[think:N]`
- Stripping keywords from forwarded text
- Dedicated logging when a keyword fires (verbose log already shows
  `thinking_budget`, which is sufficient)
