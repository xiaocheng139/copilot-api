import { Hono } from "hono"

import { withErrorForwarding } from "~/lib/completion-lifecycle"

import { handleResponses } from "./handler"

export const responseRoutes = new Hono()

responseRoutes.post("/", withErrorForwarding(handleResponses))
