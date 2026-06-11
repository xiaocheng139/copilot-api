# Copilot Fast Models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user select a `-fast` model id (e.g. `claude-opus-4.8-fast` in Claude Code's `settings.json`) and have the proxy engage GitHub Copilot's low-latency fast mode, while advertising the `-fast` variants in `/models` and the `--claude-code` picker.

**Architecture:** Two decoupled concerns. (1) **Translation** — a single pure parser (`parseFastModel`) wired into the one CAPI chokepoint (`createChatCompletions`) strips the `-fast` suffix, sends the base model with `speed: "fast"` and an `anthropic-beta` header. (2) **Discovery** — a fail-open models.dev fetch (`getFastCapableIds`) feeds a shared pure helper (`withFastVariants`) that synthesizes `-fast` twins for both the `/models` route and the CLI picker. Translation is essential and works even if discovery never runs; discovery only governs what is *listed*.

**Tech Stack:** TypeScript (strict), Bun runtime + `bun:test`, Hono server, citty CLI. Import alias `~/*` → `src/*` inside `src/`; `start.ts` uses relative imports.

---

## Spec reference

Approved spec: `docs/superpowers/specs/2026-06-10-copilot-fast-models-design.md`. Read it once before starting; this plan implements it verbatim.

## File structure

| File | Responsibility |
|---|---|
| `src/lib/fast-model.ts` | **New.** Pure: `FAST_SUFFIX`, `FAST_BETA_HEADER`, `parseFastModel`, `withFastVariants`. No I/O. |
| `src/services/models-dev/get-fast-capable.ts` | **New.** Fetch models.dev (fail-open, ~3s timeout) + pure `extractFastCapableIds`. |
| `src/services/copilot/create-chat-completions.ts` | Wire `parseFastModel` into the chokepoint (clone, inject); add `speed?` to payload type. |
| `src/lib/state.ts` | Add `fastCapableIds: Set<string>` (default empty). |
| `src/lib/utils.ts` | Add `cacheFastCapableIds()`. |
| `src/start.ts` | `await cacheFastCapableIds()` at startup; route picker ids through `withFastVariants`. |
| `src/routes/models/route.ts` | Synthesize `-fast` entries via `withFastVariants`. |
| `tests/fast-model.test.ts` | **New.** Unit tests for `parseFastModel` + `withFastVariants`. |
| `tests/get-fast-capable.test.ts` | **New.** Unit tests for `extractFastCapableIds` + fail-open `getFastCapableIds`. |
| `tests/create-chat-completions.test.ts` | Extend with fast-mode + no-mutation assertions. |
| `tests/models-route.test.ts` | **New.** `/models` advertisement. |
| `README.md` | Document fast mode usage. |

## Important constraints for the implementer

- **Do not stage unrelated working-tree changes.** `git status` currently shows modified `bun.lock` and `src/lib/error.ts` (a 401-exit handler) that are **not part of this feature**. Only `git add` the exact files each task names.
- **Match house style:** strict TS, no `any`, `camelCase`/`PascalCase`, explicit error classes, no silent failures. `start.ts` imports relatively (`./lib/...`); everything under `src/` elsewhere uses `~/...`.
- **Verify commands:** typecheck `bun run typecheck`; single test file `bun test tests/<file>.test.ts`; lint `bun run lint`. A pre-commit hook runs `lint --fix` on staged files.

---

## Task 0: Live Copilot wire-contract probe (gating)

**Why first:** Reading code proves the *shape* opencode sends, but not that Copilot's CAPI *accepts* `speed: "fast"` + the beta header and actually engages fast mode. This is the one empirical unknown. Tasks 1–2 are pure and probe-independent, so they are safe to build regardless — but **Task 3 must not be finalized until this probe confirms the wire contract.** If the probe fails, update the spec's wire contract and adjust Task 3 before committing it.

**Files:** none (manual validation).

- [ ] **Step 1: Obtain a live Copilot token**

Run the server once in verbose mode in a scratch terminal so the token is fetched and cached, or read it from the running `state`. The simplest path: start the dev server (`bun run dev`) after auth; it logs/holds `state.copilotToken`. You need that bearer token plus the standard headers from `src/lib/api-config.ts` (`copilotHeaders`).

- [ ] **Step 2: Send a fast request and a baseline request**

Against the real CAPI endpoint (`https://api.githubcopilot.com/chat/completions`), send two requests with identical bodies except the fast flag/header:

```bash
# FAST variant — base model id, speed flag, beta header
curl -sS -X POST https://api.githubcopilot.com/chat/completions \
  -H "authorization: Bearer $COPILOT_TOKEN" \
  -H "copilot-integration-id: vscode-chat" \
  -H "editor-version: vscode/1.104.3" \
  -H "x-github-api-version: 2025-04-01" \
  -H "anthropic-beta: fast-mode-2026-02-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-opus-4.8","speed":"fast","messages":[{"role":"user","content":"Say hi in one word."}]}'

# BASELINE — same body without speed flag / beta header
curl -sS -X POST https://api.githubcopilot.com/chat/completions \
  -H "authorization: Bearer $COPILOT_TOKEN" \
  -H "copilot-integration-id: vscode-chat" \
  -H "editor-version: vscode/1.104.3" \
  -H "x-github-api-version: 2025-04-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-opus-4.8","messages":[{"role":"user","content":"Say hi in one word."}]}'
```

(Use the exact header values your `copilotHeaders` produces — the editor-version is live-fetched, so copy it from a verbose server log rather than hardcoding.)

- [ ] **Step 3: Decide**

- **PASS** (fast request returns `200` with a normal completion, ideally faster/lower-latency): the opencode wire shape is correct. Proceed; Task 3 stands as written.
- **FAIL** (fast request returns `4xx` rejecting `speed` or the beta header): STOP. Record the error body. Update the spec's "Root cause / wire contract" and Task 3's injected fields to match what Copilot actually accepts, then continue.

- [ ] **Step 4: Record the outcome** in the PR description / spec so reviewers know the contract was empirically confirmed.

---

## Task 1: `parseFastModel` + constants

**Files:**
- Create: `src/lib/fast-model.ts`
- Test: `tests/fast-model.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/fast-model.test.ts`:

```ts
import { describe, test, expect } from "bun:test"

import {
  FAST_SUFFIX,
  FAST_BETA_HEADER,
  parseFastModel,
} from "../src/lib/fast-model"

describe("parseFastModel", () => {
  test("strips a trailing -fast suffix", () => {
    expect(parseFastModel("claude-opus-4.8-fast")).toEqual({
      baseModel: "claude-opus-4.8",
      isFast: true,
    })
  })

  test("leaves a non-fast model untouched", () => {
    expect(parseFastModel("claude-opus-4.8")).toEqual({
      baseModel: "claude-opus-4.8",
      isFast: false,
    })
  })

  test("strips exactly one suffix when doubled", () => {
    expect(parseFastModel("claude-opus-4.8-fast-fast")).toEqual({
      baseModel: "claude-opus-4.8-fast",
      isFast: true,
    })
  })

  test("treats a bare suffix as fast with empty base", () => {
    expect(parseFastModel("-fast")).toEqual({ baseModel: "", isFast: true })
  })

  test("handles the empty string", () => {
    expect(parseFastModel("")).toEqual({ baseModel: "", isFast: false })
  })

  test("is case sensitive — -FAST is not matched", () => {
    expect(parseFastModel("claude-opus-4.8-FAST")).toEqual({
      baseModel: "claude-opus-4.8-FAST",
      isFast: false,
    })
  })
})

describe("constants", () => {
  test("expose the agreed suffix and beta header", () => {
    expect(FAST_SUFFIX).toBe("-fast")
    expect(FAST_BETA_HEADER).toBe("fast-mode-2026-02-01")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/fast-model.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/fast-model'`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/lib/fast-model.ts`:

```ts
export const FAST_SUFFIX = "-fast"
export const FAST_BETA_HEADER = "fast-mode-2026-02-01"

export interface ParsedFastModel {
  baseModel: string
  isFast: boolean
}

/**
 * Split a `-fast` variant id into its base model and a fast flag.
 *
 * "claude-opus-4.8-fast" -> { baseModel: "claude-opus-4.8", isFast: true }
 * "claude-opus-4.8"      -> { baseModel: "claude-opus-4.8", isFast: false }
 *
 * Strips exactly one trailing `-fast`. Case sensitive. The only edge input is
 * "" (-> { baseModel: "", isFast: false }); a bare "-fast" yields
 * { baseModel: "", isFast: true }.
 */
export function parseFastModel(model: string): ParsedFastModel {
  if (model.endsWith(FAST_SUFFIX)) {
    return { baseModel: model.slice(0, -FAST_SUFFIX.length), isFast: true }
  }
  return { baseModel: model, isFast: false }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/fast-model.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/fast-model.ts tests/fast-model.test.ts
git commit -m "feat(fast): add parseFastModel + constants"
```

---

## Task 2: `withFastVariants` helper

**Files:**
- Modify: `src/lib/fast-model.ts`
- Test: `tests/fast-model.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `tests/fast-model.test.ts` (add `withFastVariants` to the existing import from `../src/lib/fast-model`):

```ts
import { withFastVariants } from "../src/lib/fast-model"

describe("withFastVariants", () => {
  const capable = new Set(["a", "c"])
  const makeTwin = (base: { id: string; label: string }) => ({
    ...base,
    id: `${base.id}-fast`,
  })

  test("emits a twin after each fast-capable entry, base-then-twin order", () => {
    const input = [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
    ]
    const out = withFastVariants(input, capable, makeTwin)
    expect(out.map((m) => m.id)).toEqual(["a", "a-fast", "b", "c", "c-fast"])
  })

  test("emits nothing extra when the set is empty", () => {
    const input = [{ id: "a", label: "A" }]
    const out = withFastVariants(input, new Set(), makeTwin)
    expect(out.map((m) => m.id)).toEqual(["a"])
  })

  test("the twin is produced by makeTwin (carries other fields)", () => {
    const out = withFastVariants([{ id: "a", label: "A" }], capable, makeTwin)
    expect(out[1]).toEqual({ id: "a-fast", label: "A" })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/fast-model.test.ts`
Expected: FAIL — `withFastVariants` is not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/lib/fast-model.ts`:

```ts
/**
 * Given real model entries and the fast-capable id set, return each base entry
 * immediately followed by a synthesized `-fast` twin when its id is fast-capable.
 * `makeTwin` is supplied by the caller so the twin matches that surface's object
 * shape (the /models response shape, or the picker's id-bearing model object).
 */
export function withFastVariants<T extends { id: string }>(
  models: Array<T>,
  fastCapableIds: Set<string>,
  makeTwin: (base: T) => T,
): Array<T> {
  const result: Array<T> = []
  for (const model of models) {
    result.push(model)
    if (fastCapableIds.has(model.id)) {
      result.push(makeTwin(model))
    }
  }
  return result
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/fast-model.test.ts`
Expected: PASS (10 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/lib/fast-model.ts tests/fast-model.test.ts
git commit -m "feat(fast): add withFastVariants twin helper"
```

---

## Task 3: Wire fast translation into the CAPI chokepoint

**Files:**
- Modify: `src/services/copilot/create-chat-completions.ts:1-47` (imports + function body) and the `ChatCompletionsPayload` interface (`:127-156`)
- Test: `tests/create-chat-completions.test.ts` (extend)

**Gate:** Task 0 must PASS (or its required wire-contract adjustments applied) before committing this task.

- [ ] **Step 1: Write the failing tests**

Append to `tests/create-chat-completions.test.ts`:

```ts
test("fast model: strips -fast, sends base model + speed + beta header", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "claude-opus-4.8-fast",
  }
  await createChatCompletions(payload)

  const call = fetchMock.mock.calls.at(-1) as [
    string,
    { headers: Record<string, string>; body: string },
  ]
  const sentBody = JSON.parse(call[1].body) as { model: string; speed?: string }
  expect(sentBody.model).toBe("claude-opus-4.8")
  expect(sentBody.speed).toBe("fast")
  expect(call[1].headers["anthropic-beta"]).toBe("fast-mode-2026-02-01")
})

test("non-fast model: no speed field, no beta header", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "claude-opus-4.8",
  }
  await createChatCompletions(payload)

  const call = fetchMock.mock.calls.at(-1) as [
    string,
    { headers: Record<string, string>; body: string },
  ]
  const sentBody = JSON.parse(call[1].body) as { model: string; speed?: string }
  expect(sentBody.model).toBe("claude-opus-4.8")
  expect(sentBody.speed).toBeUndefined()
  expect(call[1].headers["anthropic-beta"]).toBeUndefined()
})

test("does not mutate the caller's payload object", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "claude-opus-4.8-fast",
  }
  await createChatCompletions(payload)

  // The clone must leave the caller's object pristine for logging/reuse.
  expect(payload.model).toBe("claude-opus-4.8-fast")
  expect((payload as { speed?: string }).speed).toBeUndefined()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/create-chat-completions.test.ts`
Expected: FAIL — fast test sees `model: "claude-opus-4.8-fast"` upstream (suffix not stripped) and no `speed`/`anthropic-beta`.

- [ ] **Step 3: Add the import**

In `src/services/copilot/create-chat-completions.ts`, add the fast-model import alongside the existing imports (after the `HTTPError` import, before `state`):

```ts
import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { FAST_BETA_HEADER, parseFastModel } from "~/lib/fast-model"
import { state } from "~/lib/state"
```

- [ ] **Step 4: Inject the fast translation before the fetch**

Replace the fetch block (currently lines ~31–35):

```ts
  const response = await fetch(`${copilotBaseUrl(state)}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })
```

with a clone-and-inject just above it:

```ts
  // Fast-mode translation: a `-fast` model id maps to the same Copilot model
  // with a `speed: "fast"` body flag + beta header. Clone (never mutate) the
  // caller's payload — it originates in a translator and may be logged/reused.
  const { baseModel, isFast } = parseFastModel(payload.model)
  const upstreamPayload =
    isFast ? { ...payload, model: baseModel, speed: "fast" } : payload
  if (isFast) headers["anthropic-beta"] = FAST_BETA_HEADER

  const response = await fetch(`${copilotBaseUrl(state)}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(upstreamPayload),
  })
```

(Leave the later `if (payload.stream)` check reading `payload` — the clone preserves `stream` identically.)

- [ ] **Step 5: Add `speed?` to the payload interface**

In the same file, in `ChatCompletionsPayload`, add the `speed` field after `thinking_budget` (keep the existing comment block above `thinking_budget` intact):

```ts
  thinking_budget?: number | null

  // GitHub Copilot fast-mode flag. Injected by createChatCompletions when the
  // inbound model id carried a `-fast` suffix; not set by translators.
  speed?: string | null
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test tests/create-chat-completions.test.ts`
Expected: PASS (all 5 tests — 2 original X-Initiator + 3 new).

- [ ] **Step 7: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/services/copilot/create-chat-completions.ts tests/create-chat-completions.test.ts
git commit -m "feat(fast): engage Copilot fast mode at the CAPI chokepoint"
```

---

## Task 4: models.dev discovery (`getFastCapableIds`)

**Files:**
- Create: `src/services/models-dev/get-fast-capable.ts`
- Test: `tests/get-fast-capable.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/get-fast-capable.test.ts`. The pure `extractFastCapableIds` is tested against an inline captured fixture; `getFastCapableIds` is tested for fail-open behavior with a mocked global fetch.

```ts
import { describe, test, expect, mock } from "bun:test"

import {
  extractFastCapableIds,
  getFastCapableIds,
} from "../src/services/models-dev/get-fast-capable"

// Captured shape of models.dev /api.json (trimmed to the relevant structure).
const fixture = {
  "github-copilot": {
    models: {
      "claude-opus-4.8": {
        experimental: {
          modes: {
            fast: {
              provider: {
                body: { speed: "fast" },
                headers: { "anthropic-beta": "fast-mode-2026-02-01" },
              },
            },
          },
        },
      },
      "claude-sonnet-4.5": {},
    },
  },
  openai: {
    models: {
      "gpt-5": { experimental: { modes: { fast: {} } } },
    },
  },
}

describe("extractFastCapableIds", () => {
  test("collects github-copilot ids that have experimental.modes.fast", () => {
    expect(extractFastCapableIds(fixture)).toEqual(new Set(["claude-opus-4.8"]))
  })

  test("ignores other providers' fast modes", () => {
    // openai/gpt-5 is fast-capable on models.dev but must not appear.
    expect(extractFastCapableIds(fixture).has("gpt-5")).toBe(false)
  })

  test("returns an empty set when github-copilot is absent", () => {
    expect(extractFastCapableIds({})).toEqual(new Set())
  })

  test("returns an empty set when github-copilot has no models", () => {
    expect(extractFastCapableIds({ "github-copilot": {} })).toEqual(new Set())
  })
})

describe("getFastCapableIds (fail-open)", () => {
  test("returns the parsed set on a successful fetch", async () => {
    const fetchMock = mock(() => ({ ok: true, json: () => fixture }))
    // @ts-expect-error - partial fetch mock
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock
    expect(await getFastCapableIds()).toEqual(new Set(["claude-opus-4.8"]))
  })

  test("returns an empty set when fetch throws", async () => {
    const fetchMock = mock(() => {
      throw new Error("network down")
    })
    // @ts-expect-error - partial fetch mock
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock
    expect(await getFastCapableIds()).toEqual(new Set())
  })

  test("returns an empty set on a non-ok response", async () => {
    const fetchMock = mock(() => ({ ok: false, json: () => ({}) }))
    // @ts-expect-error - partial fetch mock
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock
    expect(await getFastCapableIds()).toEqual(new Set())
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/get-fast-capable.test.ts`
Expected: FAIL — `Cannot find module '../src/services/models-dev/get-fast-capable'`.

- [ ] **Step 3: Write the implementation**

Create `src/services/models-dev/get-fast-capable.ts`. Mirrors the fail-open fetch-with-timeout pattern in `src/services/get-vscode-version.ts`.

```ts
import consola from "consola"

const MODELS_DEV_URL = "https://models.dev/api.json"
const FETCH_TIMEOUT_MS = 3000

interface ModelsDevModel {
  experimental?: {
    modes?: {
      fast?: unknown
    }
  }
}

interface ModelsDevProvider {
  models?: Record<string, ModelsDevModel>
}

type ModelsDevApi = Record<string, ModelsDevProvider>

/**
 * Pure: collect every github-copilot model id whose value declares
 * experimental.modes.fast. Other providers are ignored. Never throws.
 */
export function extractFastCapableIds(api: ModelsDevApi): Set<string> {
  const ids = new Set<string>()
  const copilot = api["github-copilot"]
  if (!copilot?.models) return ids
  for (const [id, model] of Object.entries(copilot.models)) {
    if (model.experimental?.modes?.fast !== undefined) {
      ids.add(id)
    }
  }
  return ids
}

/**
 * Fetch models.dev and return the set of fast-capable github-copilot model ids.
 * Fail-open: any fetch/parse/schema failure (or a ~3s timeout) yields an empty
 * set so startup and translation are never blocked by models.dev.
 */
export async function getFastCapableIds(): Promise<Set<string>> {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(MODELS_DEV_URL, { signal: controller.signal })
    if (!response.ok) return new Set()
    const data = (await response.json()) as ModelsDevApi
    return extractFastCapableIds(data)
  } catch {
    consola.warn(
      "Failed to fetch models.dev fast-capable set; -fast variants will not be listed",
    )
    return new Set()
  } finally {
    clearTimeout(timeout)
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/get-fast-capable.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/services/models-dev/get-fast-capable.ts tests/get-fast-capable.test.ts
git commit -m "feat(fast): discover fast-capable models from models.dev (fail-open)"
```

---

## Task 5: State field + cache helper

**Files:**
- Modify: `src/lib/state.ts:1-25`
- Modify: `src/lib/utils.ts:1-19`

No new test file — this is plumbing exercised end-to-end by Tasks 6–7. The `bun run typecheck` step guards it.

- [ ] **Step 1: Add `fastCapableIds` to State**

Edit `src/lib/state.ts`. Add the field to the interface (after `models?`) and to the initializer:

```ts
import type { ModelsResponse } from "~/services/copilot/get-models"

export interface State {
  githubToken?: string
  copilotToken?: string

  accountType: string
  models?: ModelsResponse
  fastCapableIds: Set<string>
  vsCodeVersion?: string

  manualApprove: boolean
  rateLimitWait: boolean
  showToken: boolean

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number
}

export const state: State = {
  accountType: "individual",
  fastCapableIds: new Set(),
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
}
```

- [ ] **Step 2: Add `cacheFastCapableIds` to utils**

Edit `src/lib/utils.ts`. Add the import and the helper mirroring `cacheModels`:

```ts
import consola from "consola"

import { getModels } from "~/services/copilot/get-models"
import { getVSCodeVersion } from "~/services/get-vscode-version"
import { getFastCapableIds } from "~/services/models-dev/get-fast-capable"

import { state } from "./state"

export const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export const isNullish = (value: unknown): value is null | undefined =>
  value === null || value === undefined

export async function cacheModels(): Promise<void> {
  const models = await getModels()
  state.models = models
}

export async function cacheFastCapableIds(): Promise<void> {
  state.fastCapableIds = await getFastCapableIds()
}

export const cacheVSCodeVersion = async () => {
  const response = await getVSCodeVersion()
  state.vsCodeVersion = response

  consola.info(`Using VSCode version: ${response}`)
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: no errors (the required `fastCapableIds` is satisfied by the initializer).

- [ ] **Step 4: Run the existing suite to confirm nothing broke**

Run: `bun test`
Expected: PASS (all prior tests + Tasks 1–4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/state.ts src/lib/utils.ts
git commit -m "feat(fast): add fastCapableIds state + cacheFastCapableIds helper"
```

---

## Task 6: Startup fetch + `--claude-code` picker

**Files:**
- Modify: `src/start.ts:14` (import), `:61-65` (startup fetch), `:69-86` (picker)

- [ ] **Step 1: Extend the utils import and add the fast-model import**

Edit `src/start.ts`. Update the utils import to include `cacheFastCapableIds`, and add a fast-model import (relative, matching this file's convention):

```ts
import { cacheFastCapableIds, cacheModels, cacheVSCodeVersion } from "./lib/utils"
```

Add a fast-model import (relative, matching this file's convention). It sorts to the **top** of the `./lib/*` import group — place it immediately above `import { ensurePaths } from "./lib/paths"`:

```ts
import { FAST_SUFFIX, withFastVariants } from "./lib/fast-model"
import { ensurePaths } from "./lib/paths"
```

- [ ] **Step 2: Await the discovery fetch at startup**

After `await cacheModels()` (line ~61), add:

```ts
  await setupCopilotToken()
  await cacheModels()
  await cacheFastCapableIds()
```

(Deliberate: awaiting — not fire-and-forget — is what lets the synchronous picker below include `-fast` variants. Bounded by the ~3s fail-open timeout inside `getFastCapableIds`.)

- [ ] **Step 3: Route the picker options through `withFastVariants`**

Replace the `--claude-code` block's two inline `options:` lists. Currently both read `state.models.data.map((model) => model.id)`. Compute the list once just after the `invariant(state.models, ...)` line, then reuse it:

```ts
  if (options.claudeCode) {
    invariant(state.models, "Models should be loaded by now")

    const modelOptions = withFastVariants(
      state.models.data,
      state.fastCapableIds,
      (base) => ({ ...base, id: `${base.id}${FAST_SUFFIX}` }),
    ).map((model) => model.id)

    const selectedModel = await consola.prompt(
      "Select a model to use with Claude Code",
      {
        type: "select",
        options: modelOptions,
      },
    )

    const selectedSmallModel = await consola.prompt(
      "Select a small model to use with Claude Code",
      {
        type: "select",
        options: modelOptions,
      },
    )
```

(The rest of the block — `generateEnvScript`, clipboard — is unchanged.)

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Smoke-check startup (optional but recommended)**

Run: `bun run dev` (with valid auth). Expected: server starts; the `Available models:` log appears; no crash from the new await. Stop the server.

- [ ] **Step 6: Commit**

```bash
git add src/start.ts
git commit -m "feat(fast): fetch fast set at startup and offer -fast in picker"
```

---

## Task 7: `/models` route advertisement

**Files:**
- Modify: `src/routes/models/route.ts:1-34`
- Test: `tests/models-route.test.ts`

- [ ] **Step 1: Write the failing tests**

> Note: importing the route transitively loads `~/services/get-vscode-version`, which runs a real `fetch` at module load (top-level `await`, pre-existing). It is fail-open with a 5s timeout, so the first import in this test file may pause briefly before falling back — this is expected, not a hang. Do not "fix" that module; it is out of scope.

Create `tests/models-route.test.ts`:

```ts
import { describe, test, expect } from "bun:test"

import type { Model } from "../src/services/copilot/get-models"

import { state } from "../src/lib/state"
import { modelRoutes } from "../src/routes/models/route"

function makeModel(id: string, name: string, vendor = "anthropic"): Model {
  return {
    capabilities: {
      family: id,
      limits: {},
      object: "model_capabilities",
      supports: {},
      tokenizer: "o200k_base",
      type: "chat",
    },
    id,
    model_picker_enabled: true,
    name,
    object: "model",
    preview: false,
    vendor,
    version: "1",
  }
}

interface ModelEntry {
  id: string
  object: string
  type: string
  created: number
  created_at: string
  owned_by: string
  display_name: string
}

describe("GET /models fast advertisement", () => {
  test("emits a -fast twin for each fast-capable model, carrying all fields", async () => {
    state.models = {
      object: "list",
      data: [
        makeModel("claude-opus-4.8", "Claude Opus 4.8"),
        makeModel("gpt-4", "GPT-4", "openai"),
      ],
    }
    state.fastCapableIds = new Set(["claude-opus-4.8"])

    const res = await modelRoutes.request("/")
    const body = (await res.json()) as { data: Array<ModelEntry> }

    expect(body.data.map((m) => m.id)).toEqual([
      "claude-opus-4.8",
      "claude-opus-4.8-fast",
      "gpt-4",
    ])

    const base = body.data[0]
    const twin = body.data[1]
    // Twin carries every base field, overriding only id + display_name.
    expect(twin.owned_by).toBe(base.owned_by)
    expect(twin.type).toBe(base.type)
    expect(twin.created).toBe(base.created)
    expect(twin.created_at).toBe(base.created_at)
    expect(twin.display_name).toBe("Claude Opus 4.8 (Fast)")
    // And is a distinct object, not a shared reference.
    expect(twin).not.toBe(base)
  })

  test("emits only base entries when the fast set is empty", async () => {
    state.models = {
      object: "list",
      data: [makeModel("claude-opus-4.8", "Claude Opus 4.8")],
    }
    state.fastCapableIds = new Set()

    const res = await modelRoutes.request("/")
    const body = (await res.json()) as { data: Array<ModelEntry> }

    expect(body.data.map((m) => m.id)).toEqual(["claude-opus-4.8"])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/models-route.test.ts`
Expected: FAIL — only base entries returned; no `claude-opus-4.8-fast`.

- [ ] **Step 3: Wire `withFastVariants` into the route**

Edit `src/routes/models/route.ts`. Add the import and pass the mapped entries through `withFastVariants`:

```ts
import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { FAST_SUFFIX, withFastVariants } from "~/lib/fast-model"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"

export const modelRoutes = new Hono()

modelRoutes.get("/", async (c) => {
  try {
    if (!state.models) {
      // This should be handled by startup logic, but as a fallback.
      await cacheModels()
    }

    const models =
      state.models ?
        withFastVariants(
          state.models.data.map((model) => ({
            id: model.id,
            object: "model",
            type: "model",
            created: 0, // No date available from source
            created_at: new Date(0).toISOString(), // No date available from source
            owned_by: model.vendor,
            display_name: model.name,
          })),
          state.fastCapableIds,
          (base) => ({
            ...base,
            id: `${base.id}${FAST_SUFFIX}`,
            display_name: `${base.display_name} (Fast)`,
          }),
        )
      : undefined

    return c.json({
      object: "list",
      data: models,
      has_more: false,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})
```

(The `state.models ? … : undefined` guard preserves the original behavior of returning `data: undefined` when models are unavailable.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/models-route.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/routes/models/route.ts tests/models-route.test.ts
git commit -m "feat(fast): advertise -fast variants in /models"
```

---

## Task 8: README documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a Fast Mode section**

Open `README.md` and append a new `## Fast Mode` section (place it near the "Extended Thinking" section so the Copilot-Claude features sit together). Add exactly the markdown below (the outer four-backtick fence is only this plan's wrapper — write a normal section into the README):

````markdown
## Fast Mode

GitHub Copilot offers a low-latency "fast" variant for some Claude models
(currently `claude-opus-4.6`, `claude-opus-4.7`, `claude-opus-4.8`). To use it,
append `-fast` to the model id — no other configuration is required.

In Claude Code's `settings.json`:

```json
{
  "env": {
    "ANTHROPIC_MODEL": "claude-opus-4.8-fast"
  }
}
```

The proxy strips the `-fast` suffix, forwards the base model to Copilot, and adds
the `speed: "fast"` request flag plus the `anthropic-beta: fast-mode-2026-02-01`
header that engages fast mode. The `-fast` variants also appear in the `/models`
list and the `--claude-code` model picker for fast-capable models.

The fast-capable set is discovered from [models.dev](https://models.dev) at
startup. If models.dev is unreachable, the `-fast` variants are omitted from the
listing, but a hardcoded `-fast` model id still engages fast mode.
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document Copilot fast mode (-fast suffix)"
```

---

## Final verification

- [ ] **Run the full test suite**

Run: `bun test`
Expected: PASS — all suites green (`fast-model`, `get-fast-capable`, `create-chat-completions`, `models-route`, plus pre-existing tests).

- [ ] **Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: no errors.

- [ ] **Confirm scope hygiene**

Run: `git status`
Expected: the only modified-but-unstaged files are the pre-existing `bun.lock` and `src/lib/error.ts` (NOT part of this feature). All feature files are committed.

## Plan ↔ spec coverage

| Spec requirement | Task |
|---|---|
| `parseFastModel`, constants | Task 1 |
| `withFastVariants` shared helper | Task 2 |
| Chokepoint clone + inject `speed`/header; `speed?` on payload type | Task 3 |
| Live Copilot probe (gating) | Task 0 |
| `getFastCapableIds` fail-open + pure extract | Task 4 |
| `state.fastCapableIds` + `cacheFastCapableIds` | Task 5 |
| Startup `await`; picker via `withFastVariants` | Task 6 |
| `/models` advertisement (spread base, override id + display_name) | Task 7 |
| No-mutation regression; route field-carry + distinct-ref tests | Tasks 3, 7 |
| README usage docs | Task 8 |
