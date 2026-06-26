import {
  MIXLAYER_RESPONSES_WEBSOCKET_BETA,
  getMixlayerResponsesWebSocketURL,
} from './constants'

export interface MixlayerWebSocketConnection {
  readyState?: number
  binaryType?: BinaryType
  send(data: string): void | Promise<void>
  close(code?: number, reason?: string): void
  addEventListener(type: 'message' | 'error' | 'close', listener: (event: Event) => void): void
  removeEventListener(type: 'message' | 'error' | 'close', listener: (event: Event) => void): void
  /** Cloudflare Workers fetch-upgrade WebSockets must be accepted before use. */
  accept?: (options?: { allowHalfOpen?: boolean }) => void
}

export interface MixlayerWebSocketConnectOptions {
  url: string
  headers: Record<string, string>
  signal?: AbortSignal
}

export type MixlayerWebSocketConnector = (
  options: MixlayerWebSocketConnectOptions
) => Promise<MixlayerWebSocketConnection>

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
  /**
   * Custom WebSocket connector. The default uses `fetch()` with
   * `Upgrade: websocket`, which is supported by Cloudflare Workers.
   */
  connect?: MixlayerWebSocketConnector
}

export type MixlayerWebSocketFetch = typeof fetch & {
  /** Close the underlying WebSocket connection, if one is open or connecting. */
  close(): void
}

type WebSocketUpgradeResponse = Response & {
  webSocket?: MixlayerWebSocketConnection | null
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
 *
 * The default connector uses the Web-standard `fetch()` WebSocket upgrade shape
 * available in Cloudflare Workers. Runtimes that do not expose
 * `Response.webSocket` can pass a custom `connect` implementation.
 */
export function createMixlayerWebSocketFetch(
  options: MixlayerWebSocketFetchOptions = {}
): MixlayerWebSocketFetch {
  const wsUrl = options.url ?? getMixlayerResponsesWebSocketURL(options.baseURL)
  const fallbackFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const connect =
    options.connect ??
    ((connectOptions: MixlayerWebSocketConnectOptions) =>
      connectWithFetchUpgrade(connectOptions, fallbackFetch))

  let socket: MixlayerWebSocketConnection | null = null
  let connecting: Promise<MixlayerWebSocketConnection> | null = null
  let connectAbortController: AbortController | null = null
  let socketHeaderKey: string | null = null
  let connectionGeneration = 0
  let requestQueue: Promise<void> = Promise.resolve()

  function closeCurrentSocket() {
    connectionGeneration++
    connectAbortController?.abort(new DOMException('WebSocket closed', 'AbortError'))
    connectAbortController = null
    connecting = null
    socketHeaderKey = null

    const current = socket
    socket = null
    if (current && !isClosed(current)) current.close()
  }

  async function getConnection(headers: Record<string, string>): Promise<MixlayerWebSocketConnection> {
    const headerKey = stableHeaderKey(headers)

    if (socket && !isClosed(socket) && socketHeaderKey === headerKey) {
      return socket
    }

    if (socket && socketHeaderKey !== headerKey) closeCurrentSocket()

    if (connecting && socketHeaderKey === headerKey) return connecting

    const generation = connectionGeneration
    socketHeaderKey = headerKey
    connectAbortController = new AbortController()

    connecting = connect({
      url: wsUrl,
      headers,
      signal: connectAbortController.signal,
    })
      .then(nextSocket => {
        connectAbortController = null
        connecting = null

        if (generation !== connectionGeneration) {
          nextSocket.close()
          throw new DOMException('WebSocket closed', 'AbortError')
        }

        socket = nextSocket
        return nextSocket
      })
      .catch(error => {
        if (generation === connectionGeneration) {
          connectAbortController = null
          connecting = null
          socketHeaderKey = null
        }
        throw error
      })

    return connecting
  }

  async function websocketFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = getRequestURL(input)
    const method = getRequestMethod(input, init)
    if (method !== 'POST' || !isResponsesURL(url)) {
      return fallbackFetch(input, init)
    }

    const body = await parseJsonBody(input, init)
    if (body == null || body.stream !== true) return fallbackFetch(input, init)

    const requestHeaders = normalizeHeaders(getRequestHeaders(input, init))
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

    let connection: MixlayerWebSocketConnection
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
          connection.removeEventListener('message', onMessage)
          connection.removeEventListener('error', onError)
          connection.removeEventListener('close', onClose)
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

        async function onMessage(event: Event) {
          try {
            const text = await eventDataToString(getEventData(event))
            controller.enqueue(encoder.encode(`data: ${text}\n\n`))

            const parsed = JSON.parse(text) as { type?: unknown }
            if (
              typeof parsed.type === 'string' &&
              TERMINAL_RESPONSE_EVENT_TYPES.has(parsed.type)
            ) {
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              cleanup()
              closeStream()
            }
          } catch (error) {
            cleanup()
            controller.error(error)
          }
        }

        function onError(event: Event) {
          cleanup()
          controller.error(eventToError(event))
        }

        function onClose() {
          cleanup()
          closeStream()
        }

        connection.addEventListener('message', onMessage)
        connection.addEventListener('error', onError)
        connection.addEventListener('close', onClose)

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

        Promise.resolve(
          connection.send(JSON.stringify({ type: 'response.create', ...requestBody }))
        ).catch(error => {
          cleanup()
          controller.error(error)
        })
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

async function connectWithFetchUpgrade(
  { url, headers, signal }: MixlayerWebSocketConnectOptions,
  fetchImplementation: typeof fetch
): Promise<MixlayerWebSocketConnection> {
  const response = (await fetchImplementation(getFetchUpgradeURL(url), {
    method: 'GET',
    headers: {
      ...headers,
      Upgrade: 'websocket',
    },
    signal,
  })) as WebSocketUpgradeResponse

  if (!response.webSocket) {
    throw new Error(
      'This runtime does not expose Response.webSocket for fetch-based WebSocket upgrades. ' +
        `Received HTTP ${response.status} from ${getFetchUpgradeURL(url)}. ` +
        'Pass a custom `connect` option to createMixlayerWebSocketFetch().'
    )
  }

  try {
    response.webSocket.binaryType = 'arraybuffer'
  } catch {
    // Some runtimes may expose a read-only binaryType. We can still consume
    // Blob, ArrayBuffer, and string message payloads below.
  }
  response.webSocket.accept?.()
  return response.webSocket
}

function getRequestURL(input: RequestInfo | URL): string {
  if (input instanceof URL) return input.toString()
  if (typeof input === 'string') return input
  return input.url
}

function getRequestMethod(input: RequestInfo | URL, init: RequestInit | undefined): string | undefined {
  return (init?.method ?? (input instanceof Request ? input.method : undefined))?.toUpperCase()
}

function getRequestHeaders(
  input: RequestInfo | URL,
  init: RequestInit | undefined
): HeadersInit | undefined {
  return init?.headers ?? (input instanceof Request ? input.headers : undefined)
}

function isResponsesURL(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, '').endsWith('/responses')
  } catch {
    return url.replace(/\/+$/, '').endsWith('/responses')
  }
}

async function parseJsonBody(
  input: RequestInfo | URL,
  init: RequestInit | undefined
): Promise<Record<string, unknown> | undefined> {
  const body =
    init?.body ??
    (input instanceof Request && input.body != null ? await input.clone().text() : undefined)

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

function getFetchUpgradeURL(url: string): string {
  const upgradeUrl = new URL(url)
  if (upgradeUrl.protocol === 'wss:') upgradeUrl.protocol = 'https:'
  else if (upgradeUrl.protocol === 'ws:') upgradeUrl.protocol = 'http:'
  return upgradeUrl.toString()
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

function isClosed(connection: MixlayerWebSocketConnection): boolean {
  return connection.readyState === 2 || connection.readyState === 3
}

function getEventData(event: Event): unknown {
  return 'data' in event ? (event as MessageEvent).data : event
}

async function eventDataToString(data: unknown): Promise<string> {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data)
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.text()
  return String(data)
}

function eventToError(event: Event): Error {
  if ('error' in event && event.error instanceof Error) return event.error
  if ('message' in event && typeof event.message === 'string') return new Error(event.message)
  return new Error('WebSocket error')
}
