import { Hono } from "hono"

import { withErrorForwarding } from "~/lib/completion-lifecycle"

import { handleCompletion } from "./handler"

export const completionRoutes = new Hono()

completionRoutes.post("/", withErrorForwarding(handleCompletion))
