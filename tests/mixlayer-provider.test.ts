import { describe, it, expect, vi } from 'vitest'

const wsMock = vi.hoisted(() => ({
  instances: [] as Array<{
    url: string
    options: { headers?: Record<string, string> }
    readyState: number
    sent: string[]
    send(data: string, callback?: (error?: Error) => void): void
    close(): void
    emit(event: string, ...args: unknown[]): boolean
  }>,
}))

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events')

  class MockWebSocket extends EventEmitter {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3

    readyState = MockWebSocket.CONNECTING
    sent: string[] = []

    constructor(
      readonly url: string,
      readonly options: { headers?: Record<string, string> } = {}
    ) {
      super()
      wsMock.instances.push(this)
      queueMicrotask(() => {
        this.readyState = MockWebSocket.OPEN
        this.emit('open')
      })
    }

    send(data: string, callback?: (error?: Error) => void) {
      this.sent.push(data)
      callback?.()
    }

    close() {
      this.readyState = MockWebSocket.CLOSED
      this.emit('close')
    }
  }

  return { default: MockWebSocket }
})

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
} from '../src/index'

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
    wsMock.instances.length = 0
    const wsFetch = createMixlayerWebSocketFetch({
      url: 'ws://127.0.0.1:8787/v1/responses',
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

      await vi.waitFor(() => expect(wsMock.instances).toHaveLength(1))
      const socket = wsMock.instances[0]
      await vi.waitFor(() => expect(socket.sent).toHaveLength(1))

      expect(socket.url).toBe('ws://127.0.0.1:8787/v1/responses')
      expect(socket.options.headers?.Authorization).toBe('Bearer test-key')
      expect(socket.options.headers?.['OpenAI-Beta']).toBe(MIXLAYER_RESPONSES_WEBSOCKET_BETA)
      expect(JSON.parse(socket.sent[0]) as unknown).toEqual({
        type: 'response.create',
        model: 'qwen/qwen3.5-9b',
        input: [],
        store: false,
      })

      socket.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' }))
      )
      socket.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'response.completed', response: { id: 'resp_1' } }))
      )

      const text = await response.text()
      expect(text).toContain('data: {"type":"response.output_text.delta","delta":"hi"}')
      expect(text).toContain('data: [DONE]')
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
})
