import { describe, it, expect, vi } from 'vitest'
import {
  createMixlayer,
  mixlayer,
  createMixlayerFetch,
  extractMixlayerModelId,
  getMixlayerSamplingDefaults,
  isQwen35Or36,
  applyQwenSamplingDefaults,
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

describe('isQwen35Or36', () => {
  it('matches Qwen 3.5 / 3.6 open-weight ids (dash form, with or without org)', () => {
    for (const id of [
      'qwen3-5-9b',
      'qwen3-5-35b-a3b',
      'qwen3-5-397b-a17b',
      'qwen3-6-27b',
      'qwen3-6-35b-a3b',
      'qwen/qwen3-5-9b',
      'mixlayer/qwen/qwen3-6-27b',
    ]) {
      expect(isQwen35Or36(id)).toBe(true)
    }
  })

  it('matches the dotted form too', () => {
    expect(isQwen35Or36('qwen3.5-9b')).toBe(true)
    expect(isQwen35Or36('qwen-3.6-27b')).toBe(true)
  })

  it('does NOT match other Qwen 3 generations', () => {
    for (const id of [
      'qwen3-32b', // Qwen3 (3.0) 32B
      'qwen3-30b-a3b',
      'qwen3-235b-a22b',
      'qwen-3-14b',
      'qwen3-7-max', // 3.7 — future generation
      'qwen3-7-plus',
    ]) {
      expect(isQwen35Or36(id)).toBe(false)
    }
  })

  it('does NOT mistake a 5B/6B size token for a 3.5/3.6 minor version', () => {
    expect(isQwen35Or36('qwen3-5b')).toBe(false)
    expect(isQwen35Or36('qwen3-6b')).toBe(false)
    expect(isQwen35Or36('qwen3-50b')).toBe(false)
  })

  it('does NOT match non-Qwen models', () => {
    for (const id of ['gpt-4', 'claude-sonnet-4-6', 'llama-3.5-8b', 'gemini-3-flash']) {
      expect(isQwen35Or36(id)).toBe(false)
    }
  })
})

describe('applyQwenSamplingDefaults', () => {
  it('injects the thinking defaults for a Qwen 3.5 / 3.6 model', () => {
    const out = applyQwenSamplingDefaults({ model: 'qwen3-5-9b', messages: [] })
    expect(out.temperature).toBe(MIXLAYER_THINKING_DEFAULTS.temperature)
    expect(out.top_p).toBe(MIXLAYER_THINKING_DEFAULTS.topP)
    expect(out.top_k).toBe(MIXLAYER_THINKING_DEFAULTS.topK)
    expect(out.presence_penalty).toBe(MIXLAYER_THINKING_DEFAULTS.presencePenalty)
    expect(out.min_p).toBe(0)
    expect(out.repetition_penalty).toBe(1.0)
  })

  it('injects the non-thinking defaults (enable_thinking: false) when thinking=false', () => {
    const out = applyQwenSamplingDefaults({ model: 'qwen3-6-27b', messages: [] }, false)
    expect(out.temperature).toBe(MIXLAYER_NON_THINKING_DEFAULTS.temperature)
    expect(out.chat_template_kwargs).toEqual({ enable_thinking: false })
  })

  it('lets caller-set request values override the defaults', () => {
    const out = applyQwenSamplingDefaults({ model: 'qwen3-5-9b', temperature: 0, top_p: 0.1 })
    expect(out.temperature).toBe(0)
    expect(out.top_p).toBe(0.1)
  })

  it('leaves future-Qwen and non-Qwen models untouched', () => {
    const future = { model: 'qwen3-7-max', messages: [] }
    expect(applyQwenSamplingDefaults(future)).toBe(future)
    const other = { model: 'gpt-4', messages: [] }
    expect(applyQwenSamplingDefaults(other)).toBe(other)
    const sizeToken = { model: 'qwen3-5b', messages: [] }
    expect(applyQwenSamplingDefaults(sizeToken)).toBe(sizeToken)
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

  it('exposes a text-embedding model (registry-compatible shape)', () => {
    const provider = createMixlayer({ apiKey: 'test' })
    expect(typeof provider.textEmbeddingModel).toBe('function')
    const embedding = provider.textEmbeddingModel('qwen3-embedding-8b')
    expect(embedding).toBeDefined()
    expect((embedding as { specificationVersion?: string }).specificationVersion).toMatch(/^v\d+$/)
  })

  it('exposes the default base URL constant', () => {
    expect(MIXLAYER_DEFAULT_BASE_URL).toBe('https://models.mixlayer.ai/v1')
  })
})
