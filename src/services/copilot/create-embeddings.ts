import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { requestJson } from "~/lib/request"
import { state } from "~/lib/state"

export const createEmbeddings = (payload: EmbeddingRequest) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  return requestJson<EmbeddingResponse>(
    `${copilotBaseUrl(state)}/embeddings`,
    {
      method: "POST",
      headers: copilotHeaders(state),
      body: JSON.stringify(payload),
    },
    "Failed to create embeddings",
  )
}

export interface EmbeddingRequest {
  input: string | Array<string>
  model: string
}

export interface Embedding {
  object: string
  embedding: Array<number>
  index: number
}

export interface EmbeddingResponse {
  object: string
  data: Array<Embedding>
  model: string
  usage: {
    prompt_tokens: number
    total_tokens: number
  }
}
