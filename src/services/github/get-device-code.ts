import {
  GITHUB_APP_SCOPES,
  GITHUB_BASE_URL,
  GITHUB_CLIENT_ID,
  standardHeaders,
} from "~/lib/api-config"
import { requestJson } from "~/lib/request"

export function getDeviceCode(): Promise<DeviceCodeResponse> {
  return requestJson<DeviceCodeResponse>(
    `${GITHUB_BASE_URL}/login/device/code`,
    {
      method: "POST",
      headers: standardHeaders(),
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        scope: GITHUB_APP_SCOPES,
      }),
    },
    "Failed to get device code",
  )
}

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}
