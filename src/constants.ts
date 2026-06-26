/** Default Mixlayer OpenAI-compatible inference endpoint. */
export const MIXLAYER_DEFAULT_BASE_URL = 'https://models.mixlayer.ai/v1'

/** OpenAI Responses WebSocket beta header used by compatible endpoints. */
export const MIXLAYER_RESPONSES_WEBSOCKET_BETA = 'responses_websockets=2026-02-06'

/** Returns the Responses WebSocket endpoint for a Mixlayer-compatible base URL. */
export function getMixlayerResponsesWebSocketURL(
  baseURL = MIXLAYER_DEFAULT_BASE_URL
): string {
  const url = new URL(baseURL)
  if (url.protocol === 'https:') url.protocol = 'wss:'
  else if (url.protocol === 'http:') url.protocol = 'ws:'

  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/responses') ? path : `${path}/responses`
  return url.toString()
}

/** Default Mixlayer Responses WebSocket endpoint. */
export const MIXLAYER_DEFAULT_RESPONSES_WEBSOCKET_URL =
  getMixlayerResponsesWebSocketURL(MIXLAYER_DEFAULT_BASE_URL)
