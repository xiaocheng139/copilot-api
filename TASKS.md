# TASKS

Tracking deferred work and known limitations. New items go at the top of their section.

## Backlog

### Per-client isolation for parallel agents

When running Claude Code (on `/v1/messages`) and Codex CLI (on `/v1/responses`)
against the same proxy instance, the request paths themselves are independent —
but several proxy-wide controls are still global and can cause one client to
interfere with the other.

- **`--rate-limit <seconds>` is global.** Both clients share the cooldown
  window. A heavy Claude Code session can starve Codex requests and vice
  versa. Investigate either per-route windows or per-client headers (e.g.,
  `x-client-id`) to scope the gate.
- **`--manual` (request approval) queues globally.** Both clients' requests
  hit the same stdin prompt. Workable but awkward when two agents fire
  concurrently. Consider scoping by route, or labelling the prompt with the
  originating endpoint.
- **`MAX_THINKING_TOKENS` is process-wide.** It applies to every Claude
  thinking-eligible request regardless of which client sent it. The
  per-prompt keyword override (already shipped) and the Codex `reasoning.effort`
  → `thinking_budget` mapping (in design) both layer on top of it, but there
  is no way to set "10000 for Claude Code, 0 for Codex". A per-route default
  env var (e.g., `MAX_THINKING_TOKENS_MESSAGES`,
  `MAX_THINKING_TOKENS_RESPONSES`) would address this.

**Workaround today:** run two proxy instances on different ports, each with
its own `--rate-limit` / `--manual` / `MAX_THINKING_TOKENS`. Same upstream
Copilot token in both, so GitHub abuse-detection risk is unchanged.

### Codex reasoning on GPT-5 / o-series via Copilot

The first cut of `/v1/responses` translates Codex requests to Copilot's
`/chat/completions` upstream for all models. That means GPT-5 and o-series
"reasoning" models routed through Codex lose their `reasoning.effort` —
Copilot's chat-completions endpoint doesn't accept that field, and we drop
it for GPT models. To restore it, we would need to add an upstream
Responses-API client and route reasoning models there (mirroring what
VS Code Copilot Chat does internally). Document the limitation in README
when the initial `/v1/responses` ships.
