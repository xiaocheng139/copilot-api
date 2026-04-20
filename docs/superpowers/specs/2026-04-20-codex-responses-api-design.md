# `/v1/responses` for Codex CLI

**Status:** Draft
**Date:** 2026-04-20
**Issue:** https://github.com/xiaocheng139/copilot-api/issues/1

## Goal

Let Codex CLI use this proxy at the same time Claude Code already does,
against a single instance, each on its native wire format. Both clients
route through Copilot's `chat/completions` broker upstream.

Add `/v1/responses` that translates to/from `chat/completions`,
mirroring the existing `src/routes/messages/` translator.

## Background

Codex CLI v0.87+ only speaks the OpenAI Responses API
(`build_responses_request` in `codex-rs/core/src/client.rs` always posts
to `/v1/responses` with `stream: true`). Copilot's broker doesn't speak
Responses, so we translate down to `chat/completions` going up and
synthesize Responses SSE events coming back.

## Architecture

New `src/routes/responses/` mirroring `src/routes/messages/`:

| File | Responsibility |
|---|---|
| `route.ts` | Hono route. |
| `handler.ts` | Parses payload, calls translator, awaits `--manual` / `--rate-limit`, calls `createChatCompletions`, streams via `streamSSE`. |
| `responses-types.ts` | Incoming Responses payload types. |
| `request-translation.ts` | `ResponsesRequest → ChatCompletionsPayload`. |
| `stream-translation.ts` | Chat-completions SSE chunks → Responses SSE events. |

Mounted at `/responses` and `/v1/responses`. Reuses
`createChatCompletions`, `awaitApproval`, `checkRateLimit`, `state`,
`streamSSE`.

## Request translation

| Codex field | Chat-completions destination |
|---|---|
| `model` | `model` (verbatim) |
| `instructions` | `{role: "system", content: instructions}` prepended |
| `input[]` | `messages[]` (see below) |
| `tools[]` | Lowered to function tools (see "Tools") |
| `tool_choice` | Forwarded; see "Tools" |
| `parallel_tool_calls` | Forwarded |
| `reasoning.effort` | Mapped to `thinking_budget` for Claude (see "Reasoning") |
| `max_output_tokens` | `max_tokens` |
| `temperature`, `top_p` | Forwarded (subject to thinking-on drop rule) |
| `metadata.user_id` | `user` |
| `stream` | Forwarded |

`previous_response_id`, `store: true`, `background: true` → `400
unsupported_responses_field`. We don't store responses; silently
dropping these would lose continuation context.

Other unenumerated keys are dropped with a verbose log.

### `input[]` → `messages[]`

| Codex item | Message |
|---|---|
| `{type: "message", role, content: [...]}` | `{role, content}`. `input_text`/`output_text` join as text; `input_image` → `{type: "image_url", image_url: {url}}` (same as `messages/non-stream-translation.ts`) |
| `{type: "function_call", call_id, name, arguments}` | Coalesced into `{role: "assistant", tool_calls: [...]}` |
| `{type: "function_call_output", call_id, output}` | `{role: "tool", tool_call_id: call_id, content: output}` |
| `{type: "local_shell_call", call_id, action}` | Function-tool call named `__cp_local_shell` with `arguments = JSON.stringify(action)` |
| `{type: "local_shell_call_output", …}` | Same as `function_call_output` |
| `{type: "custom_tool_call", call_id, name, input}` | Function-tool call using the synthetic id minted for the matching `custom` tool, `arguments = JSON.stringify({input})` |
| `{type: "custom_tool_call_output", …}` | Same as `function_call_output` |
| `{type: "reasoning", …}` | Dropped |
| anything else | Dropped with a verbose log |

Consecutive tool-call items before the next `*_output` merge into one
assistant turn.

The synthesized `messages[]` runs through the same pipe `/v1/messages`
uses, including `detectKeywordBudget` (lifted to a `{role, content}`
shape and re-exported).

## Tools

Codex sends `function`, `local_shell`, `custom`. All three lower to
chat-completions function tools.

| Codex tool def | Lowered to |
|---|---|
| `{type: "function", name, description, parameters, strict}` | `{type: "function", function: {name, description, parameters, strict}}` |
| `{type: "local_shell"}` | Function tool named `__cp_local_shell`, parameters = LocalShellAction schema |
| `{type: "custom", name, description}` | Function tool named `__cp_custom_<n>` (per-request counter), parameters = `{type: "object", properties: {input: {type: "string"}}, required: ["input"]}` |

The translator keeps a per-request `syntheticId → {family,
originalName?}` map so the response translator can raise calls back to
their native shape (`local_shell_call` / `custom_tool_call`) and recover
the original `custom` tool name verbatim.

`__cp_` is reserved. Any user `function`/`custom` whose `name` starts
with `__cp_` (in `tools[]` or in historical `input[]` `function_call`
items) → `400 reserved_tool_name`. Prevents a user-defined `local_shell`
function from being raised as a privileged shell call.

### Raising and fallback

When the upstream model emits a function call:
- Name in the synthetic-id map → raise to `local_shell_call` /
  `custom_tool_call`.
- Plain user `function` → emit as `function_call`.
- Args fail to parse or fail shape validation:
  - Plain function: pass the raw args string through; Codex surfaces it.
  - Synthetic id: emit `response.failed` with
    `code=upstream_malformed_tool_arguments`. Don't echo a `__cp_*` name
    back to Codex (next turn would reject it).
- `__cp_*` name **not** in the map (upstream hallucination / version
  skew): `response.failed` with `code=undeclared_synthetic_tool`.

Shape validation:
- `__cp_local_shell` → `LocalShellAction` (object with
  `command: string[]`, optional `workdir`, `env`, `timeout_ms`).
- `__cp_custom_<n>` → `{input: string}`.

### `tool_choice`

| Codex value | Chat-completions value |
|---|---|
| `"auto"`, `"none"`, `"required"` | Same |
| `{type: "function", name}` | `{type: "function", function: {name}}` |
| `{type: "allowed_tools", tools, mode}` | Resolve each entry against declared `tools[]`. Entries are `"local_shell"` or `{type: "function" \| "custom", name}`. Anything that doesn't resolve → `400 unknown_tool_in_choice`. Empty resolved set → `400 empty_allowed_tools`. Forward the resolved list with the requested `mode`. |

`web_search` is unsupported. If `allowed_tools` references it → `400
unsupported_tool_in_choice`. Otherwise drop the def with a verbose log
and let the model recover.

## Reasoning effort

Claude models (id starts with `claude-`):

| `effort` | `thinking_budget` anchor |
|---|---|
| `"minimal"` | undefined |
| `"low"` | 4000 |
| `"medium"` | 10000 |
| `"high"` | 31999 |

Anchor → keyword floor (`detectKeywordBudget`) → single
`resolveThinkingBudget` clamp against `max_output_tokens - 1`.

Non-Claude models: `reasoning.effort` is dropped with a verbose log.
Real `reasoning_effort` pass-through to GPT-5 / o-series is follow-up
once we confirm Copilot's broker accepts the field.

## Response translation

Chat-completions deltas → Responses SSE events. Minimum set
`process_sse` (in `codex-rs/core/src/client.rs`) parses — verify against
the parser before merge:

- `response.created` — once at start, `response.id = "resp_" + nanoid`,
  reused in every subsequent event and the final envelope.
- `response.output_item.added` — new assistant message or tool call.
- `response.output_text.delta` — streaming text.
- `response.output_item.done` — finalizes each item; this is what Codex
  parses to reconstruct the turn.
- `response.completed` — terminator with `usage` and final `status`.

Each item gets `id` = nanoid with a type prefix (`msg_`, `fc_`, `lsc_`,
`ctc_`) and a 0-indexed `output_index`.

### `finish_reason` → `status`

| Upstream | Status | Notes |
|---|---|---|
| `stop` | `completed` | |
| `tool_calls` | `completed` | Tool calls live in `output[]` |
| `length` | `incomplete` | `incomplete_details: {reason: "max_output_tokens"}` |
| `content_filter` | `incomplete` | `incomplete_details: {reason: "content_filter"}` |
| `null` + `[DONE]` | `completed` | Normal end |
| `null` no `[DONE]`, no accumulated content | n/a | Emit `response.failed code=stream_interrupted`; no `response.completed` |
| `null` no `[DONE]`, partial content | `incomplete` | Validate the accumulated set: every item parseable + shape-valid → emit `output_item.done` for each in order, then `response.completed status=incomplete` (synthetics raise normally). Any item malformed → emit only `response.failed code=stream_interrupted_malformed_tool_arguments`, flush nothing. (Codex acts on `output_item.done`, so partial flush of a parallel turn could execute one privileged call alongside a malformed sibling.) |
| anything else | `incomplete` | `incomplete_details: {reason: "unknown", upstream_reason: "<value>"}` |

## Errors

Upstream HTTP → Responses error envelope (body wraps `{error: {type,
message, code?}}`):

| Upstream | Type |
|---|---|
| 400 | `invalid_request_error` |
| 401 | `authentication_error` |
| 403 | `permission_error` |
| 404 | `not_found_error` |
| 408 / 504 | `timeout_error` |
| 429 | `rate_limit_error` |
| 5xx | `api_error` |

Boundary: validation, hard-rejected fields, reserved names,
`--manual`/`--rate-limit` denial, and upstream failure before the first
chunk → non-stream HTTP envelope. After `response.created` is emitted
→ `response.failed` SSE event then close.

## Tests

Style of `tests/anthropic-*.test.ts`:

- **Request translation:** message types, tool lowering, `tool_choice`
  (`allowed_tools` resolution, unknown / empty / `web_search` → 400),
  reasoning effort mapping (with clamp under low `max_output_tokens`),
  metadata, coalescing, image parts.
- **Stream translation:** text only, single tool call, parallel tool
  calls, local-shell raise, custom-tool raise, malformed-args plain
  fallback, malformed-args synthetic → `response.failed`, undeclared
  `__cp_*` → `response.failed`, every `finish_reason` row above
  (including parallel-turn transport-cut where one item is valid and
  one is malformed → must emit only `response.failed`, not
  `output_item.done`).
- **Pre-stream errors:** unsupported continuation fields, reserved tool
  name (in `tools[]` and in historical `input[]`), `--manual` /
  `--rate-limit` denial, upstream non-OK before first chunk.
- **Smoke:** `bun test` plus manual `codex --model claude-sonnet-4-5
  --base-url http://localhost:4141 "explain this repo"` alongside a
  concurrent Claude Code session.

## Files touched

- `src/routes/responses/*` — new (5 files above).
- `src/server.ts` — mount at `/responses` and `/v1/responses`.
- `src/routes/messages/non-stream-translation.ts` — export
  `detectKeywordBudget` with a `{role, content}` parameter shape.
- `tests/responses-*.test.ts` — new.
- `README.md` — short "Codex CLI" section.

## Out of scope

- OpenAI Responses upstream client (would let GPT-5/o-series reasoning
  round-trip and let us honor `previous_response_id` / `store` /
  `background` instead of rejecting). Tracked in TASKS.md.
- Per-route isolation of `--rate-limit`, `--manual`,
  `MAX_THINKING_TOKENS`. Tracked in TASKS.md.
- Web search tools.
