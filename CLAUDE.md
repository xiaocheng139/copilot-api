# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` covers commands and code-style basics — read it first. This file focuses on architecture and the non-obvious behaviors that span multiple files.

## Commands

- `bun run dev` — watch-mode server (`src/main.ts`)
- `bun run typecheck` — `tsc` (no emit; the build runs through tsdown)
- `bun run lint` / `bun run lint:all` — ESLint with `@echristian/eslint-config`. A `pre-commit` hook (`simple-git-hooks` + `lint-staged`) runs `lint --fix` on staged files.
- `bun test tests/<file>.test.ts` — single test via Bun's runner. Tests live in `tests/`, named `*.test.ts`.
- `bun run knip` — dead-code / unused-export check
- `bun run build` — `tsdown` bundles `src/main.ts` → `dist/main.js` (esm, node, es2022). The `bin` entry ships `dist/main.js`.

Use `~/*` import alias for anything under `src/*` (configured in `tsconfig.json`).

## Architecture

This is a translating reverse proxy: it speaks **OpenAI** and **Anthropic** wire formats to clients, then re-shapes each request into GitHub Copilot's internal ChatCompletions shape and impersonates the VS Code Copilot Chat extension on the way out.

### Request flow

```
client (Claude Code / OpenAI tool)
  → Hono server (src/server.ts)
    → route handler (src/routes/<api>/handler.ts)
      → translator (Anthropic only: src/routes/messages/*-translation.ts)
        → src/services/copilot/create-chat-completions.ts
          → fetch → https://api.githubcopilot.com/chat/completions
        → translator (response)
      ← back through the same layers
```

`src/server.ts` mounts every route twice — bare (`/chat/completions`) and `/v1/`-prefixed — for compatibility with tools that assume either convention. Anthropic endpoints are only mounted under `/v1/messages`.

### The Anthropic translator is the heart of the codebase

`src/routes/messages/` is where most of the interesting work happens:

- `non-stream-translation.ts` — `translateToOpenAI` (request) and `translateToAnthropic` (response). Both streaming and non-streaming paths share `translateToOpenAI`; the streaming path additionally uses `translateChunkToAnthropicEvents` from `stream-translation.ts`.
- `stream-translation.ts` — chunk-by-chunk SSE translation. Maintains `AnthropicStreamState` (defined in `anthropic-types.ts`) to track `contentBlockIndex`, open/closed block state, and a `toolCalls` map that aligns OpenAI's per-tool `index` with Anthropic's per-block index. **Tool-call indices are not interchangeable between the two formats** — read the state struct before touching this code.
- `anthropic-types.ts` — single source of truth for incoming Anthropic shapes; mirror new fields here before reading them downstream.
- `handler.ts` — orchestrates: parses payload, calls `translateToOpenAI`, awaits manual approval / rate-limit if enabled, then either returns a JSON response or streams via `streamSSE`.

When Anthropic features need to flow through to Copilot, the work is almost always: add the field to `anthropic-types.ts`, read it in `translateToOpenAI`, add it to `ChatCompletionsPayload` in `services/copilot/create-chat-completions.ts`, done. Example: `thinking_budget` forwarding.

### Copilot impersonation

`src/lib/api-config.ts` constructs the headers Copilot's broker checks. The `editor-version` value comes from `state.vsCodeVersion`, which is fetched live at startup by `cacheVSCodeVersion()` in `src/lib/utils.ts` — so the proxy always claims to be the latest VS Code build. `EDITOR_PLUGIN_VERSION` (`copilot-chat/0.26.7`) and `USER_AGENT` are hardcoded constants; bump them in lockstep when upstream Copilot changes its handshake. `copilotBaseUrl` switches subdomain by `accountType` (individual / business / enterprise).

`create-chat-completions.ts` adds one runtime-derived header: `X-Initiator: agent` if any prior message has `role` of `assistant` or `tool`, else `user`. This affects Copilot premium-request accounting, so don't "simplify" it away.

### Auth flow

GitHub OAuth Device Flow → `state.githubToken` (persisted under `~/.local/share/copilot-api/`) → exchanged via `api.github.com/copilot_internal/v2/token` → `state.copilotToken` (in-memory, refreshed). All of this lives in `src/services/github/` and `src/lib/token.ts`. `state` (`src/lib/state.ts`) is a singleton object — every layer that needs auth or rate-limit config imports it directly.

### CLI

`citty`-based subcommands defined in `src/start.ts`, `src/auth.ts`, `src/check-usage.ts`, `src/debug.ts`, wired up in `src/main.ts`. The `start --claude-code` flag prompts for two model IDs, then writes a shell `export ...; claude` command to the clipboard via `src/lib/shell.ts`.

## Fork-specific behavior

This fork adds `thinking_budget` forwarding for Claude models on Copilot's CAPI path — see the "Extended Thinking" section of README.md for user-facing docs and `translateToOpenAI` for the implementation. Notably:

- The translator drops `temperature` / `top_p` whenever `thinking.type === "enabled"` (Anthropic's invariant).
- The budget is clamped to `max_tokens - 1` locally; per-model min/max clamping is left to Copilot's broker.
- Only `thinking_budget` is forwarded — the Messages-API-only `effort` and `output_config` fields are not, because Copilot's CAPI broker rejects them.
- Per-prompt keyword overrides (`think`, `megathink`, `ultrathink`, etc.) are detected by `detectKeywordBudget` in `non-stream-translation.ts` and act as a floor on top of `MAX_THINKING_TOKENS`; the scanner walks back past `tool_result`/`image`-only user turns so the trigger stays sticky across agentic loops, and fenced code blocks are stripped before matching.
