# Per-Prompt Thinking Keywords Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users override `thinking_budget` per-request by typing natural-language triggers (`think`, `megathink`, `ultrathink`, etc.) into their prompt — keyword acts as a floor on top of `MAX_THINKING_TOKENS`, sticky across agentic tool loops, and resilient to common false-positive sources.

**Architecture:** Add a pure detector function in `src/routes/messages/non-stream-translation.ts` that scans the most recent user-authored text turn (skipping tool_result/image-only turns), strips fenced code blocks, then matches against an ordered keyword table (highest budget first). Wire into the existing `translateToOpenAI` budget resolution with `Math.max(keywordBudget, payloadBudget)` floor semantics. Both streaming and non-streaming paths pick it up because they share `translateToOpenAI`.

**Tech Stack:** TypeScript (Bun), Hono, `bun:test`, Zod (existing test infra).

**Spec:** `docs/superpowers/specs/2026-04-20-per-prompt-thinking-keywords-design.md`

---

## File Structure

| File | Role |
|---|---|
| `src/routes/messages/non-stream-translation.ts` | Add `THINKING_KEYWORDS`, `extractUserText`, `detectKeywordBudget`; wire into `translateToOpenAI` |
| `tests/thinking-keywords.test.ts` | New test file — pure unit tests on `detectKeywordBudget` plus integration assertions on `translateToOpenAI` output |
| `README.md` | Add "Per-prompt budget override" subsection under "Extended Thinking (Claude models)" |
| `CLAUDE.md` | Add one sentence under "Fork-specific behavior" |

`detectKeywordBudget` is exported alongside `translateToOpenAI` to allow fine-grained unit tests; it has no side effects.

---

## Task 1: Add the keyword detector (TDD)

**Files:**
- Create: `tests/thinking-keywords.test.ts`
- Modify: `src/routes/messages/non-stream-translation.ts`

This task introduces the pure `detectKeywordBudget` function. No wiring yet.

- [ ] **Step 1: Write the first batch of failing tests**

Create `tests/thinking-keywords.test.ts`:

```ts
import { describe, expect, test } from "bun:test"

import type {
  AnthropicMessage,
  AnthropicUserMessage,
} from "~/routes/messages/anthropic-types"

import { detectKeywordBudget } from "../src/routes/messages/non-stream-translation"

const userText = (text: string): AnthropicUserMessage => ({
  role: "user",
  content: [{ type: "text", text }],
})

const userString = (text: string): AnthropicUserMessage => ({
  role: "user",
  content: text,
})

describe("detectKeywordBudget", () => {
  test("bare `think` at start of message → 4000", () => {
    expect(detectKeywordBudget([userText("think about this")])).toBe(4000)
  })

  test("bare `think` mid-sentence → undefined", () => {
    expect(
      detectKeywordBudget([userText("I think we should refactor")]),
    ).toBeUndefined()
  })

  test("`think hard` → 10000", () => {
    expect(detectKeywordBudget([userText("think hard about X")])).toBe(10000)
  })

  test("`megathink` anywhere → 10000", () => {
    expect(
      detectKeywordBudget([userText("please megathink this one")]),
    ).toBe(10000)
  })

  test("`ultrathink` → 31999", () => {
    expect(detectKeywordBudget([userText("ultrathink: refactor")])).toBe(31999)
  })

  test("`think harder` → 31999", () => {
    expect(detectKeywordBudget([userText("think harder about it")])).toBe(31999)
  })

  test("highest budget wins when multiple keywords present", () => {
    expect(
      detectKeywordBudget([userText("think hard, then ultrathink")]),
    ).toBe(31999)
  })

  test("no keyword → undefined", () => {
    expect(detectKeywordBudget([userText("just do X")])).toBeUndefined()
  })

  test("substring `thinking` does not trigger (word boundary)", () => {
    expect(
      detectKeywordBudget([userText("thinking about it")]),
    ).toBeUndefined()
  })

  test("string-form user content is supported", () => {
    expect(detectKeywordBudget([userString("ultrathink please")])).toBe(31999)
  })

  test("empty messages → undefined", () => {
    expect(detectKeywordBudget([])).toBeUndefined()
  })

  test("only assistant/system messages → undefined", () => {
    const messages: Array<AnthropicMessage> = [
      { role: "assistant", content: "ultrathink" },
    ]
    expect(detectKeywordBudget(messages)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/thinking-keywords.test.ts`
Expected: FAIL — `detectKeywordBudget is not a function` (or import error).

- [ ] **Step 3: Implement `detectKeywordBudget` (initial pass)**

In `src/routes/messages/non-stream-translation.ts`, after the existing `resolveThinkingBudget` function, add:

```ts
// Per-prompt thinking-budget keyword triggers. Compound forms (megathink,
// ultrathink, think hard/harder) match anywhere; bare `think` requires
// start-of-line to avoid firing on incidental "I think we should..." prose.
const THINKING_KEYWORDS: ReadonlyArray<{ pattern: RegExp; budget: number }> = [
  { pattern: /\b(?:think harder|ultrathink)\b/i, budget: 31999 },
  { pattern: /\b(?:think hard|megathink)\b/i, budget: 10000 },
  { pattern: /(?:^|\n)\s*think\b/i, budget: 4000 },
]

const FENCED_CODE_BLOCK = /```[\s\S]*?```/g

function extractUserText(message: AnthropicUserMessage): string {
  if (typeof message.content === "string") return message.content
  return message.content
    .filter((b): b is AnthropicTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
}

export function detectKeywordBudget(
  messages: Array<AnthropicMessage>,
): number | undefined {
  // Walk back to the most recent user-authored TEXT message, skipping
  // user-role turns that contain only tool_result / image blocks (they
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

`AnthropicUserMessage`, `AnthropicMessage`, and `AnthropicTextBlock` are already imported at the top of this file — no new imports required.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/thinking-keywords.test.ts`
Expected: PASS — all 12 tests.

- [ ] **Step 5: Run lint + typecheck**

Run: `bun run typecheck && bun run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/routes/messages/non-stream-translation.ts tests/thinking-keywords.test.ts
git commit -m "feat(messages): add thinking-budget keyword detector"
```

---

## Task 2: Cover sticky-across-tool-loops behavior

**Files:**
- Modify: `tests/thinking-keywords.test.ts`

This task locks in the most important Codex finding: the detector must walk past tool_result-only user turns mid agentic loop.

- [ ] **Step 1: Append failing tests**

Add to `tests/thinking-keywords.test.ts` inside the `describe("detectKeywordBudget", ...)` block:

```ts
  test("walks back past image-only user turn", () => {
    const messages: Array<AnthropicMessage> = [
      userText("ultrathink the bug"),
      { role: "assistant", content: "ok" },
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "abc",
            },
          },
        ],
      },
    ]
    expect(detectKeywordBudget(messages)).toBe(31999)
  })

  test("walks back past tool_result-only user turn", () => {
    const messages: Array<AnthropicMessage> = [
      userText("ultrathink the refactor"),
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool_1",
            name: "read",
            input: { path: "x" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_1",
            content: "file contents",
          },
        ],
      },
    ]
    expect(detectKeywordBudget(messages)).toBe(31999)
  })

  test("sticky across multi-step tool loop", () => {
    const messages: Array<AnthropicMessage> = [
      userText("ultrathink: implement feature X"),
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "read", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "..." },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t2", name: "edit", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t2", content: "ok" },
        ],
      },
    ]
    expect(detectKeywordBudget(messages)).toBe(31999)
  })

  test("all user turns are tool_result/image only → undefined", () => {
    const messages: Array<AnthropicMessage> = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "x" },
        ],
      },
    ]
    expect(detectKeywordBudget(messages)).toBeUndefined()
  })
```

- [ ] **Step 2: Run tests**

Run: `bun test tests/thinking-keywords.test.ts`
Expected: PASS — these should already pass against the Task 1 implementation, since the walk-back loop was implemented correctly the first time. If any fail, fix the detector before continuing.

- [ ] **Step 3: Commit**

```bash
git add tests/thinking-keywords.test.ts
git commit -m "test(messages): cover sticky keyword across agentic tool loops"
```

---

## Task 3: Cover fenced-code-block stripping

**Files:**
- Modify: `tests/thinking-keywords.test.ts`

- [ ] **Step 1: Append tests**

Add inside the same `describe` block:

```ts
  test("`think` inside fenced code block does not trigger", () => {
    const text = "review this:\n```\nthink about state\n```\n"
    expect(detectKeywordBudget([userText(text)])).toBeUndefined()
  })

  test("`ultrathink` inside fenced code block does NOT trigger", () => {
    // Compound triggers can match anywhere in the message, but fenced code
    // is stripped first — so they don't fire from inside ``` blocks.
    const text = "review this:\n```\nultrathink everything\n```\n"
    expect(detectKeywordBudget([userText(text)])).toBeUndefined()
  })

  test("trigger outside code block still fires when other text is fenced", () => {
    const text = "ultrathink this:\n```\njust some code\n```\n"
    expect(detectKeywordBudget([userText(text)])).toBe(31999)
  })
```

- [ ] **Step 2: Run tests**

Run: `bun test tests/thinking-keywords.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/thinking-keywords.test.ts
git commit -m "test(messages): cover fenced-code-block keyword stripping"
```

---

## Task 4: Wire keyword budget into `translateToOpenAI` with floor semantics

**Files:**
- Modify: `src/routes/messages/non-stream-translation.ts:29-56` (the `translateToOpenAI` function)
- Modify: `tests/thinking-keywords.test.ts`

- [ ] **Step 1: Write failing integration tests**

Append to `tests/thinking-keywords.test.ts`:

```ts
import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { translateToOpenAI } from "../src/routes/messages/non-stream-translation"

const buildPayload = (
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload => ({
  model: "claude-sonnet-4",
  max_tokens: 64000,
  messages: [userText("hello")],
  ...overrides,
})

describe("translateToOpenAI thinking budget", () => {
  test("no keyword, no payload thinking → no thinking_budget", () => {
    const out = translateToOpenAI(buildPayload())
    expect(out.thinking_budget).toBeUndefined()
  })

  test("keyword only → uses keyword budget", () => {
    const out = translateToOpenAI(
      buildPayload({ messages: [userText("ultrathink: refactor")] }),
    )
    expect(out.thinking_budget).toBe(31999)
    expect(out.temperature).toBeUndefined()
    expect(out.top_p).toBeUndefined()
  })

  test("payload only → uses payload budget", () => {
    const out = translateToOpenAI(
      buildPayload({
        thinking: { type: "enabled", budget_tokens: 8000 },
      }),
    )
    expect(out.thinking_budget).toBe(8000)
  })

  test("floor: keyword < payload → payload wins", () => {
    const out = translateToOpenAI(
      buildPayload({
        messages: [userText("think about it")],
        thinking: { type: "enabled", budget_tokens: 10000 },
      }),
    )
    expect(out.thinking_budget).toBe(10000)
  })

  test("floor: keyword > payload → keyword wins", () => {
    const out = translateToOpenAI(
      buildPayload({
        messages: [userText("ultrathink the bug")],
        thinking: { type: "enabled", budget_tokens: 4000 },
      }),
    )
    expect(out.thinking_budget).toBe(31999)
  })

  test("max_tokens clamps the budget", () => {
    const out = translateToOpenAI(
      buildPayload({
        max_tokens: 500,
        messages: [userText("ultrathink")],
      }),
    )
    expect(out.thinking_budget).toBe(499)
  })

  test("thinking on drops temperature and top_p", () => {
    const out = translateToOpenAI(
      buildPayload({
        messages: [userText("ultrathink")],
        temperature: 0.7,
        top_p: 0.9,
      }),
    )
    expect(out.temperature).toBeUndefined()
    expect(out.top_p).toBeUndefined()
  })

  test("no thinking → temperature and top_p preserved", () => {
    const out = translateToOpenAI(
      buildPayload({ temperature: 0.7, top_p: 0.9 }),
    )
    expect(out.temperature).toBe(0.7)
    expect(out.top_p).toBe(0.9)
  })
})
```

- [ ] **Step 2: Run tests to verify the keyword-related ones fail**

Run: `bun test tests/thinking-keywords.test.ts`
Expected: the "keyword only", "floor" and "max_tokens clamps" tests for keyword paths FAIL — `thinking_budget` is undefined because wiring is not in place yet.

- [ ] **Step 3: Modify `translateToOpenAI` to read keyword budget with floor semantics**

In `src/routes/messages/non-stream-translation.ts`, replace the current top of `translateToOpenAI`:

```ts
export function translateToOpenAI(
  payload: AnthropicMessagesPayload,
): ChatCompletionsPayload {
  const thinkingBudget =
    payload.thinking?.type === "enabled" ?
      resolveThinkingBudget(payload.thinking.budget_tokens, payload.max_tokens)
    : undefined
  const thinkingOn = thinkingBudget !== undefined
```

with:

```ts
export function translateToOpenAI(
  payload: AnthropicMessagesPayload,
): ChatCompletionsPayload {
  const keywordBudget = detectKeywordBudget(payload.messages)
  const payloadBudget =
    payload.thinking?.type === "enabled" ?
      payload.thinking.budget_tokens
    : undefined

  // Floor semantics: keyword can raise an explicit MAX_THINKING_TOKENS
  // budget but must never silently lower it.
  const requestedBudget =
    keywordBudget !== undefined && payloadBudget !== undefined ?
      Math.max(keywordBudget, payloadBudget)
    : (keywordBudget ?? payloadBudget)

  const thinkingBudget = resolveThinkingBudget(
    requestedBudget,
    payload.max_tokens,
  )
  const thinkingOn = thinkingBudget !== undefined
```

The rest of the function body (the `return { ... }` block) is unchanged.

- [ ] **Step 4: Run all tests**

Run: `bun test`
Expected: PASS — including pre-existing `tests/anthropic-request.test.ts` and `tests/anthropic-response.test.ts`.

- [ ] **Step 5: Run lint + typecheck**

Run: `bun run typecheck && bun run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/routes/messages/non-stream-translation.ts tests/thinking-keywords.test.ts
git commit -m "feat(messages): wire keyword thinking budget with floor semantics"
```

---

## Task 5: Live smoke test

**Files:** none modified — manual verification only.

- [ ] **Step 1: Start the dev server**

Run in one terminal: `bun run dev`
Expected: server listening on `http://localhost:4141`. Leave running.

- [ ] **Step 2: Send a baseline request (no keyword, no `thinking`)**

```bash
curl -sS http://localhost:4141/v1/messages \
  -H 'content-type: application/json' \
  -d '{
    "model": "claude-sonnet-4",
    "max_tokens": 1024,
    "messages": [{"role":"user","content":"say hi"}]
  }' | jq -r '.content[0].text' | head -3
```

Expected: a brief greeting; in the dev server logs, the translated payload line should NOT contain `thinking_budget`.

- [ ] **Step 3: Send a request with `ultrathink`**

```bash
curl -sS http://localhost:4141/v1/messages \
  -H 'content-type: application/json' \
  -d '{
    "model": "claude-sonnet-4",
    "max_tokens": 4096,
    "messages": [{"role":"user","content":"ultrathink: explain how a B-tree works"}]
  }' | jq '.usage'
```

Expected: response succeeds; dev server log shows `thinking_budget: 31999` (clamped to 4095 because `max_tokens=4096`). Response usage may include thinking tokens depending on model.

Run with `bun run dev` started via `--verbose` if the budget isn't visible in the log:
`bun run dev -- start --verbose` (or restart with `bun src/main.ts start --verbose`).

- [ ] **Step 4: Verify floor semantics with a payload-budget request**

This requires Claude Code to be the client (it sends `thinking.budget_tokens`). As a curl proxy, simulate:

```bash
curl -sS http://localhost:4141/v1/messages \
  -H 'content-type: application/json' \
  -d '{
    "model": "claude-sonnet-4",
    "max_tokens": 16384,
    "thinking": {"type":"enabled","budget_tokens":10000},
    "messages": [{"role":"user","content":"think about this small problem"}]
  }' | jq '.usage'
```

Expected: dev-server log shows `thinking_budget: 10000` (NOT 4000 — floor wins). This is the key Codex-finding fix to verify in vivo.

- [ ] **Step 5: Stop the dev server**

Ctrl-C the `bun run dev` terminal. Nothing to commit.

---

## Task 6: Documentation updates

**Files:**
- Modify: `README.md:329` (after the existing "Extended Thinking (Claude models)" section)
- Modify: `CLAUDE.md:64-68` (fork-specific behavior section)

- [ ] **Step 1: Add the README subsection**

In `README.md`, find the line `To dial the budget per-session, use shell aliases:` and insert this block ABOVE it (so it lands between the "Notes:" bullet list and the shell-alias snippet):

```markdown
#### Per-prompt budget override

Override the budget per-request using natural-language triggers in your prompt:

| Trigger | Budget |
|---|---|
| `think` (at start of a line) | 4000 |
| `think hard` / `megathink` | 10000 |
| `think harder` / `ultrathink` | 31999 |

The translator scans the most recent user message that contains text
(skipping tool-result-only turns mid-loop), strips fenced code blocks, then
matches. The highest-budget trigger wins. Triggers act as a **floor** —
they raise `MAX_THINKING_TOKENS` for that request but cannot lower it, so
a casual `think` in your prompt won't downgrade an explicit higher budget.
The keyword is left in the prompt verbatim. The next user prompt
re-evaluates.

```

- [ ] **Step 2: Add the CLAUDE.md sentence**

In `CLAUDE.md`, in the "Fork-specific behavior" section, append a fourth bullet under the existing list:

```markdown
- Per-prompt keyword overrides (`think`, `megathink`, `ultrathink`, etc.) are detected by `detectKeywordBudget` in `non-stream-translation.ts` and act as a floor on top of `MAX_THINKING_TOKENS`; the scanner walks back past `tool_result`/`image`-only user turns so the trigger stays sticky across agentic loops, and fenced code blocks are stripped before matching.
```

- [ ] **Step 3: Verify formatting**

Run: `bun run lint:all`
Expected: no errors. (Markdown isn't linted by ESLint, but this catches accidental TS file touches.)

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: per-prompt thinking-budget keyword overrides"
```

---

## Task 7: Final verification

**Files:** none modified.

- [ ] **Step 1: Run the full test suite**

Run: `bun test`
Expected: PASS — all suites including `thinking-keywords.test.ts` (~20 tests).

- [ ] **Step 2: Run typecheck, lint, knip**

Run: `bun run typecheck && bun run lint && bun run knip`
Expected: no errors. `knip` should not flag `detectKeywordBudget` (it's used inside the same module — tests import it but that's fine; if knip flags it, exporting is still desired for testability).

- [ ] **Step 3: Inspect the final diff**

Run: `git log --oneline origin/master..HEAD` (or `git log --oneline -10` if no upstream)
Expected: 6 commits in order — detector, sticky tests, code-block tests, wiring, docs, plus any test-only commits from Tasks 2/3.

- [ ] **Step 4: No commit needed.**

---

## Out of scope (per spec — do NOT implement)

- Custom keyword config via env var
- Numeric override syntax like `[think:N]`
- Stripping keywords from forwarded text
- Dedicated logging when a keyword fires (verbose log already shows `thinking_budget`)
