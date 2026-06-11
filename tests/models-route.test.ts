import type { Hono } from "hono"

import { describe, test, expect, beforeAll, mock } from "bun:test"

import type { Model } from "../src/services/copilot/get-models"

import { state } from "../src/lib/state"

// Importing the route transitively pulls in get-vscode-version.ts, which runs a
// top-level `await getVSCodeVersion()` (a network fetch) at module load. Mock
// fetch BEFORE that import so the suite stays deterministic and offline.
let modelRoutes: Hono

beforeAll(async () => {
  const fetchMock = mock(() => Promise.resolve(new Response("pkgver=1.104.3")))
  // @ts-expect-error - Mock fetch doesn't implement all fetch properties
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock
  ;({ modelRoutes } = await import("../src/routes/models/route"))
})

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
