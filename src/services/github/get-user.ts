import { GITHUB_API_BASE_URL, standardHeaders } from "~/lib/api-config"
import { requestJson } from "~/lib/request"
import { state } from "~/lib/state"

export function getGitHubUser() {
  return requestJson<GithubUserResponse>(
    `${GITHUB_API_BASE_URL}/user`,
    {
      headers: {
        authorization: `token ${state.githubToken}`,
        ...standardHeaders(),
      },
    },
    "Failed to get GitHub user",
  )
}

// Trimmed for the sake of simplicity
interface GithubUserResponse {
  login: string
}
