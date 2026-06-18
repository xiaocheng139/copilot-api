import consola from "consola"
import fs from "node:fs/promises"

import { PATHS } from "~/lib/paths"
import { getCopilotToken } from "~/services/github/get-copilot-token"
import { getDeviceCode } from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"

import { HTTPError } from "./error"
import { state, type State } from "./state"

const readGithubToken = () => fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")

const writeGithubToken = (token: string) =>
  fs.writeFile(PATHS.GITHUB_TOKEN_PATH, token)

/**
 * Tracks an in-flight `refreshCopilotToken` per `State` so concurrent callers
 * share a single GitHub token-endpoint request instead of stampeding it. Keyed
 * on the State object (not a module global) to respect the injected-state seam.
 * A WeakMap lets entries be collected with their State.
 */
const inFlightRefresh = new WeakMap<State, Promise<void>>()

/**
 * Fetch a fresh Copilot token and write it into `state`, WITHOUT installing a
 * refresh timer. This is the in-process recovery primitive shared by the
 * startup/interval refresh (below) and the request-path 401/403 retry in
 * `createChatCompletions`: on the request path we must heal the expired token
 * without leaking a new `setInterval` on every retry.
 *
 * Concurrent calls for the same `state` are de-duped: the first call performs
 * the fetch and every overlapping caller awaits that same promise. This matters
 * for the request-path retry, where a host suspend/resume can make many queued
 * requests 401 at once — without single-flight they would each hit the GitHub
 * token endpoint and amplify the outage / rate limit.
 */
export const refreshCopilotToken = (
  targetState: State = state,
): Promise<void> => {
  const existing = inFlightRefresh.get(targetState)
  if (existing) return existing

  const refresh = (async () => {
    // Bind the target to a const so the post-await assignment is to a member of
    // a non-reassignable reference (satisfies require-atomic-updates, mirrors
    // how the module-global `state` is written in setupCopilotToken).
    const target = targetState
    const { token } = await getCopilotToken(target)
    target.copilotToken = token
    if (target.showToken) {
      consola.info("Refreshed Copilot token:", token)
    }
  })()

  inFlightRefresh.set(targetState, refresh)
  return refresh.finally(() => {
    inFlightRefresh.delete(targetState)
  })
}

export const setupCopilotToken = async () => {
  const { token, refresh_in } = await getCopilotToken()
  state.copilotToken = token

  // Display the Copilot token to the screen
  consola.debug("GitHub Copilot Token fetched successfully!")
  if (state.showToken) {
    consola.info("Copilot token:", token)
  }

  const refreshInterval = (refresh_in - 60) * 1000
  setInterval(async () => {
    consola.debug("Refreshing Copilot token")
    try {
      await refreshCopilotToken()
      consola.debug("Copilot token refreshed")
    } catch (error) {
      consola.error("Failed to refresh Copilot token:", error)
      throw error
    }
  }, refreshInterval)
}

interface SetupGitHubTokenOptions {
  force?: boolean
}

export async function setupGitHubToken(
  options?: SetupGitHubTokenOptions,
): Promise<void> {
  try {
    const githubToken = await readGithubToken()

    if (githubToken && !options?.force) {
      state.githubToken = githubToken
      if (state.showToken) {
        consola.info("GitHub token:", githubToken)
      }
      await logUser()

      return
    }

    consola.info("Not logged in, getting new access token")
    const response = await getDeviceCode()
    consola.debug("Device code response:", response)

    consola.info(
      `Please enter the code "${response.user_code}" in ${response.verification_uri}`,
    )

    const token = await pollAccessToken(response)
    await writeGithubToken(token)
    state.githubToken = token

    if (state.showToken) {
      consola.info("GitHub token:", token)
    }
    await logUser()
  } catch (error) {
    if (error instanceof HTTPError) {
      consola.error("Failed to get GitHub token:", await error.response.json())
      throw error
    }

    consola.error("Failed to get GitHub token:", error)
    throw error
  }
}

async function logUser() {
  const user = await getGitHubUser()
  consola.info(`Logged in as ${user.login}`)
}
