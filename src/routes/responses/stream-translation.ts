import { randomBytes } from "node:crypto"

import {
  createStreamAccumulator,
  foldChunk,
  type ChunkDelta,
  type StreamAccumulator,
} from "~/routes/_shared/stream-accumulator"
import {
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import {
  type SyntheticFamily,
  type SyntheticToolMap,
} from "./request-translation"
import {
  type ResponsesEnvelope,
  type ResponsesIncompleteDetails,
  type ResponsesIncompleteReason,
  type ResponsesLocalShellAction,
  type ResponsesOutputCustomToolCall,
  type ResponsesOutputFunctionCall,
  type ResponsesOutputItem,
  type ResponsesOutputLocalShellCall,
  type ResponsesOutputMessageItem,
  type ResponsesStreamEvent,
  type ResponsesUsage,
} from "./responses-types"

// ----- State + context -----------------------------------------------------

interface ToolCallAccumulator {
  outputIndex: number
  itemId: string
  callId: string
  name: string
  argumentsBuffer: string
  emittedAdded: boolean
  done: boolean
}

interface MessageAccumulator {
  outputIndex: number
  itemId: string
  textBuffer: string
  emittedAdded: boolean
  done: boolean
}

export interface ResponsesStreamState {
  responseCreatedSent: boolean
  nextOutputIndex: number
  message?: MessageAccumulator
  /** Keyed by upstream tool_call index. */
  toolCalls: Map<number, ToolCallAccumulator>
  /** Set once finish_reason or [DONE] has been processed. */
  finalized: boolean
  /** Captured usage from the terminal chunk, if any. */
  usage?: ResponsesUsage
  /** Captured finish_reason. */
  finishReason: ChatCompletionChunk["choices"][number]["finish_reason"] | null
  /** Neutral cross-format accumulation (text + index-aligned tool calls). */
  accumulator: StreamAccumulator
}

export interface ResponsesStreamContext {
  responseId: string
  model: string
  createdAt: number
  syntheticToolMap: SyntheticToolMap
}

export function createInitialStreamState(): ResponsesStreamState {
  return {
    responseCreatedSent: false,
    nextOutputIndex: 0,
    toolCalls: new Map(),
    finalized: false,
    finishReason: null,
    accumulator: createStreamAccumulator(),
  }
}

// ----- ID helpers ----------------------------------------------------------

const ID_PREFIXES = {
  message: "msg",
  function_call: "fc",
  local_shell_call: "lsc",
  custom_tool_call: "ctc",
} as const

function makeId(
  prefix: keyof typeof ID_PREFIXES,
  randomFn: () => string = defaultRandom,
): string {
  return `${ID_PREFIXES[prefix]}_${randomFn()}`
}

function defaultRandom(): string {
  return randomBytes(12).toString("hex")
}

function pickFamily(
  family: SyntheticFamily | undefined,
): keyof typeof ID_PREFIXES {
  if (family === "local_shell") return "local_shell_call"
  if (family === "custom") return "custom_tool_call"
  return "function_call"
}

// ----- Per-chunk translation ----------------------------------------------

export function translateChunkToResponsesEvents(
  chunk: ChatCompletionChunk,
  state: ResponsesStreamState,
  ctx: ResponsesStreamContext,
): Array<ResponsesStreamEvent> {
  const events: Array<ResponsesStreamEvent> = []

  if (!state.responseCreatedSent) {
    const initial = buildEnvelope({
      ctx,
      status: "in_progress",
      output: [],
      usage: undefined,
    })
    events.push(
      { type: "response.created", response: initial },
      { type: "response.in_progress", response: initial },
    )
    state.responseCreatedSent = true
  }

  // Fold into the neutral accumulator; render Responses events from the delta.
  const folded = foldChunk(state.accumulator, chunk)

  if (chunk.usage) {
    state.usage = {
      input_tokens: chunk.usage.prompt_tokens,
      output_tokens: chunk.usage.completion_tokens,
      total_tokens: chunk.usage.total_tokens,
      ...(chunk.usage.prompt_tokens_details && {
        input_tokens_details: {
          cached_tokens: chunk.usage.prompt_tokens_details.cached_tokens,
        },
      }),
    }
  }

  if (chunk.choices.length === 0) {
    return events
  }
  const choice = chunk.choices[0]

  if (folded.textDelta !== undefined) {
    events.push(...renderTextDelta(folded.textDelta, state))
  }
  events.push(...renderToolCalls(folded, state, ctx))

  // ----- Finalization ------------------------------------------------------
  if (choice.finish_reason && !state.finalized) {
    state.finalized = true
    state.finishReason = choice.finish_reason
    events.push(...finalizeStream(state, ctx))
  }

  return events
}

// Render the message output item + a text delta from a folded text fragment.
function renderTextDelta(
  textDelta: string,
  state: ResponsesStreamState,
): Array<ResponsesStreamEvent> {
  const events: Array<ResponsesStreamEvent> = []
  if (!state.message) {
    const itemId = makeId("message")
    state.message = {
      outputIndex: state.nextOutputIndex,
      itemId,
      textBuffer: "",
      emittedAdded: false,
      done: false,
    }
    state.nextOutputIndex++
  }
  if (!state.message.emittedAdded) {
    events.push({
      type: "response.output_item.added",
      output_index: state.message.outputIndex,
      item: buildMessageItem(state.message.itemId, "", "in_progress"),
    })
    state.message.emittedAdded = true
  }
  state.message.textBuffer += textDelta
  events.push({
    type: "response.output_text.delta",
    item_id: state.message.itemId,
    output_index: state.message.outputIndex,
    content_index: 0,
    delta: textDelta,
  })
  return events
}

// Register Responses render-accumulators for newly started tool calls (index
// alignment + arg buffering already done by foldChunk) and emit
// output_item.added on first sighting + function_call_arguments.delta events.
function renderToolCalls(
  folded: ChunkDelta,
  state: ResponsesStreamState,
  ctx: ResponsesStreamContext,
): Array<ResponsesStreamEvent> {
  const events: Array<ResponsesStreamEvent> = []

  // Starts emit output_item.added on first sighting (in upstream tool order).
  for (const started of folded.toolStarts) {
    const name = started.name ?? ""
    const synthetic = ctx.syntheticToolMap.get(name)
    const family = pickFamily(synthetic?.family)
    const acc: ToolCallAccumulator = {
      outputIndex: state.nextOutputIndex,
      itemId: makeId(family),
      callId: started.id ?? "",
      name,
      argumentsBuffer: "",
      emittedAdded: false,
      done: false,
    }
    state.nextOutputIndex++
    state.toolCalls.set(started.index, acc)

    const item = buildPlaceholderToolItem(acc, ctx)
    if (item) {
      events.push({
        type: "response.output_item.added",
        output_index: acc.outputIndex,
        item,
      })
      acc.emittedAdded = true
    }
  }

  for (const { index, delta: argDelta } of folded.toolArgDeltas) {
    const acc = state.toolCalls.get(index)
    if (!acc) continue

    // Retry the added emission for a placeholder that was undefined at start
    // (e.g. an undeclared __cp_* name); arguments still flow regardless.
    if (!acc.emittedAdded) {
      const item = buildPlaceholderToolItem(acc, ctx)
      if (item) {
        events.push({
          type: "response.output_item.added",
          output_index: acc.outputIndex,
          item,
        })
        acc.emittedAdded = true
      }
    }

    acc.argumentsBuffer += argDelta
    events.push({
      type: "response.function_call_arguments.delta",
      item_id: acc.itemId,
      output_index: acc.outputIndex,
      delta: argDelta,
    })
  }

  return events
}

// ----- Finalization (transport-cut handling) ------------------------------

interface FinalizationOptions {
  /** True if upstream closed without a `finish_reason` (transport cut). */
  transportCut?: boolean
}

// eslint-disable-next-line max-lines-per-function
export function finalizeStream(
  state: ResponsesStreamState,
  ctx: ResponsesStreamContext,
  options: FinalizationOptions = {},
): Array<ResponsesStreamEvent> {
  const events: Array<ResponsesStreamEvent> = []

  // Build candidate items in output_index order.
  const items: Array<{
    outputIndex: number
    item: ResponsesOutputItem
    failed?: { code: string; message: string }
    /** True when the failed item originated from a __cp_* synthetic family. */
    failedSynthetic?: boolean
  }> = []

  if (state.message) {
    const status: ResponsesOutputMessageItem["status"] =
      options.transportCut ? "incomplete" : "completed"
    items.push({
      outputIndex: state.message.outputIndex,
      item: buildMessageItem(
        state.message.itemId,
        state.message.textBuffer,
        status,
      ),
    })
  }

  for (const acc of state.toolCalls.values()) {
    const validation = validateToolCall(acc, ctx)
    if (validation.failed) {
      items.push({
        outputIndex: acc.outputIndex,
        item: buildFunctionCallItem(acc, "incomplete"),
        failed: validation.failed,
        failedSynthetic: validation.failedSynthetic,
      })
    } else {
      items.push({
        outputIndex: acc.outputIndex,
        item: validation.item,
      })
    }
  }

  items.sort((a, b) => a.outputIndex - b.outputIndex)

  // Transport-cut + any malformed synthetic → emit only response.failed,
  // flush nothing. Codex acts on output_item.done; partial flush could
  // execute a privileged call alongside a malformed sibling.
  if (options.transportCut) {
    const anyMalformedSynthetic = items.some(
      (i) => i.failed && i.failedSynthetic,
    )
    if (anyMalformedSynthetic) {
      events.push({
        type: "response.failed",
        response: buildEnvelope({
          ctx,
          status: "failed",
          output: [],
          usage: state.usage,
          error: {
            code: "stream_interrupted_malformed_tool_arguments",
            message:
              "Upstream stream ended mid-turn with malformed synthetic tool arguments.",
          },
        }),
      })
      return events
    }
    // Otherwise: flush valid items then complete as incomplete.
    for (const { outputIndex, item } of items) {
      events.push({
        type: "response.output_item.done",
        output_index: outputIndex,
        item,
      })
    }
    events.push({
      type: "response.completed",
      response: buildEnvelope({
        ctx,
        status: "incomplete",
        output: items.map((i) => i.item),
        usage: state.usage,
        incompleteDetails: {
          reason: "unknown",
          upstream_reason: "stream_interrupted",
        },
      }),
    })
    return events
  }

  // Normal path: per-item failure handling differs by family.
  let aborted: { code: string; message: string } | undefined
  for (const entry of items) {
    if (entry.failed) {
      if (entry.failedSynthetic) {
        // Don't echo the __cp_* name back; abort the whole turn.
        aborted = entry.failed
        break
      }
      // Plain function call with malformed args: pass raw string through.
      events.push({
        type: "response.output_item.done",
        output_index: entry.outputIndex,
        item: entry.item,
      })
      continue
    }
    events.push({
      type: "response.output_item.done",
      output_index: entry.outputIndex,
      item: entry.item,
    })
  }

  if (aborted) {
    events.push({
      type: "response.failed",
      response: buildEnvelope({
        ctx,
        status: "failed",
        output: [],
        usage: state.usage,
        error: aborted,
      }),
    })
    return events
  }

  // Build the terminal envelope.
  const { status, incompleteDetails } = mapFinishReason(state.finishReason)
  events.push({
    type: "response.completed",
    response: buildEnvelope({
      ctx,
      status,
      output: items.map((i) => i.item),
      usage: state.usage,
      incompleteDetails,
    }),
  })
  return events
}

// ----- finish_reason mapping ----------------------------------------------

function mapFinishReason(
  finishReason: ChatCompletionChunk["choices"][number]["finish_reason"] | null,
): {
  status: "completed" | "incomplete"
  incompleteDetails?: ResponsesIncompleteDetails
} {
  switch (finishReason) {
    case "stop":
    case "tool_calls":
    case null: {
      return { status: "completed" }
    }
    case "length": {
      return {
        status: "incomplete",
        incompleteDetails: { reason: "max_output_tokens" },
      }
    }
    case "content_filter": {
      return {
        status: "incomplete",
        incompleteDetails: { reason: "content_filter" },
      }
    }
    default: {
      const reason: ResponsesIncompleteReason = "unknown"
      return {
        status: "incomplete",
        incompleteDetails: { reason, upstream_reason: String(finishReason) },
      }
    }
  }
}

// ----- Item builders ------------------------------------------------------

function buildMessageItem(
  itemId: string,
  text: string,
  status: ResponsesOutputMessageItem["status"],
): ResponsesOutputMessageItem {
  return {
    type: "message",
    id: itemId,
    role: "assistant",
    status,
    content: [{ type: "output_text", text, annotations: [] }],
  }
}

function buildFunctionCallItem(
  acc: ToolCallAccumulator,
  status: "in_progress" | "completed" | "incomplete",
): ResponsesOutputFunctionCall {
  return {
    type: "function_call",
    id: acc.itemId,
    call_id: acc.callId,
    name: acc.name,
    arguments: acc.argumentsBuffer,
    status,
  }
}

function buildPlaceholderToolItem(
  acc: ToolCallAccumulator,
  ctx: ResponsesStreamContext,
): ResponsesOutputItem | undefined {
  const synthetic = ctx.syntheticToolMap.get(acc.name)
  if (!synthetic) {
    if (acc.name.startsWith("__cp_")) return undefined
    return buildFunctionCallItem(acc, "in_progress")
  }
  if (synthetic.family === "local_shell") {
    const placeholder: ResponsesOutputLocalShellCall = {
      type: "local_shell_call",
      id: acc.itemId,
      call_id: acc.callId,
      action: { type: "exec", command: [] },
      status: "in_progress",
    }
    return placeholder
  }
  const placeholder: ResponsesOutputCustomToolCall = {
    type: "custom_tool_call",
    id: acc.itemId,
    call_id: acc.callId,
    name: synthetic.originalName ?? acc.name,
    input: "",
    status: "in_progress",
  }
  return placeholder
}

interface ValidationResult {
  item: ResponsesOutputItem
  failed?: { code: string; message: string }
  /** True when the failed item came from a synthetic / __cp_* family. */
  failedSynthetic?: boolean
}

function validateToolCall(
  acc: ToolCallAccumulator,
  ctx: ResponsesStreamContext,
): ValidationResult {
  const synthetic = ctx.syntheticToolMap.get(acc.name)

  if (!synthetic) {
    if (acc.name.startsWith("__cp_")) {
      // Upstream hallucinated a __cp_* name we never declared.
      return {
        item: buildFunctionCallItem(acc, "incomplete"),
        failedSynthetic: true,
        failed: {
          code: "undeclared_synthetic_tool",
          message: `Upstream emitted a call to undeclared synthetic tool "${acc.name}".`,
        },
      }
    }
    // Plain function call. Don't validate arguments shape; pass through.
    return { item: buildFunctionCallItem(acc, "completed") }
  }

  // Synthetic family: must parse + validate shape.
  let parsed: unknown
  try {
    parsed = JSON.parse(acc.argumentsBuffer)
  } catch {
    return {
      item: buildFunctionCallItem(acc, "incomplete"),
      failedSynthetic: true,
      failed: {
        code: "upstream_malformed_tool_arguments",
        message: `Upstream tool call for "${acc.name}" had unparseable JSON arguments.`,
      },
    }
  }

  if (synthetic.family === "local_shell") {
    if (!isLocalShellAction(parsed)) {
      return {
        item: buildFunctionCallItem(acc, "incomplete"),
        failedSynthetic: true,
        failed: {
          code: "upstream_malformed_tool_arguments",
          message: `Upstream tool call for "${acc.name}" did not match LocalShellAction shape.`,
        },
      }
    }
    const item: ResponsesOutputLocalShellCall = {
      type: "local_shell_call",
      id: acc.itemId,
      call_id: acc.callId,
      action: parsed,
      status: "completed",
    }
    return { item }
  }

  // custom: shape is { input: string }.
  if (
    typeof parsed !== "object"
    || parsed === null
    || typeof (parsed as { input?: unknown }).input !== "string"
  ) {
    return {
      item: buildFunctionCallItem(acc, "incomplete"),
      failedSynthetic: true,
      failed: {
        code: "upstream_malformed_tool_arguments",
        message: `Upstream tool call for "${acc.name}" did not match {input: string} shape.`,
      },
    }
  }
  const item: ResponsesOutputCustomToolCall = {
    type: "custom_tool_call",
    id: acc.itemId,
    call_id: acc.callId,
    name: synthetic.originalName ?? acc.name,
    input: (parsed as { input: string }).input,
    status: "completed",
  }
  return { item }
}

function isLocalShellAction(
  value: unknown,
): value is ResponsesLocalShellAction {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.command)) return false
  if (!v.command.every((c) => typeof c === "string")) return false
  if (v.workdir !== undefined && typeof v.workdir !== "string") return false
  if (v.timeout_ms !== undefined && typeof v.timeout_ms !== "number") {
    return false
  }
  if (v.env !== undefined) {
    if (typeof v.env !== "object" || v.env === null) return false
    for (const val of Object.values(v.env as Record<string, unknown>)) {
      if (typeof val !== "string") return false
    }
  }
  return true
}

// ----- Envelope builder ---------------------------------------------------

interface BuildEnvelopeOptions {
  ctx: ResponsesStreamContext
  status: "in_progress" | "completed" | "incomplete" | "failed"
  output: Array<ResponsesOutputItem>
  usage: ResponsesUsage | undefined
  error?: { code: string; message: string }
  incompleteDetails?: ResponsesIncompleteDetails
}

function buildEnvelope(opts: BuildEnvelopeOptions): ResponsesEnvelope {
  const { ctx, status, output, usage, error, incompleteDetails } = opts
  return {
    id: ctx.responseId,
    object: "response",
    created_at: ctx.createdAt,
    status,
    model: ctx.model,
    output,
    ...(usage && { usage }),
    ...(incompleteDetails && { incomplete_details: incompleteDetails }),
    ...(error && { error }),
  }
}

// ----- Post-`response.created` error helper -------------------------------

export function translateStreamErrorToResponsesEvent(
  err: unknown,
  ctx: ResponsesStreamContext,
): ResponsesStreamEvent {
  const message =
    err instanceof Error ? err.message : "An unexpected error occurred."
  return {
    type: "response.failed",
    response: buildEnvelope({
      ctx,
      status: "failed",
      output: [],
      usage: undefined,
      error: { code: "stream_interrupted", message },
    }),
  }
}

// ----- Non-streaming envelope synthesis -----------------------------------

// eslint-disable-next-line max-lines-per-function
export function translateNonStreamingResponse(
  response: ChatCompletionResponse,
  ctx: ResponsesStreamContext,
): ResponsesEnvelope {
  // We feed the non-streaming response through the same accumulator logic
  // by synthesizing a single chunk + a terminal chunk — keeps validation /
  // raise / failed-on-malformed semantics identical to the streaming path.
  const choice = response.choices[0]
  const synthChunks: Array<ChatCompletionChunk> = []
  if (choice.message.content) {
    synthChunks.push({
      id: response.id,
      object: "chat.completion.chunk",
      created: response.created,
      model: response.model,
      choices: [
        {
          index: 0,
          delta: { content: choice.message.content },
          finish_reason: null,
          logprobs: null,
        },
      ],
    })
  }
  if (choice.message.tool_calls) {
    for (let i = 0; i < choice.message.tool_calls.length; i++) {
      const tc = choice.message.tool_calls[i]
      synthChunks.push(
        {
          id: response.id,
          object: "chat.completion.chunk",
          created: response.created,
          model: response.model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: i,
                    id: tc.id,
                    type: "function",
                    function: { name: tc.function.name, arguments: "" },
                  },
                ],
              },
              finish_reason: null,
              logprobs: null,
            },
          ],
        },
        {
          id: response.id,
          object: "chat.completion.chunk",
          created: response.created,
          model: response.model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: i, function: { arguments: tc.function.arguments } },
                ],
              },
              finish_reason: null,
              logprobs: null,
            },
          ],
        },
      )
    }
  }
  synthChunks.push({
    id: response.id,
    object: "chat.completion.chunk",
    created: response.created,
    model: response.model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: choice.finish_reason,
        logprobs: null,
      },
    ],
    ...(response.usage && { usage: { ...response.usage } }),
  })

  const state = createInitialStreamState()
  // An assistant turn whose content is exactly "" is a legitimate empty text
  // item. The streaming text path intentionally ignores zero-length deltas (to
  // skip empty leading chunks), so seed the message item directly here rather
  // than relax that gate — keeps the non-streaming output_item.added/done pair.
  if (choice.message.content === "") {
    state.message = {
      outputIndex: state.nextOutputIndex,
      itemId: makeId("message"),
      textBuffer: "",
      emittedAdded: true,
      done: false,
    }
    state.nextOutputIndex++
  }
  const events: Array<ResponsesStreamEvent> = []
  for (const c of synthChunks) {
    events.push(...translateChunkToResponsesEvents(c, state, ctx))
  }

  // The terminal envelope is the response.completed (or response.failed).
  const terminal = events.find(
    (e) => e.type === "response.completed" || e.type === "response.failed",
  )
  if (terminal) {
    return terminal.response
  }
  return buildEnvelope({
    ctx,
    status: "completed",
    output: [],
    usage: state.usage,
  })
}
