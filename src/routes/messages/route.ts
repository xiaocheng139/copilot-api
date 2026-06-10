import { Hono } from "hono"

import { withErrorForwarding } from "~/lib/completion-lifecycle"

import { handleCountTokens } from "./count-tokens-handler"
import { handleCompletion } from "./handler"

export const messageRoutes = new Hono()

messageRoutes.post("/", withErrorForwarding(handleCompletion))

messageRoutes.post("/count_tokens", withErrorForwarding(handleCountTokens))
