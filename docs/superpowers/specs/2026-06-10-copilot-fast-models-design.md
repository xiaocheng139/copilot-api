# Copilot Fast Models — Design

**Date:** 2026-06-10
**Status:** Approved (pending spec review)
**Branch:** `feat/copilot-fast-models`

## Problem

GitHub Copilot offers a low-latency "fast" variant for some Claude models. In
opencode, after authenticating with Copilot, a user can select both
`github-copilot/claude-opus-4.8` and `github-copilot/claude-opus-4.8-fast`. In
`copilot-api`, only the base `claude-opus-4.8` is visible. We want a user to be
able to configure `claude-opus-4.8-fast` (e.g. in Claude Code's `settings.json`
via `ANTHROPIC_MODEL`) and have the proxy engage Copilot's fast mode.

## Root cause (verified)

`-fast` is **not a distinct model** in Copilot's `/models` response. It is a
client-side synthetic variant that opencode manufactures from
[models.dev](https://models.dev) metadata:

- models.dev defines, per fast-capable model, an `[experimental.modes.fast]`
  block. Verified live from `https://models.dev/api.json` and the raw TOML at
  `sst/models.dev` → `providers/github-copilot/models/claude-opus-4.8.toml`:

  ```toml
  [experimental.modes.fast]
  cost     = { input = 10, output = 50, cache_read = 1, cache_write = 12.5 }
  provider = { body = { speed = "fast" },
               headers = { anthropic-beta = "fast-mode-2026-02-01" } }
  ```

- opencode (`packages/opencode/src/provider/provider.ts`,
  `fromModelsDevProvider`) reads `experimental.modes`, appends `-fast` to the
  base model id, and applies the mode's `provider.body` / `provider.headers`
  overrides to the upstream request.

So both `claude-opus-4.8` and `claude-opus-4.8-fast` hit the **same** Copilot
model id. Fast mode is engaged by a request-body flag `speed: "fast"` plus the
header `anthropic-beta: fast-mode-2026-02-01` — against the **same CAPI
endpoint** (`https://api.githubcopilot.com`) that `copilot-api` already calls.

`copilot-api` shows only the base model because its `/models` route
(`src/routes/models/route.ts`) is a pure pass-through of Copilot's `/models`,
and it has no translation step to engage fast mode. Verified: `getModels()`
(`src/services/copilot/get-models.ts`) returns Copilot's response verbatim; the
route maps each entry through without filtering, deduping, or synthesizing.

Currently fast-capable per models.dev (live, 2026-06-10): `claude-opus-4.6`,
`claude-opus-4.7`, `claude-opus-4.8`. Sonnet and Opus 4.5 are **not**
fast-capable.

## Goals

1. **Translate:** Any inbound model id ending in `-fast` engages Copilot fast
   mode — strip the suffix, send the base id, add `speed: "fast"` to the body
   and the `anthropic-beta` header. Works for all clients (Anthropic, OpenAI,
   Codex Responses) because all funnel through one chokepoint.
2. **Advertise:** `/models` lists the `-fast` variants for fast-capable models,
   so they appear in `copilot-api`'s model list and Claude Code's `/model`
   picker. The fast-capable set is sourced from models.dev (auto-updating).

## Non-goals (YAGNI)

- Per-variant cost/pricing display.
- Forwarding the Messages-API-only `effort` / `output_config` fields.
- Disk caching or runtime refresh of the fast set (startup fetch only; a restart
  picks up newly added models).
- Pre-validating a requested `-fast` model against the capable set before
  forwarding (translation stays permissive — see Decision 3).

## Open question to resolve FIRST (implementation step 1)

The wire **format** is established (opencode's working shape against Copilot
CAPI). The one thing reading code cannot prove is whether sending
`base-id + speed:"fast" + beta header` actually *engages* fast mode versus
silently returning normal speed. **Before building, run a live probe** with a
real Copilot token:

```
POST https://api.githubcopilot.com/chat/completions
  headers: <existing copilotHeaders> + anthropic-beta: fast-mode-2026-02-01
  body:    { model: "claude-opus-4.8", speed: "fast", messages: [...], ... }
```

Compare against the same request without the flag/header. If Copilot rejects the
`speed` field or the beta header, adjust the wire contract in this spec before
implementing. Everything below assumes the probe confirms the opencode shape.

## Architecture

Two decoupled concerns. **Translation is essential; discovery is decorative.**
Even if models.dev is unreachable forever, fast mode still works for a user who
hardcodes a `-fast` id — discovery only governs what is *listed*, never what is
*translatable*.

### Part 1 — Translation core

**New unit: `src/lib/fast-model.ts`** (pure, no I/O, fully unit-testable)

```ts
export const FAST_SUFFIX = "-fast"
export const FAST_BETA_HEADER = "fast-mode-2026-02-01"

export interface ParsedFastModel {
  baseModel: string
  isFast: boolean
}

// "claude-opus-4.8-fast" -> { baseModel: "claude-opus-4.8", isFast: true }
// "claude-opus-4.8"      -> { baseModel: "claude-opus-4.8", isFast: false }
export function parseFastModel(model: string): ParsedFastModel
```

Strips exactly one trailing `-fast`. A non-string / empty input returns
`{ baseModel: <input>, isFast: false }`.

**Wiring: `src/services/copilot/create-chat-completions.ts`** — the single
chokepoint every client passes through. Immediately before the `fetch`
(currently ~lines 26–35), run `parseFastModel(payload.model)`. When `isFast`:

- `payload.model = baseModel`
- `payload.speed = "fast"`
- add header `"anthropic-beta": FAST_BETA_HEADER` (alongside the existing
  `X-Initiator` header logic)

Add `speed?: string | null` to the `ChatCompletionsPayload` interface in the
same file.

**The translators (`translateToOpenAI`, OpenAI passthrough, Responses
translation) are NOT touched.** They forward the model string verbatim; the
strip/inject happens at the CAPI boundary. This keeps the Anthropic-translation
core out of scope and gives all three client formats fast mode from one
implementation.

### Part 2 — models.dev discovery + `/models` advertisement

**New unit: `src/services/models-dev/get-fast-capable.ts`**

```ts
// GET https://models.dev/api.json, walk ["github-copilot"].models,
// collect every id whose value has experimental.modes.fast.
// Never throws: on fetch/parse/schema failure, returns an empty Set.
export function getFastCapableIds(): Promise<Set<string>>
```

The fetch is the only side effect; the JSON→Set transform is pure and testable
against a captured `api.json` fixture. Use a short timeout (~3s) and fail open.

**State: `src/lib/state.ts`** — add `fastCapableIds: Set<string>`, defaulting to
an empty Set in the `state` initializer.

**Cache helper: `src/lib/utils.ts`** — add `cacheFastCapableIds()`, mirroring
`cacheModels()`:

```ts
export async function cacheFastCapableIds(): Promise<void> {
  state.fastCapableIds = await getFastCapableIds()
}
```

**Startup: `src/start.ts`** — call `cacheFastCapableIds()` near `cacheModels()`
(after `setupCopilotToken()`). It must **not** block startup on a slow
models.dev; because `/models` reads `state.fastCapableIds` live, a slow fetch
only means a `/models` call in the first few seconds might omit twins — a
non-issue since pickers fetch on demand. Because the `-fast` entries are added
to `state.models.data` as advertised, they also flow naturally into the
`--claude-code` interactive picker (`start.ts` builds it from
`state.models.data`).

**Route: `src/routes/models/route.ts`** — after mapping Copilot's real models,
for each real model whose `id ∈ state.fastCapableIds`, emit a **second** entry:
same shape, `id = \`${id}${FAST_SUFFIX}\``, `display_name = \`${name} (Fast)\``.
The intersection (Copilot's real list ∩ models.dev's fast set) ensures we only
advertise variants whose base model Copilot actually serves for this account.

## Data flow

```
Startup (start.ts)
  ├─ cacheModels()           → state.models          (Copilot's real list)
  └─ cacheFastCapableIds()   → state.fastCapableIds  (Set from models.dev)

GET /models (route.ts)
  for each model in state.models.data:
    emit base entry
    if model.id ∈ state.fastCapableIds: emit "<id>-fast" entry

POST /v1/messages | /chat/completions | /v1/responses
  → translate to ChatCompletionsPayload (model forwarded verbatim)
  → createChatCompletions():
       { baseModel, isFast } = parseFastModel(payload.model)
       if isFast: payload.model = baseModel
                  payload.speed = "fast"
                  headers["anthropic-beta"] = FAST_BETA_HEADER
  → fetch Copilot CAPI
```

## Error handling

| Failure | Behavior |
|---|---|
| models.dev fetch fails / times out | Log a warning; `fastCapableIds` stays empty. Server starts normally. `/models` omits `-fast` twins, but a hardcoded `-fast` id **still engages fast mode** (translation is independent). |
| models.dev schema drift (no `experimental.modes`) | `getFastCapableIds` returns whatever it finds (possibly empty); never throws. |
| User requests `-fast` on a non-capable model | Suffix stripped, base id + flag + header sent. If Copilot rejects it, the existing `HTTPError` path in `createChatCompletions` surfaces it. No pre-validation. |
| Copilot rejects `speed` / beta header (probe fails) | Resolve the wire contract during implementation step 1, before building. |

## Key design decisions

1. **Chokepoint over per-translator.** Strip/inject in `createChatCompletions`
   (one place) rather than in each format's translator (three places). One
   implementation serves Anthropic, OpenAI, and Codex clients.
2. **models.dev for discovery (auto-updating).** When Copilot adds a new
   fast-capable model, models.dev follows, and `/models` advertises it on next
   restart with no code change.
3. **Translation permissive, discovery curated.** `parseFastModel` strips
   `-fast` off *anything*; only `/models` advertisement is gated by the capable
   set. So the advertised list stays honest, while a user can still hardcode a
   brand-new `-fast` id and have it work before the allowlist source catches up.
4. **Fail open.** Discovery failure degrades advertisement only, never
   translation.

## Testing strategy

- **Unit — `fast-model.ts`** (TDD; the spec's core invariant): `-fast` stripped
  → correct base; non-fast untouched; edge cases — literal `"-fast"`, double
  suffix `"...-fast-fast"` (strip one), empty string, case sensitivity
  (`-FAST` is not matched).
- **Unit — `getFastCapableIds`**: captured `api.json` fixture → expected id Set;
  malformed/empty JSON → empty Set, never throws.
- **Integration — `create-chat-completions`** (extend existing
  `tests/create-chat-completions.test.ts`): mock the Copilot fetch; assert an
  inbound `...-fast` payload produces (a) base `model` upstream, (b)
  `speed: "fast"` in body, (c) `anthropic-beta` header present; and a non-fast
  payload produces none of those. Encodes *why*: fast mode must reach Copilot in
  exactly opencode's wire shape.
- **Route — `/models`**: with a seeded `fastCapableIds`, assert both base and
  `-fast` entries appear; with an empty set, assert only base entries (proves
  graceful degradation).

## Files touched

| File | Change |
|---|---|
| `src/lib/fast-model.ts` | **New.** `parseFastModel`, constants. |
| `src/services/models-dev/get-fast-capable.ts` | **New.** `getFastCapableIds`. |
| `src/services/copilot/create-chat-completions.ts` | Inject strip/flag/header; add `speed?` to payload type. |
| `src/lib/state.ts` | Add `fastCapableIds: Set<string>`. |
| `src/lib/utils.ts` | Add `cacheFastCapableIds()`. |
| `src/start.ts` | Call `cacheFastCapableIds()` at startup. |
| `src/routes/models/route.ts` | Synthesize `-fast` entries from the capable set. |
| `tests/fast-model.test.ts` | **New.** Unit tests. |
| `tests/get-fast-capable.test.ts` | **New.** Unit tests + fixture. |
| `tests/create-chat-completions.test.ts` | Extend with fast-mode assertions. |
| `tests/models-route.test.ts` | **New** (or extend). `/models` advertisement. |
| `README.md` | Document fast mode usage (settings.json example). |
