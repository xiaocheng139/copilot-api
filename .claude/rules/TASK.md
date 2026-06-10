# TASK.md — How to work on a task

Rules for executing the structured tasks under `tasks/`. Every agent working a
task MUST follow these.

> Not to be confused with `TASKS.md` (plural), which is a free-form **backlog**
> of deferred work. **This** file (`TASK.md`, singular) is the **process rule**
> for the structured, tracked tasks in `tasks/*.json`.

## What a task is

Each file in `tasks/` (e.g. `tasks/ARCH-001-shared-copilot-wire-primitives.json`)
is one task and the **single source of truth** for its state. Schema:

```jsonc
{
  "id": "ARCH-001",
  "title": "...",
  "status": "Not started",          // see lifecycle below
  "priority": 1, "leverage": "...", "risk": "...", "source": "...",
  "body": { "summary", "files", "problem", "solution", "benefits",
            "deletion_test", "risk_notes", "acceptance_criteria", "out_of_scope" },
  "progress": [                       // append-only timeline
    { "timestamp": "YYYY-MM-DD", "status": "...", "note": "..." }
  ]
}
```

`status` is exactly one of: **`Not started`** → **`In progress`** →
**`Pending Verification`** → **`Done`**.

## Lifecycle & who owns each transition

| Transition | Who may perform it |
| --- | --- |
| `Not started` → `In progress` | main agent (when starting work) |
| `In progress` → `Pending Verification` | main agent (when work is believed complete) |
| `Pending Verification` → **`Done`** | **verification subagent ONLY** |
| `Pending Verification` → `In progress` (kickback on failure) | **verification subagent ONLY** |

**The main agent MUST NOT write `"status": "Done"`.** The implementer does not
grade its own homework — promotion to `Done` is reserved for an independent
verification subagent (see Rule 3). This is non-negotiable.

## Rule 1 — The task JSON is the live record; update it continuously

Treat `tasks/<id>.json` like a build log, not a spec you read once.

- **On every status transition** and **every meaningful checkpoint** (a sub-step
  finished, a blocker hit, a decision made), append one entry to `progress[]`:
  `{ "timestamp": "<today, YYYY-MM-DD>", "status": "<current status>", "note": "<what happened / what's verified / what's left>" }`.
- `progress[]` is **append-only** — never rewrite or delete prior entries; the
  timeline is the audit trail.
- Keep `status` in sync with reality at all times. If you stop mid-task, the JSON
  must already reflect where you actually are (per coding-rule "Checkpoint after
  every significant step").
- Do not silently skip work. If an acceptance criterion can't be met, say so in a
  `progress[]` note and leave the status honest (`In progress`), never `Done`.

## Rule 2 — One worktree + one branch per task

Each task is developed in **its own git worktree on its own branch**, so tasks
stay isolated and can land as independent PRs.

- **Create** when moving a task to `In progress`:
  ```bash
  # branch name: task/<id>-<slug>   (reuse the slug from the task filename)
  git worktree add ../copilot-api-<id> -b task/<id>-<slug> <base>
  # e.g.
  git worktree add ../copilot-api-ARCH-001 -b task/ARCH-001-shared-copilot-wire-primitives main
  ```
  Claude Code agents may instead use the `EnterWorktree` tool, which manages the
  worktree under `.claude/worktrees/` automatically.
- **Base branch:** branch from the current integration branch (e.g. `main`)
  unless the task declares a dependency — then branch from that task's branch.
  (Example: ARCH-002 depends on ARCH-001, so ARCH-002's worktree branches off
  `task/ARCH-001-...`, not `main`.)
- **Do all of a task's edits, commits, and verification inside that worktree.**
  Never develop two tasks in the same working tree.
- **Never commit the worktree directory itself.** If a worktree is created inside
  the repo, add its path to `.gitignore`.
- **Cleanup** after the task is `Done` and merged:
  `git worktree remove ../copilot-api-<id>` (Claude Code: `ExitWorktree`).

## Rule 3 — Verification is delegated to a subagent (main agent cannot self-verify)

When the main agent has finished the work, it sets `Pending Verification` and
**stops** — it does **not** promote to `Done`. Instead it **dispatches a separate
verification subagent** (via the `Agent` tool, e.g. `subagent_type: general-purpose`
or a code-review agent) operating **in the task's worktree**.

The verification subagent — and only it — does the following:

1. Reads the task's `body.acceptance_criteria` and `body.out_of_scope`.
2. **Independently** runs the gates (do not trust the implementer's claims):
   - `bun test`
   - `bun run typecheck`
   - `bun run lint`
3. Checks the actual diff against **each** acceptance criterion, and confirms the
   change stayed within `out_of_scope` boundaries.
4. Records the outcome by appending a `progress[]` entry, then sets status:
   - **All criteria met + all gates green** → set `status: "Done"`.
   - **Anything fails / unverifiable** → set `status: "In progress"` (kick back),
     with a `progress[]` note listing exactly what failed. Hand back to the main
     agent.

The verification subagent must be a **fresh, independent** dispatch — its job is
adversarial confirmation, not rubber-stamping. The main agent may not perform
steps 1–4 itself, and may not write `Done` under any circumstances.

## End-to-end checklist for one task

1. Pick the task; `git worktree add` a branch for it (Rule 2).
2. Append a `progress[]` entry and set `status: "In progress"` (Rule 1).
3. Implement, committing inside the worktree; append `progress[]` at each
   checkpoint (Rule 1).
4. When you believe it's done, append a `progress[]` entry and set
   `status: "Pending Verification"`. **Stop.**
5. Dispatch a verification subagent in the worktree (Rule 3).
6. Subagent runs gates + checks acceptance criteria, then sets `Done` (pass) or
   `In progress` (kickback). Only the subagent does this.
7. Once `Done`, open the PR; after merge, remove the worktree (Rule 2).
