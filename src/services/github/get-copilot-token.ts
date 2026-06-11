import { GITHUB_API_BASE_URL, githubHeaders } from "~/lib/api-config"
import { requestJson } from "~/lib/request"
import { state as defaultState, type State } from "~/lib/state"

export const getCopilotToken = (state: State = defaultState) =>
  requestJson<GetCopilotTokenResponse>(
    `${GITHUB_API_BASE_URL}/copilot_internal/v2/token`,
    { headers: githubHeaders(state) },
    "Failed to get Copilot token",
  )

// Trimmed for the sake of simplicity
interface GetCopilotTokenResponse {
  expires_at: number
  refresh_in: number
  token: string
}
