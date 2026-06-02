import { describe, it, expect, vi } from 'vitest'
import {
  createMixlayer,
  mixlayer,
  createMixlayerFetch,
  extractMixlayerModelId,
  getMixlayerSamplingDefaults,
  MIXLAYER_DEFAULT_BASE_URL,
  MIXLAYER_THINKING_DEFAULTS,
  MIXLAYER_NON_THINKING_DEFAULTS,
} from '../src/index'

describe('extractMixlayerModelId', () => {
  it('strips the mixlayer/ prefix', () => {
    expect(extractMixlayerModelId('mixlayer/qwen/qwen3-8b')).toBe('qwen/qwen3-8b')
  })

  it('strips the mixlayer: prefix (case-insensitive) and trims', () => {
    expect(extractMixlayerModelId('  Mixlayer:qwen/qwen3-8b ')).toBe('qwen/qwen3-8b')
  })

  it('returns bare ids unchanged', () => {
    expect(extractMixlayerModelId('qwen/qwen3-8b')).toBe('qwen/qwen3-8b')
  })
})

describe('getMixlayerSamplingDefaults', () => {
  it('returns thinking defaults by default', () => {
    expect(getMixlayerSamplingDefaults(true)).toBe(MIXLAYER_THINKING_DEFAULTS)
  })

  it('returns non-thinking defaults and disables thinking in extraBody', () => {
    const defaults = getMixlayerSamplingDefaults(false)
    expect(defaults).toBe(MIXLAYER_NON_THINKING_DEFAULTS)
    expect(defaults.extraBody.chat_template_kwargs).toEqual({ enable_thinking: false })
  })
})

describe('createMixlayerFetch', () => {
  it('returns the base fetch unchanged when gateway routing is off', () => {
    const base = vi.fn() as unknown as typeof fetch
    expect(createMixlayerFetch(base)).toBe(base)
    expect(createMixlayerFetch(base, { viaCfGateway: false, cfGatewayToken: 't' })).toBe(base)
  })

  it('returns the base fetch unchanged when no token is supplied', () => {
    const base = vi.fn() as unknown as typeof fetch
    expect(createMixlayerFetch(base, { viaCfGateway: true })).toBe(base)
  })

  it('adds the cf-aig-authorization header when routing through the gateway', async () => {
    const base = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('ok'))
    const wrapped = createMixlayerFetch(base as unknown as typeof fetch, {
      viaCfGateway: true,
      cfGatewayToken: 'secret-token',
    })
    await wrapped('https://models.mixlayer.ai/v1/chat/completions', {
      headers: { 'content-type': 'application/json' },
    })
    expect(base).toHaveBeenCalledTimes(1)
    const init = base.mock.calls[0][1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get('cf-aig-authorization')).toBe('Bearer secret-token')
    // existing headers are preserved
    expect(headers.get('content-type')).toBe('application/json')
  })
})

describe('createMixlayer', () => {
  it('exposes a callable provider with languageModel/chatModel accessors', () => {
    const provider = createMixlayer({ apiKey: 'test' })
    expect(typeof provider).toBe('function')
    expect(typeof provider.languageModel).toBe('function')
    expect(typeof provider.chatModel).toBe('function')
  })

  it('builds a wrapped language model for a prefixed id', () => {
    const provider = createMixlayer({ apiKey: 'test' })
    const model = provider('mixlayer/qwen/qwen3-8b')
    expect(model).toBeDefined()
    // wrapLanguageModel produces a spec-versioned language model
    expect((model as { specificationVersion?: string }).specificationVersion).toMatch(/^v\d+$/)
  })

  it('the default provider instance is usable', () => {
    expect(typeof mixlayer).toBe('function')
    expect(mixlayer('qwen/qwen3-8b')).toBeDefined()
  })

  it('exposes the default base URL constant', () => {
    expect(MIXLAYER_DEFAULT_BASE_URL).toBe('https://models.mixlayer.ai/v1')
  })
})
