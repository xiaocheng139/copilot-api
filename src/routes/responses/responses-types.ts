// OpenAI Responses API — incoming payload types from Codex CLI.

export interface ResponsesInputTextPart {
  type: "input_text"
  text: string
}

export interface ResponsesOutputTextPart {
  type: "output_text"
  text: string
}

export interface ResponsesInputImagePart {
  type: "input_image"
  image_url: string
  detail?: "low" | "high" | "auto"
}

export type ResponsesContentPart =
  | ResponsesInputTextPart
  | ResponsesOutputTextPart
  | ResponsesInputImagePart

export interface ResponsesMessageItem {
  type: "message"
  role: "user" | "assistant" | "system" | "developer"
  content: Array<ResponsesContentPart>
}

export interface ResponsesFunctionCallItem {
  type: "function_call"
  call_id: string
  name: string
  arguments: string
  id?: string
}

export interface ResponsesFunctionCallOutputItem {
  type: "function_call_output"
  call_id: string
  output: string
}

export interface ResponsesLocalShellAction {
  type?: "exec"
  command: Array<string>
  workdir?: string
  env?: Record<string, string>
  timeout_ms?: number
}

export interface ResponsesLocalShellCallItem {
  type: "local_shell_call"
  call_id: string
  action: ResponsesLocalShellAction
  id?: string
  status?: string
}

export interface ResponsesLocalShellCallOutputItem {
  type: "local_shell_call_output"
  call_id: string
  output: string
}

export interface ResponsesCustomToolCallItem {
  type: "custom_tool_call"
  call_id: string
  name: string
  input: string
  id?: string
}

export interface ResponsesCustomToolCallOutputItem {
  type: "custom_tool_call_output"
  call_id: string
  output: string
}

export interface ResponsesReasoningItem {
  type: "reasoning"
  // shape intentionally loose — we drop these
  [key: string]: unknown
}

export type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem
  | ResponsesLocalShellCallItem
  | ResponsesLocalShellCallOutputItem
  | ResponsesCustomToolCallItem
  | ResponsesCustomToolCallOutputItem
  | ResponsesReasoningItem
  | { type: string; [key: string]: unknown }

export interface ResponsesFunctionTool {
  type: "function"
  name: string
  description?: string
  parameters?: Record<string, unknown>
  strict?: boolean
}

export interface ResponsesLocalShellTool {
  type: "local_shell"
}

export interface ResponsesCustomTool {
  type: "custom"
  name: string
  description?: string
}

export interface ResponsesWebSearchTool {
  type: "web_search" | "web_search_preview"
}

export type ResponsesTool =
  | ResponsesFunctionTool
  | ResponsesLocalShellTool
  | ResponsesCustomTool
  | ResponsesWebSearchTool
  | { type: string; [key: string]: unknown }

export type ResponsesAllowedToolEntry =
  | "local_shell"
  | { type: "function" | "custom" | "local_shell"; name?: string }

export type ResponsesToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; name: string }
  | { type: "custom"; name: string }
  | {
      type: "allowed_tools"
      tools: Array<ResponsesAllowedToolEntry>
      mode?: "auto" | "required"
    }

export interface ResponsesReasoning {
  effort?: "minimal" | "low" | "medium" | "high"
  summary?: string
}

export interface ResponsesRequest {
  model: string
  instructions?: string
  input: Array<ResponsesInputItem>
  tools?: Array<ResponsesTool>
  tool_choice?: ResponsesToolChoice
  parallel_tool_calls?: boolean
  reasoning?: ResponsesReasoning
  max_output_tokens?: number
  temperature?: number
  top_p?: number
  metadata?: Record<string, string> & { user_id?: string }
  stream?: boolean

  // Continuation/storage features we don't support — rejected explicitly.
  previous_response_id?: string
  store?: boolean
  background?: boolean

  // Pass-through fields that may appear from Codex but we don't translate.
  [key: string]: unknown
}

// Outgoing Responses SSE events (the minimum set Codex's process_sse parses).

export interface ResponsesOutputMessageItem {
  type: "message"
  id: string
  role: "assistant"
  status: "in_progress" | "completed" | "incomplete"
  content: Array<{ type: "output_text"; text: string; annotations: [] }>
}

export interface ResponsesOutputFunctionCall {
  type: "function_call"
  id: string
  call_id: string
  name: string
  arguments: string
  status?: "in_progress" | "completed" | "incomplete"
}

export interface ResponsesOutputLocalShellCall {
  type: "local_shell_call"
  id: string
  call_id: string
  action: ResponsesLocalShellAction
  status?: "in_progress" | "completed" | "incomplete"
}

export interface ResponsesOutputCustomToolCall {
  type: "custom_tool_call"
  id: string
  call_id: string
  name: string
  input: string
  status?: "in_progress" | "completed" | "incomplete"
}

export type ResponsesOutputItem =
  | ResponsesOutputMessageItem
  | ResponsesOutputFunctionCall
  | ResponsesOutputLocalShellCall
  | ResponsesOutputCustomToolCall

export interface ResponsesUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  input_tokens_details?: { cached_tokens?: number }
}

export type ResponsesIncompleteReason =
  | "max_output_tokens"
  | "content_filter"
  | "unknown"

export interface ResponsesIncompleteDetails {
  reason: ResponsesIncompleteReason
  upstream_reason?: string
}

export interface ResponsesEnvelope {
  id: string
  object: "response"
  created_at: number
  status: "in_progress" | "completed" | "incomplete" | "failed"
  model: string
  output: Array<ResponsesOutputItem>
  usage?: ResponsesUsage
  incomplete_details?: ResponsesIncompleteDetails
  error?: { code: string; message: string } | null
  metadata?: Record<string, string>
}

// SSE event variants we emit.

export interface ResponseCreatedEvent {
  type: "response.created"
  response: ResponsesEnvelope
}

export interface ResponseInProgressEvent {
  type: "response.in_progress"
  response: ResponsesEnvelope
}

export interface ResponseOutputItemAddedEvent {
  type: "response.output_item.added"
  output_index: number
  item: ResponsesOutputItem
}

export interface ResponseOutputItemDoneEvent {
  type: "response.output_item.done"
  output_index: number
  item: ResponsesOutputItem
}

export interface ResponseOutputTextDeltaEvent {
  type: "response.output_text.delta"
  item_id: string
  output_index: number
  content_index: number
  delta: string
}

export interface ResponseOutputTextDoneEvent {
  type: "response.output_text.done"
  item_id: string
  output_index: number
  content_index: number
  text: string
}

export interface ResponseFunctionCallArgsDeltaEvent {
  type: "response.function_call_arguments.delta"
  item_id: string
  output_index: number
  delta: string
}

export interface ResponseFunctionCallArgsDoneEvent {
  type: "response.function_call_arguments.done"
  item_id: string
  output_index: number
  arguments: string
}

export interface ResponseCompletedEvent {
  type: "response.completed"
  response: ResponsesEnvelope
}

export interface ResponseFailedEvent {
  type: "response.failed"
  response: ResponsesEnvelope
}

export type ResponsesStreamEvent =
  | ResponseCreatedEvent
  | ResponseInProgressEvent
  | ResponseOutputItemAddedEvent
  | ResponseOutputItemDoneEvent
  | ResponseOutputTextDeltaEvent
  | ResponseOutputTextDoneEvent
  | ResponseFunctionCallArgsDeltaEvent
  | ResponseFunctionCallArgsDoneEvent
  | ResponseCompletedEvent
  | ResponseFailedEvent
