import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { FAST_BETA_HEADER, parseFastModel } from "~/lib/fast-model"
import { state as defaultState, type State } from "~/lib/state"
import { refreshCopilotToken } from "~/lib/token"

// Copilot rejects an expired IDE/Copilot token with one of these statuses. On
// the request path this happens when the proactive refresh timer was frozen by
// a host suspend/resume, so the in-memory token went stale before the timer
// could rotate it. We refresh once and retry, rather than surfacing the error
// and relying on a crash + process-manager restart to recover.
const AUTH_FAILURE_STATUSES = new Set([401, 403])

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
  state: State = defaultState,
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const enableVision = payload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )

  // Agent/user check for X-Initiator header
  // Determine if any message is from an agent ("assistant" or "tool")
  const isAgentCall = payload.messages.some((msg) =>
    ["assistant", "tool"].includes(msg.role),
  )

  // Fast-mode translation: a `-fast` model id maps to the same Copilot model
  // with a `speed: "fast"` body flag + beta header. Clone (never mutate) the
  // caller's payload — it originates in a translator and may be logged/reused.
  const { baseModel, isFast } = parseFastModel(payload.model)
  const upstreamPayload =
    isFast ? { ...payload, model: baseModel, speed: "fast" } : payload

  // Build headers fresh per attempt so a retry picks up the refreshed token
  // (copilotHeaders reads state.copilotToken) and a new x-request-id.
  const sendRequest = () => {
    const headers: Record<string, string> = {
      ...copilotHeaders(state, enableVision),
      "X-Initiator": isAgentCall ? "agent" : "user",
    }
    if (isFast) headers["anthropic-beta"] = FAST_BETA_HEADER

    return fetch(`${copilotBaseUrl(state)}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamPayload),
    })
  }

  let response = await sendRequest()

  // Auto-recover from a stale token: refresh once and retry the request a
  // single time. Only the refresh is guarded — if it fails we skip the
  // (pointless) retry and surface the original auth error below. A retry that
  // itself throws (network error, abort) propagates normally, exactly as the
  // original single-attempt call did.
  if (!response.ok && AUTH_FAILURE_STATUSES.has(response.status)) {
    consola.warn(
      `Copilot returned ${response.status}; refreshing token before retrying`,
    )
    let refreshed = false
    try {
      await refreshCopilotToken(state)
      refreshed = true
    } catch (error) {
      consola.error("Copilot token refresh failed; not retrying:", error)
    }
    if (refreshed) {
      consola.warn("Token refreshed; retrying request once")
      // Release the discarded first response's body so fetch can reuse the
      // connection instead of leaking it (the retry replaces `response`, and
      // unlike the error path nothing else consumes this body).
      await response.body?.cancel()
      response = await sendRequest()
    }
  }

  if (!response.ok) {
    consola.error("Failed to create chat completions", response)
    throw new HTTPError("Failed to create chat completions", response)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ChatCompletionResponse
}

// Streaming types

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<Choice>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens: number
      rejected_prediction_tokens: number
    }
  }
}

interface Delta {
  content?: string | null
  role?: "user" | "assistant" | "system" | "tool"
  tool_calls?: Array<{
    index: number
    id?: string
    type?: "function"
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

interface Choice {
  index: number
  delta: Delta
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  logprobs: object | null
}

// Non-streaming types

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<ChoiceNonStreaming>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
  }
}

interface ResponseMessage {
  role: "assistant"
  content: string | null
  tool_calls?: Array<ToolCall>
}

interface ChoiceNonStreaming {
  index: number
  message: ResponseMessage
  logprobs: object | null
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter"
}

// Payload types

export interface ChatCompletionsPayload {
  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null

  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  response_format?: { type: "json_object" } | null
  seed?: number | null
  tools?: Array<Tool> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null
  user?: string | null

  // GitHub Copilot CAPI extension for Anthropic models (mirrors vscode-copilot-chat
  // IEndpointBody.thinking_budget). Flat top-level integer; Copilot's broker
  // forwards it as Anthropic's `thinking.budget_tokens` upstream.
  thinking_budget?: number | null

  // GitHub Copilot fast-mode flag. Injected by createChatCompletions when the
  // inbound model id carried a `-fast` suffix; not set by translators.
  speed?: string | null
}

export interface Tool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer"
  content: string | Array<ContentPart> | null

  name?: string
  tool_calls?: Array<ToolCall>
  tool_call_id?: string
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ContentPart = TextPart | ImagePart

export interface TextPart {
  type: "text"
  text: string
}

export interface ImagePart {
  type: "image_url"
  image_url: {
    url: string
    detail?: "low" | "high" | "auto"
  }
}
