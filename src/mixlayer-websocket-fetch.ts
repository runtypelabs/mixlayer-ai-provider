import WebSocket, { type RawData } from 'ws'
import {
  MIXLAYER_RESPONSES_WEBSOCKET_BETA,
  getMixlayerResponsesWebSocketURL,
} from './constants'

export interface MixlayerWebSocketFetchOptions {
  /**
   * WebSocket endpoint URL. Defaults to the Mixlayer Responses WebSocket URL
   * derived from `baseURL`.
   */
  url?: string
  /**
   * HTTP base URL used to derive the WebSocket URL when `url` is omitted.
   * Defaults to `https://models.mixlayer.ai/v1`.
   */
  baseURL?: string
  /** Extra headers to include in the WebSocket handshake. */
  headers?: Record<string, string>
  /**
   * Value for the OpenAI Responses WebSocket beta header. Set to `false` to
   * omit the header.
   */
  betaHeader?: string | false
  /** Fallback fetch for non-streaming or non-Responses requests. */
  fetch?: typeof fetch
}

export type MixlayerWebSocketFetch = typeof fetch & {
  /** Close the underlying WebSocket connection, if one is open. */
  close(): void
}

const TERMINAL_RESPONSE_EVENT_TYPES = new Set([
  'response.completed',
  'response.failed',
  'response.incomplete',
  'response.cancelled',
  'error',
])

/**
 * Creates a `fetch` function that routes OpenAI Responses API streaming
 * requests through Mixlayer's Responses WebSocket endpoint.
 *
 * Non-streaming requests and requests to other endpoints fall back to `fetch`.
 * The WebSocket is opened lazily and reused sequentially, matching the OpenAI
 * Responses WebSocket API's one-in-flight-response-per-connection semantics.
 */
export function createMixlayerWebSocketFetch(
  options: MixlayerWebSocketFetchOptions = {}
): MixlayerWebSocketFetch {
  const wsUrl = options.url ?? getMixlayerResponsesWebSocketURL(options.baseURL)
  const fallbackFetch = options.fetch ?? globalThis.fetch.bind(globalThis)

  let socket: WebSocket | null = null
  let connecting: Promise<WebSocket> | null = null
  let socketHeaderKey: string | null = null
  let requestQueue: Promise<void> = Promise.resolve()

  function closeCurrentSocket() {
    const current = socket
    socket = null
    connecting = null
    socketHeaderKey = null
    if (current && current.readyState !== WebSocket.CLOSED) current.close()
  }

  function getConnection(headers: Record<string, string>): Promise<WebSocket> {
    const headerKey = stableHeaderKey(headers)

    if (
      socket?.readyState === WebSocket.OPEN &&
      socketHeaderKey === headerKey
    ) {
      return Promise.resolve(socket)
    }

    if (socket && socketHeaderKey !== headerKey) closeCurrentSocket()

    if (connecting && socketHeaderKey === headerKey) return connecting

    socketHeaderKey = headerKey
    connecting = new Promise((resolve, reject) => {
      const nextSocket = new WebSocket(wsUrl, { headers })

      nextSocket.on('open', () => {
        socket = nextSocket
        connecting = null
        resolve(nextSocket)
      })

      nextSocket.on('error', error => {
        if (connecting) {
          connecting = null
          reject(error)
        }
      })

      nextSocket.on('close', () => {
        if (socket === nextSocket) {
          socket = null
          socketHeaderKey = null
        }
      })
    })

    return connecting
  }

  async function websocketFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = getRequestURL(input)
    if (init?.method !== 'POST' || !isResponsesURL(url)) {
      return fallbackFetch(input, init)
    }

    const body = parseJsonBody(init.body)
    if (body == null || body.stream !== true) return fallbackFetch(input, init)

    const requestHeaders = normalizeHeaders(init.headers)
    const websocketHeaders = buildWebSocketHeaders({
      requestHeaders,
      optionHeaders: options.headers,
      betaHeader: options.betaHeader,
    })

    const releasePreviousRequest = requestQueue
    let releaseCurrentRequest!: () => void
    requestQueue = requestQueue.then(
      () =>
        new Promise<void>(resolve => {
          releaseCurrentRequest = resolve
        })
    )
    await releasePreviousRequest

    let connection: WebSocket
    try {
      connection = await getConnection(websocketHeaders)
    } catch (error) {
      releaseCurrentRequest()
      throw error
    }

    const { stream: _stream, ...requestBody } = body
    const encoder = new TextEncoder()
    let cleanedUp = false
    let cleanupStream = () => releaseCurrentRequest()

    const responseStream = new ReadableStream<Uint8Array>({
      start(controller) {
        let abortHandler: (() => void) | undefined

        function cleanup() {
          if (cleanedUp) return
          cleanedUp = true
          connection.off('message', onMessage)
          connection.off('error', onError)
          connection.off('close', onClose)
          if (abortHandler) init?.signal?.removeEventListener('abort', abortHandler)
          releaseCurrentRequest()
        }
        cleanupStream = cleanup

        function closeStream() {
          try {
            controller.close()
          } catch {
            // The stream may already be closed by an abort/error race.
          }
        }

        function onMessage(data: RawData) {
          const text = data.toString()
          controller.enqueue(encoder.encode(`data: ${text}\n\n`))

          try {
            const event = JSON.parse(text) as { type?: unknown }
            if (
              typeof event.type === 'string' &&
              TERMINAL_RESPONSE_EVENT_TYPES.has(event.type)
            ) {
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              cleanup()
              closeStream()
            }
          } catch {
            // Non-JSON messages are still forwarded as SSE data frames.
          }
        }

        function onError(error: Error) {
          cleanup()
          controller.error(error)
        }

        function onClose() {
          cleanup()
          closeStream()
        }

        connection.on('message', onMessage)
        connection.on('error', onError)
        connection.on('close', onClose)

        if (init?.signal) {
          abortHandler = () => {
            cleanup()
            try {
              controller.error(
                init.signal?.reason ?? new DOMException('Aborted', 'AbortError')
              )
            } catch {
              // The stream may already be closed by the terminal response event.
            }
          }

          if (init.signal.aborted) {
            abortHandler()
            return
          }

          init.signal.addEventListener('abort', abortHandler, { once: true })
        }

        connection.send(
          JSON.stringify({ type: 'response.create', ...requestBody }),
          error => {
            if (error) onError(error)
          }
        )
      },
      cancel() {
        cleanupStream()
      },
    })

    return new Response(responseStream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }

  return Object.assign(websocketFetch, {
    close: closeCurrentSocket,
  })
}

function getRequestURL(input: RequestInfo | URL): string {
  if (input instanceof URL) return input.toString()
  if (typeof input === 'string') return input
  return input.url
}

function isResponsesURL(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, '').endsWith('/responses')
  } catch {
    return url.replace(/\/+$/, '').endsWith('/responses')
  }
}

function parseJsonBody(body: BodyInit | null | undefined): Record<string, unknown> | undefined {
  if (typeof body !== 'string') return undefined
  try {
    const parsed = JSON.parse(body) as unknown
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (!headers) return result

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key.toLowerCase()] = value
    })
    return result
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) result[key.toLowerCase()] = value
    return result
  }

  for (const [key, value] of Object.entries(headers)) {
    if (value != null) result[key.toLowerCase()] = value
  }
  return result
}

function buildWebSocketHeaders({
  requestHeaders,
  optionHeaders,
  betaHeader,
}: {
  requestHeaders: Record<string, string>
  optionHeaders?: Record<string, string>
  betaHeader?: string | false
}): Record<string, string> {
  return removeUndefinedHeaders({
    Authorization: requestHeaders.authorization,
    ...(betaHeader !== false && {
      'OpenAI-Beta': betaHeader ?? MIXLAYER_RESPONSES_WEBSOCKET_BETA,
    }),
    ...optionHeaders,
  })
}

function removeUndefinedHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([, value]) => value !== undefined)
  ) as Record<string, string>
}

function stableHeaderKey(headers: Record<string, string>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(headers).sort(([left], [right]) => left.localeCompare(right))
    )
  )
}
