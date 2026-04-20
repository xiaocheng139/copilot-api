# `/v1/responses` for Codex CLI

**Status:** Approved
**Date:** 2026-04-20
**Issue:** https://github.com/xiaocheng139/copilot-api/issues/1

## Goal

Add an OpenAI Responses-API-compatible endpoint at `/v1/responses` so Codex
CLI (v0.87+) can talk to this proxy the same way Claude Code talks to
`/v1/messages`. Both clients should be runnable in parallel against a single
proxy instance, each on its own native wire format, with all upstream
traffic continuing to flow through GitHub Copilot's `chat/completions`
broker.

The first cut translates Codex Responses-API requests into Copilot's
`chat/completions` shape (the same shape `/v1/messages` already uses) and
back-translates the streaming chat-completion deltas into a synthetic
Responses-API SSE event stream. Per-route isolation of `--rate-limit`,
`--manual`, and `MAX_THINKING_TOKENS`, and the upstream Responses-API client
needed to preserve `reasoning.effort` for GPT-5 / o-series models, are
deferred to TASKS.md.

## Background

Codex CLI exclusively uses OpenAI's Responses API on its model path —
`build_responses_request` in `codex-rs/core/src/client.rs` always sets
`stream: true` and posts to `/v1/responses`. The Responses API differs from
chat-completions in three substantive ways:

1. **Request shape.** Top-level `instructions` (system prompt), an `input[]`
   array of mixed item types (`message`, `function_call`,
   `function_call_output`, `reasoning`, `custom_tool_call*`), flat tool
   definitions (`{type, name, description, strict, parameters}` rather than
   `{type: "function", function: {…}}`), and a `reasoning: {effort, summary}`
   block.
2. **Streaming protocol.** The client reconstructs the assistant turn from
   `response.output_item.done` events; `response.completed` is the only
   required terminator; `response.output_text.delta` is cosmetic.
3. **Reasoning.** `reasoning.effort` is a string enum
   (`"minimal"|"low"|"medium"|"high"`) rather than the numeric
   `thinking_budget` we already forward for Claude.

The repo already has the translation pattern we need (`src/routes/messages/`
maps Anthropic Messages → chat-completions and back). We mirror it.

## Architecture

New directory `src/routes/responses/`:

| File | Responsibility |
|---|---|
| `route.ts` | Hono route definition; wires path + handler. |
| `handler.ts` | Orchestrates: parse payload, translate request, await `--manual`/`--rate-limit`, call `createChatCompletions`, stream or buffer the response, translate to Responses-API SSE. |
| `responses-types.ts` | TypeScript types for the incoming Codex Responses-API payload (`ResponsesRequest`, `ResponsesInputItem`, `ResponsesTool`, etc.). Single source of truth for the wire shape. |
| `request-translation.ts` | Pure translator: `ResponsesRequest` → `ChatCompletionsPayload`. |
| `stream-translation.ts` | State machine that consumes chat-completion SSE chunks and emits Responses-API SSE events. |

Mounted in `src/server.ts` at both `/responses` and `/v1/responses`,
matching the existing dual-mount convention. Anthropic stays on
`/v1/messages` only (clients always use the `/v1/` prefix there); we follow
the same convention for the OpenAI-compatible Responses path so Codex's
default base URL (`http://host:port/v1`) just works.

The handler reuses `createChatCompletions`, `awaitApproval`,
`checkRateLimit`, the `state` singleton, and the existing `streamSSE`
helper. No new auth, header, or upstream-client code is needed for the
first cut.

## Request translation

`request-translation.ts` exports `translateResponsesToChatCompletions`. It
converts Codex's Responses-API payload into the chat-completions shape
already expected by `services/copilot/create-chat-completions.ts`.

### Top-level fields

| Codex Responses field | Chat-completions destination |
|---|---|
| `model` | `model` (verbatim; `translateModelName` from `messages/non-stream-translation.ts` is **not** applied — Codex sends real GitHub-Copilot model IDs already) |
| `instructions` | Prepended as a `{role: "system", content: instructions}` message |
| `input[]` | Translated item-by-item into `messages[]` (see below) |
| `tools[]` | Wrapped from flat `{type: "function", name, …}` into nested `{type: "function", function: {name, description, parameters}}`. Non-`function` types (`custom`, `local_shell`, `web_search`) are dropped with a single verbose-log warning per request. |
| `tool_choice` | Forwarded verbatim when it's `"auto"` / `"required"` / `"none"`; the `{type: "function", name}` form is rewrapped into `{type: "function", function: {name}}`. |
| `parallel_tool_calls` | Forwarded as `parallel_tool_calls`. |
| `reasoning.effort` | Translated to `thinking_budget` for Claude models only (see below). For non-Claude models the field is dropped and a verbose-log warning notes the limitation. |
| `max_output_tokens` | Mapped to `max_tokens`. |
| `metadata.user_id` | Forwarded as `user`. |
| `temperature`, `top_p` | Forwarded verbatim, subject to the existing thinking-on drop rule. |
| `stream` | Forwarded; Codex always sends `true`. The handler's stream/non-stream branch keys off this. |

Dropped on the floor (Responses-API-only fields with no chat-completions
analogue, none required by Copilot's broker): `store`, `include`,
`service_tier`, `prompt_cache_key`, `safety_identifier`, `client_metadata`,
`text` (output-format hints), `reasoning.summary`, `reasoning.encrypted_content`,
`previous_response_id`, `truncation`, `background`. A single verbose-log
line lists which of these fields were present and dropped, for debugging.

### `input[]` → `messages[]`

Codex's `input[]` is a heterogeneous array. We map each item type:

| Codex item type | Chat-completions message |
|---|---|
| `{type: "message", role, content: [{type: "input_text"\|"output_text"\|"input_image", …}]}` | `{role, content}` where multi-part text becomes a joined string and `input_image` becomes a `{type: "image_url", image_url: {url}}` part (matching the existing image handling in `messages/non-stream-translation.ts`). |
| `{type: "function_call", call_id, name, arguments}` | Appended as / merged into a preceding `{role: "assistant", tool_calls: [{id: call_id, type: "function", function: {name, arguments}}]}`. Adjacent function-call items addressed to the same assistant turn are coalesced into one message's `tool_calls[]`. |
| `{type: "function_call_output", call_id, output}` | `{role: "tool", tool_call_id: call_id, content: output}` (output stringified if not already a string). |
| `{type: "reasoning", …}` | **Dropped.** Copilot's chat-completions broker does not accept reasoning items in the message log. |
| `{type: "custom_tool_call"\|"custom_tool_call_output"\|"local_shell_call"\|"local_shell_call_output"\|"web_search_call"}` | **Dropped** with one verbose-log warning per request type. These tool families are deferred. |

The synthesized `messages[]` then runs through the same downstream pipe
`/v1/messages` already uses — including the per-prompt thinking keyword
detector. `detectKeywordBudget` already takes `Array<AnthropicMessage>` but
operates only on the `role: "user"` text content, which is shape-compatible
with our synthesized chat messages once we widen the input type (or, more
cleanly, lift the detector to operate on a minimal `{role, content}` shape
and re-export it for both translators). Implementation detail to settle
during plan-writing; behavior is unchanged.

### `reasoning.effort` → `thinking_budget`

Mapping (Claude models only; identified by model-name prefix `claude-`):

| `effort` | `thinking_budget` |
|---|---|
| `"minimal"` | undefined (no thinking) |
| `"low"` | 4000 |
| `"medium"` | 10000 |
| `"high"` | 31999 |

These are the same anchor values as the keyword detector's `think` /
`think hard` / `think harder` tiers, which keeps the dial consistent across
both client paths. The keyword detector still runs on top with floor
semantics, so a Codex prompt with `effort: "low"` plus `ultrathink` in the
text gets `31999` — same rule as the Claude Code path.

For non-Claude models the field is dropped. The GPT-5 / o-series
reasoning-loss case is documented in TASKS.md and called out in the README.

## Streaming response translation

`stream-translation.ts` exports `translateChunksToResponsesEvents`, a
generator (or `ReadableStream` transformer) that consumes the
chat-completion SSE chunks emitted by `createChatCompletions` and produces
Responses-API SSE events.

### State

```ts
interface ResponsesStreamState {
  responseId: string          // generated once, reused on every event
  model: string               // echoed from upstream
  textBuffer: string          // accumulated assistant text
  toolCalls: Map<number, {    // keyed by upstream OpenAI tool-call index
    id: string
    name: string
    argumentsBuffer: string
  }>
  finishReason: string | null
  usage: ChatCompletionUsage | null
  emittedCreated: boolean
}
```

### Event sequence

For each upstream SSE chunk:

1. On the **first chunk**, emit `response.created` with a synthesized
   response envelope (`id`, `model`, `status: "in_progress"`,
   `output: []`, etc.). Set `emittedCreated = true`.
2. For each `delta.content` text fragment, append to `textBuffer` and emit
   `response.output_text.delta` with the fragment. Cosmetic — Codex
   reconstructs from the eventual `output_item.done`, but emitting deltas
   keeps the UX live.
3. For each `delta.tool_calls[]` entry, look it up in `toolCalls` by
   `index`; create the entry on first sight (capturing `id` and `name`),
   append `function.arguments` to its buffer. No streaming
   `function_call_arguments.delta` event in the first cut — Codex parses the
   final `output_item.done`.
4. When a chunk has `finish_reason`, store it. Don't terminate yet —
   the upstream stream may still send a usage chunk.
5. When the upstream stream ends:
   - If `textBuffer` is non-empty, emit `response.output_item.done` with
     `{type: "message", role: "assistant", content: [{type: "output_text", text: textBuffer}]}`.
   - For each entry in `toolCalls`, emit `response.output_item.done` with
     `{type: "function_call", call_id, name, arguments: argumentsBuffer}`.
   - Emit `response.completed` with the full response envelope: `output[]`
     populated, `status: "completed"` (or the mapped status from
     `finishReason`), and `usage` mapped from the chat-completion usage
     block (`prompt_tokens`/`completion_tokens` → `input_tokens`/
     `output_tokens`, cached tokens → `input_tokens_details.cached_tokens`).

### Error mapping

When `createChatCompletions` throws an HTTP error mid-translation, emit a
`response.failed` event with an error code mapped from the upstream HTTP
status:

| Upstream status | Responses-API error code |
|---|---|
| 401, 403 | `usage_not_included` |
| 429 | `rate_limit_exceeded` |
| 400 with `context_length_exceeded` body marker | `context_length_exceeded` |
| 5xx | `server_error` |
| anything else | `server_error` (default) with the upstream message |

If we haven't emitted `response.created` yet (failure in the request
translator or before the upstream stream opens), respond with a non-stream
HTTP error in the standard Responses-API error envelope instead, since SSE
events without a prior `response.created` confuse Codex.

## Wiring, headers, tests, docs

### Hono wiring

`src/routes/responses/route.ts` defines the Hono app and exports it.
`src/server.ts` mounts it at `/responses` and `/v1/responses`. The handler
mirrors `messages/handler.ts`:

1. Parse and validate the body via the new types.
2. Run `--manual` approval (if enabled) and `--rate-limit` (if enabled),
   reusing the global helpers. **Note:** these stay process-wide for now;
   Codex and Claude Code share the same gates. TASKS.md tracks the per-route
   isolation work.
3. Translate request → call `createChatCompletions` → translate response.
4. Branch on `payload.stream` (always true for current Codex, but support
   non-stream too for completeness and so future tooling/tests can hit the
   endpoint without SSE plumbing).

### `X-Initiator` header

`create-chat-completions.ts` derives `X-Initiator: agent` when any prior
message has `role` of `assistant` or `tool`. Our synthesized `messages[]`
already contains those roles when Codex sends `function_call` /
`function_call_output` items, so the header is computed correctly with no
change. **Do not "simplify" this header derivation away** — it affects
Copilot premium-request accounting.

### Tests

New file `tests/responses-translation.test.ts`. Roughly 22 cases:

**Request translation (`translateResponsesToChatCompletions`):**

- Plain user message → single user chat message
- `instructions` → leading system message
- `input_image` → `{type: "image_url", …}` content part
- `function_call` followed by `function_call_output` → assistant
  `tool_calls` + tool message with matching `tool_call_id`
- Two adjacent `function_call` items → coalesced into one assistant turn's
  `tool_calls[]`
- `reasoning` item → dropped, doesn't appear in messages
- `custom_tool_call` / `local_shell_call` / `web_search_call` → dropped,
  warning logged once
- Tools: flat `{type: "function", name, …}` → nested wrapping
- Tools: `{type: "custom"}` dropped
- `tool_choice: "auto"` / `"required"` / `"none"` → forwarded
- `tool_choice: {type: "function", name: "X"}` → rewrapped
- `reasoning.effort: "minimal"` on Claude model → no `thinking_budget`
- `reasoning.effort: "low"` on Claude model → `thinking_budget=4000`
- `reasoning.effort: "high"` on Claude model → `thinking_budget=31999`
- `reasoning.effort` on non-Claude model → dropped
- `reasoning.effort: "low"` + user text containing `ultrathink` → final
  `thinking_budget=31999` (floor semantics)
- `metadata.user_id` → `user`
- `max_output_tokens` → `max_tokens`
- Dropped fields (`store`, `include`, `service_tier`, etc.) don't appear in
  output

**Stream translation (`translateChunksToResponsesEvents`):**

- Single text-only assistant chunk → `response.created` →
  `response.output_text.delta` → `response.output_item.done` (message) →
  `response.completed` with usage
- Tool-call chunks → `response.created` → `response.output_item.done`
  (function_call) → `response.completed`
- Mixed text + tool-call chunks → both `output_item.done` events emitted in
  text-then-tool order
- Error during stream → `response.failed` with mapped error code

### Live smoke test

After implementation, point a real Codex CLI at the running proxy
(`OPENAI_BASE_URL=http://localhost:<port>/v1 codex`) and run a tool-using
prompt end-to-end. Verify that text and at least one tool call round-trip,
matching the procedure already used to validate the `thinking_budget`
patch. Capture the verbose log to confirm `X-Initiator` flips to `agent`
on the second turn.

### Documentation

Add a "OpenAI Responses API (Codex CLI)" subsection to README.md showing:

- The endpoint URL.
- A minimal Codex `~/.codex/config.toml` snippet pointing
  `model_provider.openai.base_url` at the proxy.
- The reasoning.effort → thinking_budget mapping table (Claude only).
- A note that GPT-5 / o-series reasoning is currently lost on this path
  (linking to TASKS.md) and that `--rate-limit` / `--manual` /
  `MAX_THINKING_TOKENS` are still process-wide.

Add one bullet to `CLAUDE.md`'s "Fork-specific behavior" section noting the
new translator pair.

## Files touched

- `src/routes/responses/route.ts` (new)
- `src/routes/responses/handler.ts` (new)
- `src/routes/responses/responses-types.ts` (new)
- `src/routes/responses/request-translation.ts` (new)
- `src/routes/responses/stream-translation.ts` (new)
- `src/server.ts` — mount the new route at `/responses` and `/v1/responses`
- `src/routes/messages/non-stream-translation.ts` — minor: lift the role/
  content shape that `detectKeywordBudget` accepts, or re-export a
  scanner that takes `{role, content}` so both translators reuse it
  unchanged. (Settle exact mechanism in the implementation plan.)
- `tests/responses-translation.test.ts` (new) — ~22 test cases
- `README.md` — new subsection
- `CLAUDE.md` — one bullet

## Out of scope (deferred to TASKS.md or follow-ups)

- **Upstream Responses API client.** Routing GPT-5 / o-series through
  Copilot's actual Responses upstream so `reasoning.effort` survives.
  Currently tracked in TASKS.md as "Codex reasoning on GPT-5 / o-series via
  Copilot."
- **Per-route isolation of `--rate-limit`, `--manual`, `MAX_THINKING_TOKENS`.**
  Tracked in TASKS.md as "Per-client isolation for parallel agents."
- **WebSocket / push paths.** Codex doesn't use them; not implemented.
- **`custom_tool_call`, `local_shell_call`, `web_search_call` tool
  families.** Dropped with a warning. Codex degrades to "tool not
  available" on those.
- **`previous_response_id` / `background` / `store`-backed continuations.**
  Codex doesn't rely on server-side response storage in our setup.
- **Streaming `function_call_arguments.delta` events.** First cut emits the
  arguments only via the final `output_item.done`, which is sufficient for
  Codex; per-token argument deltas are a UX polish.
