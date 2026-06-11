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
  models?: Record<string, ModelsDevModel | null>
}

type ModelsDevApi = Record<string, ModelsDevProvider | undefined>

/**
 * Pure: collect every github-copilot model id whose value declares
 * experimental.modes.fast. Other providers are ignored. Never throws.
 */
export function extractFastCapableIds(
  api: ModelsDevApi | null | undefined,
): Set<string> {
  const ids = new Set<string>()
  const copilot = api?.["github-copilot"]
  if (!copilot?.models) return ids
  for (const [id, model] of Object.entries(copilot.models)) {
    if (model?.experimental?.modes?.fast !== undefined) {
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
