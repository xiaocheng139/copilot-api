import {
  type ChatCompletionsPayload,
  type ContentPart,
  type Message,
  type Tool,
  type ToolCall,
} from "~/services/copilot/create-chat-completions"

import { detectKeywordBudget } from "../messages/non-stream-translation"
import {
  type ResponsesAllowedToolEntry,
  type ResponsesContentPart,
  type ResponsesCustomToolCallItem,
  type ResponsesFunctionCallItem,
  type ResponsesInputItem,
  type ResponsesLocalShellCallItem,
  type ResponsesMessageItem,
  type ResponsesRequest,
  type ResponsesTool,
  type ResponsesToolChoice,
} from "./responses-types"

// ----- Errors --------------------------------------------------------------

export type ResponsesValidationCode =
  | "unsupported_responses_field"
  | "reserved_tool_name"
  | "unknown_tool_in_choice"
  | "empty_allowed_tools"
  | "unsupported_tool_in_choice"

export class ResponsesValidationError extends Error {
  code: ResponsesValidationCode
  status: number

  constructor(
    code: ResponsesValidationCode,
    message: string,
    status: number = 400,
  ) {
    super(message)
    this.code = code
    this.status = status
  }
}

// ----- Synthetic tool registry --------------------------------------------

export const RESERVED_TOOL_PREFIX = "__cp_"
export const LOCAL_SHELL_TOOL = "__cp_local_shell"

export type SyntheticFamily = "local_shell" | "custom"

export interface SyntheticToolEntry {
  family: SyntheticFamily
  /** Original Codex `custom` tool name; undefined for local_shell. */
  originalName?: string
}

export type SyntheticToolMap = Map<string, SyntheticToolEntry>

const LOCAL_SHELL_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["exec"] },
    command: { type: "array", items: { type: "string" } },
    workdir: { type: "string" },
    env: { type: "object", additionalProperties: { type: "string" } },
    timeout_ms: { type: "integer" },
  },
  required: ["command"],
  additionalProperties: false,
}

const CUSTOM_TOOL_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    input: { type: "string" },
  },
  required: ["input"],
  additionalProperties: false,
}

// ----- Reasoning effort anchors -------------------------------------------

const REASONING_ANCHORS: Record<
  NonNullable<ResponsesRequest["reasoning"]>["effort"] & string,
  number | undefined
> = {
  minimal: undefined,
  low: 4000,
  medium: 10000,
  high: 31999,
}

function resolveThinkingBudget(
  requested: number | undefined,
  maxTokens: number | undefined,
): number | undefined {
  if (requested === undefined || requested <= 0) return undefined
  if (maxTokens === undefined) return requested
  const ceiling = Math.max(1, maxTokens - 1)
  return Math.min(requested, ceiling)
}

// ----- Public entry point --------------------------------------------------

export interface RequestTranslationResult {
  payload: ChatCompletionsPayload
  syntheticToolMap: SyntheticToolMap
}

export function translateResponsesToOpenAI(
  req: ResponsesRequest,
): RequestTranslationResult {
  // 1. Reject unsupported continuation/storage features.
  if (req.previous_response_id !== undefined) {
    throw new ResponsesValidationError(
      "unsupported_responses_field",
      "previous_response_id is not supported by this proxy.",
    )
  }
  if (req.store === true) {
    throw new ResponsesValidationError(
      "unsupported_responses_field",
      "store: true is not supported by this proxy.",
    )
  }
  if (req.background === true) {
    throw new ResponsesValidationError(
      "unsupported_responses_field",
      "background: true is not supported by this proxy.",
    )
  }

  // 2. Validate reserved tool names in declared tools and historical input.
  validateReservedToolNames(req.tools, req.input)

  // 3. Lower tools.
  const { lowered: loweredTools, syntheticToolMap } = lowerTools(req.tools)

  // 4. Translate input + instructions into messages[].
  const messages = buildMessages(req.input, req.instructions, syntheticToolMap)

  // 5. Reasoning effort + keyword floor → thinking_budget (Claude only).
  const isClaude = req.model.startsWith("claude-")
  const effortBudget =
    isClaude && req.reasoning?.effort !== undefined ?
      REASONING_ANCHORS[req.reasoning.effort]
    : undefined

  let thinkingBudget: number | undefined
  if (isClaude) {
    const keywordBudget = detectKeywordBudget(messages)
    const requested =
      keywordBudget !== undefined && effortBudget !== undefined ?
        Math.max(keywordBudget, effortBudget)
      : (keywordBudget ?? effortBudget)
    thinkingBudget = resolveThinkingBudget(requested, req.max_output_tokens)
  }
  const thinkingOn = thinkingBudget !== undefined

  // 6. Translate tool_choice (uses syntheticToolMap to resolve allowed_tools).
  const toolChoice = translateToolChoice(
    req.tool_choice,
    req.tools,
    syntheticToolMap,
  )

  const payload: ChatCompletionsPayload = {
    model: req.model,
    messages,
    max_tokens: req.max_output_tokens,
    stream: req.stream,
    temperature: thinkingOn ? undefined : req.temperature,
    top_p: thinkingOn ? undefined : req.top_p,
    user: req.metadata?.user_id,
    tools: loweredTools,
    tool_choice: toolChoice,
    ...(thinkingOn && { thinking_budget: thinkingBudget }),
  }

  return { payload, syntheticToolMap }
}

// ----- Reserved name validation -------------------------------------------

function validateReservedToolNames(
  tools: Array<ResponsesTool> | undefined,
  input: Array<ResponsesInputItem>,
): void {
  if (tools) {
    for (const tool of tools) {
      if (tool.type !== "function" && tool.type !== "custom") continue
      const name = getName(tool)
      if (name?.startsWith(RESERVED_TOOL_PREFIX)) {
        throw new ResponsesValidationError(
          "reserved_tool_name",
          `Tool name "${name}" uses the reserved "${RESERVED_TOOL_PREFIX}" prefix.`,
        )
      }
    }
  }
  for (const item of input) {
    if (item.type !== "function_call") continue
    const name = getName(item)
    if (name?.startsWith(RESERVED_TOOL_PREFIX)) {
      throw new ResponsesValidationError(
        "reserved_tool_name",
        `History contains function_call with reserved name "${name}".`,
      )
    }
  }
}

function getName(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const name = (value as { name?: unknown }).name
  return typeof name === "string" ? name : undefined
}

// ----- Tool lowering -------------------------------------------------------

interface LoweredToolsResult {
  lowered: Array<Tool> | undefined
  syntheticToolMap: SyntheticToolMap
}

function lowerTools(
  tools: Array<ResponsesTool> | undefined,
): LoweredToolsResult {
  const syntheticToolMap: SyntheticToolMap = new Map()
  if (!tools || tools.length === 0) {
    return { lowered: undefined, syntheticToolMap }
  }

  const lowered: Array<Tool> = []
  let customCounter = 0

  for (const tool of tools) {
    switch (tool.type) {
      case "function": {
        const fn = tool as Extract<ResponsesTool, { type: "function" }>
        const entry: Tool = {
          type: "function",
          function: {
            name: fn.name,
            description: fn.description,
            parameters: fn.parameters ?? {
              type: "object",
              properties: {},
            },
          },
        }
        lowered.push(entry)
        break
      }
      case "local_shell": {
        if (!syntheticToolMap.has(LOCAL_SHELL_TOOL)) {
          syntheticToolMap.set(LOCAL_SHELL_TOOL, { family: "local_shell" })
          lowered.push({
            type: "function",
            function: {
              name: LOCAL_SHELL_TOOL,
              description: "Execute a local shell command.",
              parameters: LOCAL_SHELL_PARAMETERS,
            },
          })
        }
        break
      }
      case "custom": {
        const ct = tool as Extract<ResponsesTool, { type: "custom" }>
        const syntheticName = `__cp_custom_${customCounter}`
        customCounter++
        syntheticToolMap.set(syntheticName, {
          family: "custom",
          originalName: ct.name,
        })
        lowered.push({
          type: "function",
          function: {
            name: syntheticName,
            description: ct.description ?? `Custom tool ${ct.name}`,
            parameters: CUSTOM_TOOL_PARAMETERS,
          },
        })
        break
      }
      case "web_search":
      case "web_search_preview": {
        // Unsupported — drop with a verbose log; let the model recover.
        // (verbose log handled at handler entry)
        break
      }
      default: {
        // Unknown tool type — drop.
        break
      }
    }
  }

  return {
    lowered: lowered.length > 0 ? lowered : undefined,
    syntheticToolMap,
  }
}

// ----- tool_choice translation --------------------------------------------

function translateToolChoice(
  choice: ResponsesToolChoice | undefined,
  tools: Array<ResponsesTool> | undefined,
  syntheticToolMap: SyntheticToolMap,
): ChatCompletionsPayload["tool_choice"] {
  if (choice === undefined) return undefined

  if (typeof choice === "string") {
    return choice
  }

  if (choice.type === "function" || choice.type === "custom") {
    const target =
      choice.type === "function" ?
        choice.name
      : findSyntheticForCustomName(syntheticToolMap, choice.name)
    if (!target) {
      throw new ResponsesValidationError(
        "unknown_tool_in_choice",
        `tool_choice references unknown tool "${choice.name}".`,
      )
    }
    return { type: "function", function: { name: target } }
  }

  // choice.type === "allowed_tools"
  const resolved = resolveAllowedTools(choice.tools, tools, syntheticToolMap)
  if (resolved.length === 0) {
    throw new ResponsesValidationError(
      "empty_allowed_tools",
      "tool_choice.allowed_tools resolved to an empty set.",
    )
  }
  // chat/completions has no native allowed_tools mode. If exactly one tool
  // resolves we can pin it; otherwise we forward the requested mode and
  // trust the model — the unmatched tools are still in `tools[]`, which is
  // a known limitation. mode:"required" maps to "required"; "auto" → "auto".
  if (resolved.length === 1) {
    return { type: "function", function: { name: resolved[0] } }
  }
  return choice.mode === "required" ? "required" : "auto"
}

function findSyntheticForCustomName(
  map: SyntheticToolMap,
  originalName: string,
): string | undefined {
  for (const [synthetic, entry] of map.entries()) {
    if (entry.family === "custom" && entry.originalName === originalName) {
      return synthetic
    }
  }
  return undefined
}

// eslint-disable-next-line complexity
function resolveAllowedTools(
  entries: Array<ResponsesAllowedToolEntry>,
  tools: Array<ResponsesTool> | undefined,
  syntheticToolMap: SyntheticToolMap,
): Array<string> {
  const declaredFunctionNames = new Set<string>()
  if (tools) {
    for (const t of tools) {
      if (t.type !== "function") continue
      const name = getName(t)
      if (name) declaredFunctionNames.add(name)
    }
  }

  const out: Array<string> = []
  for (const entry of entries) {
    if (entry === "local_shell") {
      if (!syntheticToolMap.has(LOCAL_SHELL_TOOL)) {
        throw new ResponsesValidationError(
          "unknown_tool_in_choice",
          `tool_choice.allowed_tools references "local_shell" but no local_shell tool was declared.`,
        )
      }
      out.push(LOCAL_SHELL_TOOL)
      continue
    }
    if (typeof entry === "object") {
      const entryType = (entry as { type: string }).type
      const entryName = (entry as { name?: string }).name
      if (entryType === "function") {
        if (!entryName || !declaredFunctionNames.has(entryName)) {
          throw new ResponsesValidationError(
            "unknown_tool_in_choice",
            `tool_choice.allowed_tools references unknown function "${entryName}".`,
          )
        }
        out.push(entryName)
        continue
      }
      if (entryType === "custom") {
        const synth =
          entryName ?
            findSyntheticForCustomName(syntheticToolMap, entryName)
          : undefined
        if (!synth) {
          throw new ResponsesValidationError(
            "unknown_tool_in_choice",
            `tool_choice.allowed_tools references unknown custom tool "${entryName}".`,
          )
        }
        out.push(synth)
        continue
      }
      if (entryType === "local_shell") {
        if (!syntheticToolMap.has(LOCAL_SHELL_TOOL)) {
          throw new ResponsesValidationError(
            "unknown_tool_in_choice",
            `tool_choice.allowed_tools references "local_shell" but no local_shell tool was declared.`,
          )
        }
        out.push(LOCAL_SHELL_TOOL)
        continue
      }
      if (entryType === "web_search" || entryType === "web_search_preview") {
        throw new ResponsesValidationError(
          "unsupported_tool_in_choice",
          `tool_choice.allowed_tools references unsupported tool "web_search".`,
        )
      }
    }
    throw new ResponsesValidationError(
      "unknown_tool_in_choice",
      `tool_choice.allowed_tools entry could not be resolved.`,
    )
  }
  return out
}

// ----- input[] → messages[] -----------------------------------------------

function buildMessages(
  input: Array<ResponsesInputItem>,
  instructions: string | undefined,
  syntheticToolMap: SyntheticToolMap,
): Array<Message> {
  const messages: Array<Message> = []
  if (instructions) {
    messages.push({ role: "system", content: instructions })
  }

  // We coalesce consecutive function-call items into one assistant message
  // with tool_calls[]; `*_output` items become standalone tool messages.
  let pendingToolCalls: Array<ToolCall> = []

  const flushPendingToolCalls = () => {
    if (pendingToolCalls.length === 0) return
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: pendingToolCalls,
    })
    pendingToolCalls = []
  }

  for (const item of input) {
    switch (item.type) {
      case "message": {
        flushPendingToolCalls()
        const msg = item as ResponsesMessageItem
        const content = mapResponsesContent(msg.content)
        const role = msg.role === "developer" ? "system" : msg.role
        messages.push({ role, content })
        break
      }
      case "function_call": {
        const fc = item as ResponsesFunctionCallItem
        pendingToolCalls.push({
          id: fc.call_id,
          type: "function",
          function: { name: fc.name, arguments: fc.arguments },
        })
        break
      }
      case "local_shell_call": {
        // Need a synthetic mapping for raising responses back. If the user
        // didn't declare a local_shell tool but is replaying history with
        // one, register it implicitly so future raise can succeed.
        if (!syntheticToolMap.has(LOCAL_SHELL_TOOL)) {
          syntheticToolMap.set(LOCAL_SHELL_TOOL, { family: "local_shell" })
        }
        const lsc = item as ResponsesLocalShellCallItem
        pendingToolCalls.push({
          id: lsc.call_id,
          type: "function",
          function: {
            name: LOCAL_SHELL_TOOL,
            arguments: JSON.stringify(lsc.action),
          },
        })
        break
      }
      case "custom_tool_call": {
        const ctc = item as ResponsesCustomToolCallItem
        const synth = findSyntheticForCustomName(syntheticToolMap, ctc.name)
        if (!synth) {
          // Fallback: treat as a plain function call so the upstream can see
          // it; downstream raise won't fire (no synthetic id) so it stays a
          // function_call in any echo. This preserves at-least history.
          pendingToolCalls.push({
            id: ctc.call_id,
            type: "function",
            function: {
              name: ctc.name,
              arguments: JSON.stringify({ input: ctc.input }),
            },
          })
          break
        }
        pendingToolCalls.push({
          id: ctc.call_id,
          type: "function",
          function: {
            name: synth,
            arguments: JSON.stringify({ input: ctc.input }),
          },
        })
        break
      }
      case "function_call_output":
      case "local_shell_call_output":
      case "custom_tool_call_output": {
        flushPendingToolCalls()
        const out = item as { call_id: string; output: string }
        messages.push({
          role: "tool",
          tool_call_id: out.call_id,
          content: out.output,
        })
        break
      }
      case "reasoning": {
        // Dropped per spec.
        break
      }
      default: {
        // Unknown — drop with verbose log; logging is at handler entry.
        break
      }
    }
  }
  flushPendingToolCalls()

  return messages
}

function mapResponsesContent(
  content: Array<ResponsesContentPart>,
): string | Array<ContentPart> {
  const hasImage = content.some((p) => p.type === "input_image")
  if (!hasImage) {
    return content
      .filter(
        (p): p is { type: "input_text" | "output_text"; text: string } =>
          p.type === "input_text" || p.type === "output_text",
      )
      .map((p) => p.text)
      .join("\n\n")
  }
  const parts: Array<ContentPart> = []
  for (const p of content) {
    if (p.type === "input_text" || p.type === "output_text") {
      parts.push({ type: "text", text: p.text })
    } else {
      parts.push({
        type: "image_url",
        image_url: { url: p.image_url, detail: p.detail },
      })
    }
  }
  return parts
}
