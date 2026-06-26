import { generateText } from 'ai'
import { describe, it, expect, vi } from 'vitest'

import {
  createMixlayer,
  mixlayer,
  createMixlayerWebSocketFetch,
  extractMixlayerModelId,
  getMixlayerResponsesWebSocketURL,
  getMixlayerSamplingDefaults,
  isQwen35Or36,
  applyQwenSamplingDefaults,
  MIXLAYER_DEFAULT_BASE_URL,
  MIXLAYER_DEFAULT_RESPONSES_WEBSOCKET_URL,
  MIXLAYER_RESPONSES_WEBSOCKET_BETA,
  MIXLAYER_THINKING_DEFAULTS,
  MIXLAYER_NON_THINKING_DEFAULTS,
  type MixlayerWebSocketConnectOptions,
  type MixlayerWebSocketConnection,
} from '../src/index'

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
}

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

describe('getMixlayerSamplingDefaults', () => {
  it('returns thinking defaults by default', () => {
    expect(getMixlayerSamplingDefaults(true)).toBe(MIXLAYER_THINKING_DEFAULTS)
  })

  it('returns non-thinking defaults and disables thinking in extraBody', () => {
    const defaults = getMixlayerSamplingDefaults(false)
    expect(defaults).toBe(MIXLAYER_NON_THINKING_DEFAULTS)
    expect(defaults.extraBody.thinking).toBe(false)
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

describe('applyQwenSamplingDefaults', () => {
  it('injects the thinking defaults for a Qwen 3.5 / 3.6 model', () => {
    const out = applyQwenSamplingDefaults({ model: 'qwen/qwen3.5-9b', messages: [] })
    expect(out.temperature).toBe(MIXLAYER_THINKING_DEFAULTS.temperature)
    expect(out.top_p).toBe(MIXLAYER_THINKING_DEFAULTS.topP)
    expect(out.top_k).toBe(MIXLAYER_THINKING_DEFAULTS.topK)
    expect(out.presence_penalty).toBe(MIXLAYER_THINKING_DEFAULTS.presencePenalty)
    expect(out.thinking).toBe(true)
    expect(out.repetition_penalty).toBe(1.0)
    expect(out).not.toHaveProperty('min_p')
  })

  it('injects the non-thinking defaults (thinking: false) when thinking=false', () => {
    const out = applyQwenSamplingDefaults({ model: 'qwen/qwen3.6-27b', messages: [] }, false)
    expect(out.temperature).toBe(MIXLAYER_NON_THINKING_DEFAULTS.temperature)
    expect(out.thinking).toBe(false)
  })

  it('lets caller-set request values override the defaults', () => {
    const out = applyQwenSamplingDefaults({ model: 'qwen/qwen3.5-9b', temperature: 0, top_p: 0.1 })
    expect(out.temperature).toBe(0)
    expect(out.top_p).toBe(0.1)
  })

  it('does not let undefined AI SDK call settings erase defaults', () => {
    const out = applyQwenSamplingDefaults({
      model: 'qwen/qwen3.5-9b',
      temperature: undefined,
      top_p: undefined,
      presence_penalty: undefined,
    })
    expect(out.temperature).toBe(MIXLAYER_THINKING_DEFAULTS.temperature)
    expect(out.top_p).toBe(MIXLAYER_THINKING_DEFAULTS.topP)
    expect(out.presence_penalty).toBe(MIXLAYER_THINKING_DEFAULTS.presencePenalty)
  })

  it('leaves later-Qwen and other-family models untouched', () => {
    const future = { model: 'qwen/qwen3.7-27b', messages: [] }
    expect(applyQwenSamplingDefaults(future)).toBe(future)
    const kimi = { model: 'kimi-k2-instruct', messages: [] }
    expect(applyQwenSamplingDefaults(kimi)).toBe(kimi)
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
        headers: { Authorization: 'Bearer test-key' },
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
    let resolveConnect!: (connection: MockWebSocketConnection) => void
    const connect = vi.fn(
      () =>
        new Promise<MixlayerWebSocketConnection>(resolve => {
          resolveConnect = resolve
        })
    )
    const wsFetch = createMixlayerWebSocketFetch({ connect })

    const responsePromise = wsFetch('https://models.mixlayer.ai/v1/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key' },
      body: JSON.stringify({ model: 'qwen/qwen3.5-9b', input: [], stream: true }),
    })

    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1))
    const connection = new MockWebSocketConnection()
    wsFetch.close()
    resolveConnect(connection)

    await expect(responsePromise).rejects.toThrow(/WebSocket closed|AbortError/)
    expect(connection.closed).toBe(true)
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
