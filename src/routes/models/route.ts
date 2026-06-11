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
