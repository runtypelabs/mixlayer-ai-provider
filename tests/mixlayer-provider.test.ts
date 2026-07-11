import { generateText } from 'ai'
import { describe, it, expect, vi } from 'vitest'

import {
  createMixlayer,
  mixlayer,
  createMixlayerWebSocketFetch,
  extractMixlayerModelId,
  getMixlayerResponsesWebSocketURL,
  isQwen35Or36,
  applyQwenThinking,
  MIXLAYER_DEFAULT_BASE_URL,
  MIXLAYER_DEFAULT_RESPONSES_WEBSOCKET_URL,
  MIXLAYER_RESPONSES_WEBSOCKET_BETA,
  MIXLAYER_KNOWN_MODEL_IDS,
  type MixlayerChatModelId,
  type MixlayerWebSocketConnectOptions,
  type MixlayerWebSocketConnection,
} from '../src/index'

const futureModelId: MixlayerChatModelId = 'future/model-not-in-snapshot'

void futureModelId

class MockWebSocketConnection extends EventTarget implements MixlayerWebSocketConnection {
  readyState = 1
  binaryType: BinaryType = 'blob'
  sent: string[] = []
  closed = false
  accepted = false

  constructor(
    readonly url = 'wss://models.mixlayer.ai/v1/responses',
    readonly headers: Record<string, string> = {}
  ) {
    super()
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.closed = true
    this.readyState = 3
    this.dispatchEvent(new Event('close'))
  }

  accept() {
    this.accepted = true
  }

  emitMessage(data: unknown) {
    const event = new Event('message') as Event & { data: unknown }
    Object.defineProperty(event, 'data', { value: data })
    this.dispatchEvent(event)
  }

  emitClose() {
    this.readyState = 3
    this.dispatchEvent(new Event('close'))
  }
}

describe('MIXLAYER_KNOWN_MODEL_IDS', () => {
  it('exports the current model snapshot without duplicates', () => {
    expect(MIXLAYER_KNOWN_MODEL_IDS).toEqual([
      'qwen/qwen3.5-4b-free',
      'qwen/qwen3.5-9b',
      'qwen/qwen3.5-35b-a3b',
      'qwen/qwen3.5-397b-a17b',
      'qwen/qwen3.6-27b',
      'qwen/qwen3.6-35b-a3b',
      'moonshotai/kimi-k2.6',
      'moonshotai/kimi-k2.7-code',
      'z-ai/glm-5.2',
    ])
    expect(new Set(MIXLAYER_KNOWN_MODEL_IDS).size).toBe(
      MIXLAYER_KNOWN_MODEL_IDS.length
    )
  })
})

function createWebSocketResponse(connection: MockWebSocketConnection): Response {
  const response = new Response(null) as Response & {
    webSocket?: MixlayerWebSocketConnection
  }
  Object.defineProperty(response, 'webSocket', { value: connection })
  return response
}

function createResponsesSuccessBody(text = 'ok') {
  return {
    id: 'resp_1',
    model: 'qwen/qwen3.5-4b-free',
    output: [
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

describe('extractMixlayerModelId', () => {
  it('strips the mixlayer/ prefix but keeps the org segment', () => {
    expect(extractMixlayerModelId('mixlayer/qwen/qwen3.5-9b')).toBe('qwen/qwen3.5-9b')
  })

  it('strips the mixlayer: prefix (case-insensitive) and trims', () => {
    expect(extractMixlayerModelId('  Mixlayer:qwen/qwen3.5-9b ')).toBe('qwen/qwen3.5-9b')
  })

  it('returns bare ids unchanged', () => {
    expect(extractMixlayerModelId('qwen/qwen3.5-9b')).toBe('qwen/qwen3.5-9b')
  })
})

describe('isQwen35Or36', () => {
  it('matches the Qwen 3.5 / 3.6 catalog ids (dotted, with or without org)', () => {
    for (const id of [
      'qwen/qwen3.5-4b-free',
      'qwen/qwen3.5-9b',
      'qwen/qwen3.5-27b',
      'qwen/qwen3.5-35b-a3b',
      'qwen/qwen3.5-397b-a17b',
      'qwen/qwen3.6-27b',
      'qwen/qwen3.6-35b-a3b',
      'qwen3.5-9b',
      'mixlayer/qwen/qwen3.6-27b',
    ]) {
      expect(isQwen35Or36(id)).toBe(true)
    }
  })

  it('tolerates a dash form too', () => {
    expect(isQwen35Or36('qwen3-5-9b')).toBe(true)
    expect(isQwen35Or36('qwen3-6-27b')).toBe(true)
  })

  it('does NOT match later Qwen generations', () => {
    for (const id of ['qwen/qwen3.7-27b', 'qwen/qwen4-9b', 'qwen3.7-max']) {
      expect(isQwen35Or36(id)).toBe(false)
    }
  })

  it('does NOT match other model families', () => {
    for (const id of ['kimi-k2-instruct', 'moonshot/kimi-k2', 'gpt-4', 'llama-3.5-8b']) {
      expect(isQwen35Or36(id)).toBe(false)
    }
  })

  it('requires a separator after the minor version (no false positives on size tokens)', () => {
    expect(isQwen35Or36('qwen3-5b')).toBe(false)
    expect(isQwen35Or36('qwen3-50b')).toBe(false)
  })
})

describe('applyQwenThinking', () => {
  it('sets thinking: true by default for a Qwen 3.5 / 3.6 model', () => {
    const out = applyQwenThinking({ model: 'qwen/qwen3.5-9b', messages: [] })
    expect(out.thinking).toBe(true)
  })

  it('sets thinking: false when thinking=false', () => {
    const out = applyQwenThinking({ model: 'qwen/qwen3.6-27b', messages: [] }, false)
    expect(out.thinking).toBe(false)
  })

  it('does NOT inject sampling defaults (Mixlayer applies them server-side)', () => {
    const out = applyQwenThinking({ model: 'qwen/qwen3.5-9b', messages: [] })
    for (const key of ['temperature', 'top_p', 'top_k', 'presence_penalty', 'repetition_penalty', 'min_p']) {
      expect(out).not.toHaveProperty(key)
    }
  })

  it('preserves caller-set sampling values untouched', () => {
    const out = applyQwenThinking({ model: 'qwen/qwen3.5-9b', temperature: 0, top_p: 0.1 })
    expect(out.temperature).toBe(0)
    expect(out.top_p).toBe(0.1)
  })

  it('lets a caller-set thinking value win', () => {
    const body = { model: 'qwen/qwen3.5-9b', thinking: false }
    expect(applyQwenThinking(body, true)).toBe(body)
  })

  it('leaves later-Qwen and other-family models untouched', () => {
    const future = { model: 'qwen/qwen3.7-27b', messages: [] }
    expect(applyQwenThinking(future)).toBe(future)
    const kimi = { model: 'kimi-k2-instruct', messages: [] }
    expect(applyQwenThinking(kimi)).toBe(kimi)
  })
})

describe('createMixlayer', () => {
  it('exposes a callable provider with languageModel/chatModel accessors', () => {
    const provider = createMixlayer({ apiKey: 'test' })
    expect(typeof provider).toBe('function')
    expect(typeof provider.languageModel).toBe('function')
    expect(typeof provider.chat).toBe('function')
    expect(typeof provider.responses).toBe('function')
    expect(typeof provider.chatModel).toBe('function')
    expect(typeof provider.responsesModel).toBe('function')
  })

  it('builds a wrapped language model for a prefixed id', () => {
    const provider = createMixlayer({ apiKey: 'test' })
    const model = provider('mixlayer/qwen/qwen3.5-9b')
    expect(model).toBeDefined()
    // AI SDK v7 providers expose v4 language models.
    expect((model as { specificationVersion?: string }).specificationVersion).toBe('v4')
  })

  it('builds an explicit Responses API model for a prefixed id', () => {
    const provider = createMixlayer({ apiKey: 'test' })
    const model = provider.responses('mixlayer/qwen/qwen3.5-9b')
    expect(model).toBeDefined()
    expect((model as { specificationVersion?: string }).specificationVersion).toBe('v4')
    expect((model as { provider?: string }).provider).toBe('mixlayer.responses')
    expect((model as { modelId?: string }).modelId).toBe('qwen/qwen3.5-9b')
  })

  it('can make the callable provider use Responses API models', () => {
    const provider = createMixlayer({ apiKey: 'test', defaultModelApi: 'responses' })
    expect((provider('qwen/qwen3.5-9b') as { provider?: string }).provider).toBe(
      'mixlayer.responses'
    )
    expect((provider.chat('qwen/qwen3.5-9b') as { provider?: string }).provider).toBe(
      'mixlayer.chat'
    )
  })

  it('preserves a custom Responses Authorization header on outbound requests', async () => {
    const authorizations: Array<string | null> = []
    const provider = createMixlayer({
      headers: { Authorization: 'Bearer real-mixlayer-token' },
      fetch: async (_input, init) => {
        authorizations.push(new Headers(init?.headers).get('authorization'))
        return new Response(JSON.stringify(createResponsesSuccessBody()), {
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    const result = await generateText({
      model: provider.responses('qwen/qwen3.5-4b-free'),
      prompt: 'Say ok',
    })

    expect(result.text).toBe('ok')
    expect(authorizations).toEqual(['Bearer real-mixlayer-token'])
  })

  it('disables Responses reasoning by default when thinking is false', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const provider = createMixlayer({
      apiKey: 'test',
      thinking: false,
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify(createResponsesSuccessBody()), {
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    await generateText({
      model: provider.responses('qwen/qwen3.5-4b-free'),
      prompt: 'Say ok',
    })

    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ reasoning: { effort: 'none' } })
  })

  it('preserves top-level Responses reasoning when thinking is false', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const provider = createMixlayer({
      apiKey: 'test',
      thinking: false,
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify(createResponsesSuccessBody()), {
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    await generateText({
      model: provider.responses('qwen/qwen3.5-4b-free'),
      prompt: 'Say ok',
      reasoning: 'high',
    })

    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ reasoning: { effort: 'high' } })
  })

  it('preserves future top-level Responses reasoning levels', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const provider = createMixlayer({
      apiKey: 'test',
      thinking: false,
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify(createResponsesSuccessBody()), {
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    await generateText({
      model: provider.responses('qwen/qwen3.5-4b-free'),
      prompt: 'Say ok',
      reasoning: 'future-level' as 'high',
    })

    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ reasoning: { effort: 'future-level' } })
  })

  it('serializes provider Responses reasoning effort for a custom Qwen id', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const provider = createMixlayer({
      apiKey: 'test',
      thinking: false,
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify(createResponsesSuccessBody()), {
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    await generateText({
      model: provider.responses('qwen/qwen3.5-4b-free'),
      prompt: 'Say ok',
      providerOptions: { openai: { reasoningEffort: 'low' } },
    })

    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ reasoning: { effort: 'low' } })
  })

  it('preserves a provider Responses reasoning summary when thinking is false', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const provider = createMixlayer({
      apiKey: 'test',
      thinking: false,
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify(createResponsesSuccessBody()), {
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    await generateText({
      model: provider.responses('qwen/qwen3.5-4b-free'),
      prompt: 'Say ok',
      providerOptions: { openai: { reasoningSummary: 'detailed' } },
    })

    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ reasoning: { summary: 'detailed' } })
    expect(bodies[0]).not.toHaveProperty('reasoning.effort')
  })

  it('prefers provider Responses reasoning effort over top-level reasoning', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const provider = createMixlayer({
      apiKey: 'test',
      thinking: false,
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify(createResponsesSuccessBody()), {
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    await generateText({
      model: provider.responses('qwen/qwen3.5-4b-free'),
      prompt: 'Say ok',
      reasoning: 'high',
      providerOptions: { openai: { reasoningEffort: 'low' } },
    })

    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ reasoning: { effort: 'low' } })
  })

  it('preserves an explicit forceReasoning false for Responses requests', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const provider = createMixlayer({
      apiKey: 'test',
      thinking: false,
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify(createResponsesSuccessBody()), {
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    const result = await generateText({
      model: provider.responses('qwen/qwen3.5-4b-free'),
      prompt: 'Say ok',
      providerOptions: { openai: { forceReasoning: false } },
    })

    expect(result.warnings).toEqual([])
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).not.toHaveProperty('reasoning')
  })

  it('the default provider instance is usable', () => {
    expect(typeof mixlayer).toBe('function')
    expect(mixlayer('qwen/qwen3.5-9b')).toBeDefined()
  })

  it('exposes the default base URL constant', () => {
    expect(MIXLAYER_DEFAULT_BASE_URL).toBe('https://models.mixlayer.ai/v1')
  })
})

describe('getMixlayerResponsesWebSocketURL', () => {
  it('derives the default Responses WebSocket URL from the base URL', () => {
    expect(MIXLAYER_DEFAULT_RESPONSES_WEBSOCKET_URL).toBe(
      'wss://models.mixlayer.ai/v1/responses'
    )
    expect(getMixlayerResponsesWebSocketURL()).toBe(MIXLAYER_DEFAULT_RESPONSES_WEBSOCKET_URL)
  })

  it('supports custom http(s) base URLs and avoids double-appending /responses', () => {
    expect(getMixlayerResponsesWebSocketURL('http://localhost:8787/v1')).toBe(
      'ws://localhost:8787/v1/responses'
    )
    expect(getMixlayerResponsesWebSocketURL('https://example.test/v1/responses')).toBe(
      'wss://example.test/v1/responses'
    )
  })
})

describe('createMixlayerWebSocketFetch', () => {
  it('routes streaming Responses API requests through a response.create WebSocket event', async () => {
    const connections: MockWebSocketConnection[] = []
    const wsFetch = createMixlayerWebSocketFetch({
      url: 'wss://127.0.0.1:8787/v1/responses',
      connect: async ({ url, headers }: MixlayerWebSocketConnectOptions) => {
        const connection = new MockWebSocketConnection(url, headers)
        connections.push(connection)
        return connection
      },
    })

    try {
      const response = await wsFetch('https://models.mixlayer.ai/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-key',
          'User-Agent': 'ai-sdk/openai/4.0.0 ai-sdk/provider-utils/5.0.0',
        },
        body: JSON.stringify({
          model: 'qwen/qwen3.5-9b',
          input: [],
          stream: true,
          store: false,
        }),
      })

      await vi.waitFor(() => expect(connections).toHaveLength(1))
      const socket = connections[0]
      await vi.waitFor(() => expect(socket.sent).toHaveLength(1))

      expect(socket.url).toBe('wss://127.0.0.1:8787/v1/responses')
      expect(socket.headers.Authorization).toBe('Bearer test-key')
      expect(socket.headers['OpenAI-Beta']).toBe(MIXLAYER_RESPONSES_WEBSOCKET_BETA)
      expect(socket.headers['User-Agent']).toBe(
        'ai-sdk/openai/4.0.0 ai-sdk/provider-utils/5.0.0'
      )
      expect(JSON.parse(socket.sent[0]) as unknown).toEqual({
        type: 'response.create',
        model: 'qwen/qwen3.5-9b',
        input: [],
        store: false,
      })

      socket.emitMessage(JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' }))
      socket.emitMessage(JSON.stringify({ type: 'response.completed', response: { id: 'resp_1' } }))

      const text = await response.text()
      expect(text).toContain('data: {"type":"response.output_text.delta","delta":"hi"}')
      expect(text).toContain('data: [DONE]')
    } finally {
      wsFetch.close()
    }
  })

  it('falls back for a streaming Responses request to a foreign origin', async () => {
    const fallbackFetch = vi.fn(async () => new Response('fallback-ok', { status: 202 }))
    const connect = vi.fn(async () => new MockWebSocketConnection())
    const wsFetch = createMixlayerWebSocketFetch({ fetch: fallbackFetch, connect })

    try {
      const response = await wsFetch('https://foreign.example/v1/responses', {
        method: 'POST',
        headers: { Authorization: 'Bearer foreign-request-marker' },
        body: JSON.stringify({ model: 'qwen/qwen3.5-9b', input: [], stream: true }),
      })

      expect(response.status).toBe(202)
      expect(await response.text()).toBe('fallback-ok')
      expect(fallbackFetch).toHaveBeenCalledTimes(1)
      expect(connect).not.toHaveBeenCalled()
    } finally {
      wsFetch.close()
    }
  })

  it('falls back for a streaming request at a different same-origin path', async () => {
    const fallbackFetch = vi.fn(async () => new Response('fallback-ok', { status: 202 }))
    const connect = vi.fn(async () => new MockWebSocketConnection())
    const wsFetch = createMixlayerWebSocketFetch({ fetch: fallbackFetch, connect })

    try {
      const response = await wsFetch('https://models.mixlayer.ai/other/responses', {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong-path-marker' },
        body: JSON.stringify({ model: 'qwen/qwen3.5-9b', input: [], stream: true }),
      })

      expect(response.status).toBe(202)
      expect(await response.text()).toBe('fallback-ok')
      expect(fallbackFetch).toHaveBeenCalledTimes(1)
      expect(connect).not.toHaveBeenCalled()
    } finally {
      wsFetch.close()
    }
  })

  it('uses baseURL for HTTP routing when url separately overrides the socket destination', async () => {
    let connection: MockWebSocketConnection | undefined
    const fallbackFetch = vi.fn(async () => new Response('fallback-ok'))
    const connect = vi.fn(async ({ url }: MixlayerWebSocketConnectOptions) => {
      connection = new MockWebSocketConnection(url)
      return connection
    })
    const wsFetch = createMixlayerWebSocketFetch({
      baseURL: 'https://custom.example/api',
      url: 'wss://socket.example/custom/responses',
      fetch: fallbackFetch,
      connect,
    })

    try {
      const response = await wsFetch('https://custom.example/api/responses?trace=marker', {
        method: 'POST',
        headers: { Authorization: 'Bearer custom-route-marker' },
        body: JSON.stringify({ model: 'qwen/qwen3.5-9b', input: [], stream: true }),
      })

      await vi.waitFor(() => expect(connection?.sent).toHaveLength(1))
      expect(connect).toHaveBeenCalledTimes(1)
      expect(connection?.url).toBe('wss://socket.example/custom/responses')
      expect(fallbackFetch).not.toHaveBeenCalled()
      connection?.emitMessage(JSON.stringify({ type: 'response.completed' }))
      expect(await response.text()).toContain('data: [DONE]')
    } finally {
      wsFetch.close()
    }
  })

  it('lets a lowercase option authorization override request Authorization once', async () => {
    let connection: MockWebSocketConnection | undefined
    const wsFetch = createMixlayerWebSocketFetch({
      headers: { authorization: 'Bearer option-authorization-marker' },
      connect: async ({ headers }: MixlayerWebSocketConnectOptions) => {
        connection = new MockWebSocketConnection(undefined, headers)
        return connection
      },
    })

    try {
      const response = await wsFetch('https://models.mixlayer.ai/v1/responses', {
        method: 'POST',
        headers: { Authorization: 'Bearer request-authorization-marker' },
        body: JSON.stringify({ model: 'qwen/qwen3.5-9b', input: [], stream: true }),
      })

      await vi.waitFor(() => expect(connection?.sent).toHaveLength(1))
      const authorizationEntries = Object.entries(connection?.headers ?? {}).filter(
        ([name]) => name.toLowerCase() === 'authorization'
      )
      expect(authorizationEntries).toEqual([
        ['authorization', 'Bearer option-authorization-marker'],
      ])
      connection?.emitMessage(JSON.stringify({ type: 'response.completed' }))
      await response.text()
    } finally {
      wsFetch.close()
    }
  })

  it('lets a lowercase option beta header override betaHeader once', async () => {
    let connection: MockWebSocketConnection | undefined
    const wsFetch = createMixlayerWebSocketFetch({
      betaHeader: 'responses=v2',
      headers: { 'openai-beta': 'option-beta-marker' },
      connect: async ({ headers }: MixlayerWebSocketConnectOptions) => {
        connection = new MockWebSocketConnection(undefined, headers)
        return connection
      },
    })

    try {
      const response = await wsFetch('https://models.mixlayer.ai/v1/responses', {
        method: 'POST',
        body: JSON.stringify({ model: 'qwen/qwen3.5-9b', input: [], stream: true }),
      })

      await vi.waitFor(() => expect(connection?.sent).toHaveLength(1))
      const betaEntries = Object.entries(connection?.headers ?? {}).filter(
        ([name]) => name.toLowerCase() === 'openai-beta'
      )
      expect(betaEntries).toEqual([['openai-beta', 'option-beta-marker']])
      connection?.emitMessage(JSON.stringify({ type: 'response.completed' }))
      await response.text()
    } finally {
      wsFetch.close()
    }
  })

  it('reuses a healthy socket for sequential requests with identical headers', async () => {
    const connection = new MockWebSocketConnection()
    const connect = vi.fn(async () => connection)
    const wsFetch = createMixlayerWebSocketFetch({ connect })
    const requestInit = {
      method: 'POST',
      headers: { Authorization: 'Bearer first-test-key' },
      body: JSON.stringify({ model: 'qwen/qwen3.5-9b', input: [], stream: true }),
    }

    try {
      const firstResponse = await wsFetch('https://models.mixlayer.ai/v1/responses', requestInit)
      await vi.waitFor(() => expect(connection.sent).toHaveLength(1))
      connection.emitMessage(JSON.stringify({ type: 'response.completed', response: { id: 'first' } }))
      expect(await firstResponse.text()).toContain('data: [DONE]')

      const secondResponse = await wsFetch('https://models.mixlayer.ai/v1/responses', requestInit)
      await vi.waitFor(() => expect(connection.sent).toHaveLength(2))
      connection.emitMessage(JSON.stringify({ type: 'response.completed', response: { id: 'second' } }))
      expect(await secondResponse.text()).toContain('data: [DONE]')
      expect(connect).toHaveBeenCalledTimes(1)
      expect(connection.sent.map(message => JSON.parse(message))).toEqual([
        expect.objectContaining({ type: 'response.create' }),
        expect.objectContaining({ type: 'response.create' }),
      ])
    } finally {
      wsFetch.close()
    }
  })

  it('reconnects after a cached socket with undefined readyState closes', async () => {
    const connections: MockWebSocketConnection[] = []
    const connect = vi.fn(async () => {
      const connection = new MockWebSocketConnection()
      Object.defineProperty(connection, 'readyState', { value: undefined, writable: true })
      connections.push(connection)
      return connection
    })
    const wsFetch = createMixlayerWebSocketFetch({ connect })
    const requestInit = {
      method: 'POST',
      headers: { Authorization: 'Bearer first-test-key' },
      body: JSON.stringify({ model: 'qwen/qwen3.5-9b', input: [], stream: true }),
    }

    try {
      const firstResponse = await wsFetch(
        'https://models.mixlayer.ai/v1/responses',
        requestInit
      )
      await vi.waitFor(() => expect(connections[0]?.sent).toHaveLength(1))
      connections[0].emitMessage(JSON.stringify({ type: 'response.completed' }))
      await firstResponse.text()

      connections[0].dispatchEvent(new Event('close'))

      const secondResponse = await wsFetch(
        'https://models.mixlayer.ai/v1/responses',
        requestInit
      )
      await vi.waitFor(() => expect(connections).toHaveLength(2))
      connections[1].emitMessage(JSON.stringify({ type: 'response.completed' }))
      expect(await secondResponse.text()).toContain('data: [DONE]')
      expect(connect).toHaveBeenCalledTimes(2)
    } finally {
      wsFetch.close()
    }
  })

  it('reconnects when authorization changes between sequential requests', async () => {
    const connections: MockWebSocketConnection[] = []
    const connect = vi.fn(async ({ headers }: MixlayerWebSocketConnectOptions) => {
      const connection = new MockWebSocketConnection(undefined, headers)
      connections.push(connection)
      return connection
    })
    const wsFetch = createMixlayerWebSocketFetch({ connect })
    const request = (authorization: string) =>
      wsFetch('https://models.mixlayer.ai/v1/responses', {
        method: 'POST',
        headers: { Authorization: authorization },
        body: JSON.stringify({ model: 'qwen/qwen3.5-9b', input: [], stream: true }),
      })

    try {
      const firstResponse = await request('Bearer first-test-key')
      await vi.waitFor(() => expect(connections[0]?.sent).toHaveLength(1))
      connections[0].emitMessage(JSON.stringify({ type: 'response.completed' }))
      await firstResponse.text()

      const secondResponse = await request('Bearer second-test-key')
      await vi.waitFor(() => expect(connections).toHaveLength(2))
      expect(connections[0].closed).toBe(true)
      expect(connections[1].headers.Authorization).toBe('Bearer second-test-key')
      expect(JSON.stringify(connections[1].headers)).not.toContain('first-test-key')
      connections[1].emitMessage(JSON.stringify({ type: 'response.completed' }))
      await secondResponse.text()
    } finally {
      wsFetch.close()
    }
  })

  it('retires a cancelled response socket before allowing the next request', async () => {
    const connections: MockWebSocketConnection[] = []
    const wsFetch = createMixlayerWebSocketFetch({
      connect: async () => {
        const connection = new MockWebSocketConnection()
        connections.push(connection)
        return connection
      },
    })
    const request = () =>
      wsFetch('https://models.mixlayer.ai/v1/responses', {
        method: 'POST',
        headers: { Authorization: 'Bearer first-test-key' },
        body: JSON.stringify({ model: 'qwen/qwen3.5-9b', input: [], stream: true }),
      })

    try {
      const firstResponse = await request()
      await vi.waitFor(() => expect(connections[0]?.sent).toHaveLength(1))
      const secondResponsePromise = request()
      await firstResponse.body!.getReader().cancel()
      expect(connections[0].closed).toBe(true)

      const secondResponse = await secondResponsePromise
      await vi.waitFor(() => expect(connections).toHaveLength(2))
      connections[0].emitMessage(
        JSON.stringify({ type: 'response.output_text.delta', delta: 'late-old-data' })
      )
      connections[1].emitMessage(
        JSON.stringify({ type: 'response.output_text.delta', delta: 'fresh-data' })
      )
      connections[1].emitMessage(JSON.stringify({ type: 'response.completed' }))
      const text = await secondResponse.text()
      expect(text).toContain('fresh-data')
      expect(text).not.toContain('late-old-data')
    } finally {
      wsFetch.close()
    }
  })

  it('rejects a premature remote close and reconnects for the next request', async () => {
    const connections: MockWebSocketConnection[] = []
    const wsFetch = createMixlayerWebSocketFetch({
      connect: async () => {
        const connection = new MockWebSocketConnection()
        connections.push(connection)
        return connection
      },
    })
    const request = () =>
      wsFetch('https://models.mixlayer.ai/v1/responses', {
        method: 'POST',
        headers: { Authorization: 'Bearer first-test-key' },
        body: JSON.stringify({ model: 'qwen/qwen3.5-9b', input: [], stream: true }),
      })

    try {
      const firstResponse = await request()
      await vi.waitFor(() => expect(connections[0]?.sent).toHaveLength(1))
      connections[0].emitClose()
      await expect(firstResponse.text()).rejects.toThrow(
        'WebSocket closed before a terminal response event'
      )

      const secondResponse = await request()
      await vi.waitFor(() => expect(connections).toHaveLength(2))
      connections[1].emitMessage(JSON.stringify({ type: 'response.completed' }))
      expect(await secondResponse.text()).toContain('data: [DONE]')
    } finally {
      wsFetch.close()
    }
  })

  it('rejects an init.signal abort while queued without poisoning the queue', async () => {
    const connection = new MockWebSocketConnection()
    const wsFetch = createMixlayerWebSocketFetch({ connect: async () => connection })
    const request = (signal?: AbortSignal) =>
      wsFetch('https://models.mixlayer.ai/v1/responses', {
        method: 'POST',
        headers: { Authorization: 'Bearer first-test-key' },
        body: JSON.stringify({ model: 'qwen/qwen3.5-9b', input: [], stream: true }),
        signal,
      })

    try {
      const activeResponse = await request()
      await vi.waitFor(() => expect(connection.sent).toHaveLength(1))
      const abortController = new AbortController()
      const reason = new Error('queued init abort')
      const queuedResponse = request(abortController.signal)
      abortController.abort(reason)
      await expect(queuedResponse).rejects.toBe(reason)
      expect(connection.sent).toHaveLength(1)

      connection.emitMessage(JSON.stringify({ type: 'response.completed' }))
      await activeResponse.text()
      const laterResponse = await request()
      await vi.waitFor(() => expect(connection.sent).toHaveLength(2))
      connection.emitMessage(JSON.stringify({ type: 'response.completed' }))
      await laterResponse.text()
    } finally {
      wsFetch.close()
    }
  })

  it('honors a Request.signal abort while queued when init.signal is undefined', async () => {
    const connection = new MockWebSocketConnection()
    const wsFetch = createMixlayerWebSocketFetch({ connect: async () => connection })
    const requestInit = {
      method: 'POST',
      headers: { Authorization: 'Bearer first-test-key' },
      body: JSON.stringify({ model: 'qwen/qwen3.5-9b', input: [], stream: true }),
    }

    try {
      const activeResponse = await wsFetch('https://models.mixlayer.ai/v1/responses', requestInit)
      await vi.waitFor(() => expect(connection.sent).toHaveLength(1))
      const abortController = new AbortController()
      const queuedRequest = new Request('https://models.mixlayer.ai/v1/responses', {
        ...requestInit,
        signal: abortController.signal,
      })
      const queuedResponse = wsFetch(queuedRequest, { signal: undefined })
      abortController.abort(new Error('queued request abort'))
      await expect(queuedResponse).rejects.toThrow('queued request abort')
      expect(connection.sent).toHaveLength(1)

      connection.emitMessage(JSON.stringify({ type: 'response.completed' }))
      await activeResponse.text()
      const laterResponse = await wsFetch('https://models.mixlayer.ai/v1/responses', requestInit)
      await vi.waitFor(() => expect(connection.sent).toHaveLength(2))
      connection.emitMessage(JSON.stringify({ type: 'response.completed' }))
      await laterResponse.text()
    } finally {
      wsFetch.close()
    }
  })

  it('aborts pending connection work and permits a fresh connection', async () => {
    let resolveFirst!: () => void
    let firstSignal: AbortSignal | undefined
    const connections: MockWebSocketConnection[] = []
    const connect = vi.fn(
      ({ signal, onSocket }: MixlayerWebSocketConnectOptions) =>
        new Promise<MixlayerWebSocketConnection>(resolve => {
          const connection = new MockWebSocketConnection()
          connections.push(connection)
          onSocket?.(connection)
          if (connections.length === 1) {
            firstSignal = signal
            resolveFirst = () => resolve(connection)
          } else {
            resolve(connection)
          }
        })
    )
    const wsFetch = createMixlayerWebSocketFetch({ connect })
    const request = (signal?: AbortSignal) =>
      wsFetch('https://models.mixlayer.ai/v1/responses', {
        method: 'POST',
        headers: { Authorization: 'Bearer first-test-key' },
        body: JSON.stringify({ model: 'qwen/qwen3.5-9b', input: [], stream: true }),
        signal,
      })

    try {
      const abortController = new AbortController()
      const reason = new Error('connection abort')
      const firstResponse = request(abortController.signal)
      await vi.waitFor(() => expect(connections).toHaveLength(1))
      abortController.abort(reason)
      await expect(firstResponse).rejects.toBe(reason)
      expect(firstSignal?.aborted).toBe(true)
      expect(connections[0].closed).toBe(true)
      expect(connections[0].sent).toHaveLength(0)
      resolveFirst()

      const secondResponse = await request()
      await vi.waitFor(() => expect(connections).toHaveLength(2))
      connections[1].emitMessage(JSON.stringify({ type: 'response.completed' }))
      await secondResponse.text()
    } finally {
      wsFetch.close()
    }
  })

  it('retires a connected socket when its request is aborted', async () => {
    const connections: MockWebSocketConnection[] = []
    const wsFetch = createMixlayerWebSocketFetch({
      connect: async () => {
        const connection = new MockWebSocketConnection()
        connections.push(connection)
        return connection
      },
    })
    const request = (signal?: AbortSignal) =>
      wsFetch('https://models.mixlayer.ai/v1/responses', {
        method: 'POST',
        headers: { Authorization: 'Bearer first-test-key' },
        body: JSON.stringify({ model: 'qwen/qwen3.5-9b', input: [], stream: true }),
        signal,
      })

    try {
      const abortController = new AbortController()
      const reason = new Error('connected abort')
      const firstResponse = await request(abortController.signal)
      const firstBody = firstResponse.text()
      await vi.waitFor(() => expect(connections[0]?.sent).toHaveLength(1))
      abortController.abort(reason)
      await expect(firstBody).rejects.toBe(reason)
      expect(connections[0].closed).toBe(true)

      const secondResponse = await request()
      await vi.waitFor(() => expect(connections).toHaveLength(2))
      connections[1].emitMessage(JSON.stringify({ type: 'response.completed' }))
      await secondResponse.text()
    } finally {
      wsFetch.close()
    }
  })

  it('lets WebSocket option headers override the request user agent', async () => {
    let socket: MockWebSocketConnection | undefined
    const wsFetch = createMixlayerWebSocketFetch({
      headers: { 'User-Agent': 'custom-mixlayer-ws-client' },
      connect: async ({ url, headers }: MixlayerWebSocketConnectOptions) => {
        socket = new MockWebSocketConnection(url, headers)
        return socket
      },
    })

    try {
      const response = await wsFetch('https://models.mixlayer.ai/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-key',
          'User-Agent': 'ai-sdk/openai/4.0.0 ai-sdk/provider-utils/5.0.0',
        },
        body: JSON.stringify({
          model: 'qwen/qwen3.5-9b',
          input: [],
          stream: true,
          store: false,
        }),
      })

      await vi.waitFor(() => expect(socket?.sent).toHaveLength(1))
      expect(socket?.headers['User-Agent']).toBe('custom-mixlayer-ws-client')

      socket?.emitMessage(JSON.stringify({ type: 'response.completed', response: { id: 'resp_1' } }))
      expect(await response.text()).toContain('data: [DONE]')
    } finally {
      wsFetch.close()
    }
  })

  it('uses fetch WebSocket upgrades by default for Workers-compatible runtimes', async () => {
    const connection = new MockWebSocketConnection()
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const wsFetch = createMixlayerWebSocketFetch({
      url: 'wss://models.mixlayer.ai/v1/responses',
      fetch: async (input, init) => {
        calls.push({ input, init })
        return createWebSocketResponse(connection)
      },
    })

    try {
      const response = await wsFetch('https://models.mixlayer.ai/v1/responses', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-key' },
        body: JSON.stringify({
          model: 'qwen/qwen3.5-9b',
          input: 'hello',
          stream: true,
          store: false,
        }),
      })

      await vi.waitFor(() => expect(connection.sent).toHaveLength(1))
      expect(calls).toHaveLength(1)
      expect(calls[0].input).toBe('https://models.mixlayer.ai/v1/responses')
      expect(new Headers(calls[0].init?.headers).get('upgrade')).toBe('websocket')
      expect(new Headers(calls[0].init?.headers).get('authorization')).toBe('Bearer test-key')
      expect(new Headers(calls[0].init?.headers).get('openai-beta')).toBe(
        MIXLAYER_RESPONSES_WEBSOCKET_BETA
      )
      expect(connection.accepted).toBe(true)
      expect(connection.binaryType).toBe('arraybuffer')

      connection.emitMessage(JSON.stringify({ type: 'response.completed', response: { id: 'resp_1' } }))
      expect(await response.text()).toContain('data: [DONE]')
    } finally {
      wsFetch.close()
    }
  })

  it('falls back to fetch for non-streaming Responses API requests', async () => {
    const wsFetch = createMixlayerWebSocketFetch({
      fetch: async () => new Response('fallback-ok', { status: 201 }),
    })

    const response = await wsFetch('https://models.mixlayer.ai/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'qwen/qwen3.5-9b', input: [], stream: false }),
    })

    expect(response.status).toBe(201)
    expect(await response.text()).toBe('fallback-ok')
  })

  it('closes and rejects a socket that resolves after close() during handshake', async () => {
    let resolveConnect!: () => void
    let pendingConnection!: MockWebSocketConnection
    const connect = vi.fn(
      ({ onSocket }: MixlayerWebSocketConnectOptions) =>
        new Promise<MixlayerWebSocketConnection>(resolve => {
          pendingConnection = new MockWebSocketConnection()
          onSocket?.(pendingConnection)
          resolveConnect = () => resolve(pendingConnection)
        })
    )
    const wsFetch = createMixlayerWebSocketFetch({ connect })

    const responsePromise = wsFetch('https://models.mixlayer.ai/v1/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key' },
      body: JSON.stringify({ model: 'qwen/qwen3.5-9b', input: [], stream: true }),
    })

    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1))
    wsFetch.close()
    expect(pendingConnection.closed).toBe(true)
    resolveConnect()

    await expect(responsePromise).rejects.toThrow(/WebSocket closed|AbortError/)
    expect(pendingConnection.closed).toBe(true)
  })

  it('releases the request queue after a connection failure', async () => {
    let calls = 0
    const connection = new MockWebSocketConnection()
    const wsFetch = createMixlayerWebSocketFetch({
      connect: async () => {
        calls++
        if (calls === 1) throw new Error('connect failed')
        return connection
      },
    })

    const requestInit = {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key' },
      body: JSON.stringify({ model: 'qwen/qwen3.5-9b', input: [], stream: true }),
    }

    await expect(
      wsFetch('https://models.mixlayer.ai/v1/responses', requestInit)
    ).rejects.toThrow('connect failed')

    const response = await wsFetch('https://models.mixlayer.ai/v1/responses', requestInit)
    connection.emitMessage(JSON.stringify({ type: 'response.completed', response: { id: 'resp_1' } }))

    expect(calls).toBe(2)
    expect(await response.text()).toContain('data: [DONE]')
  })
})
