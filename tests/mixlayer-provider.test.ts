import { describe, it, expect } from 'vitest'
import {
  createMixlayer,
  mixlayer,
  extractMixlayerModelId,
  getMixlayerSamplingDefaults,
  isQwen35Or36,
  applyQwenSamplingDefaults,
  MIXLAYER_DEFAULT_BASE_URL,
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
    expect(defaults.extraBody.chat_template_kwargs).toEqual({ enable_thinking: false })
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
    expect(out.min_p).toBe(0)
    expect(out.repetition_penalty).toBe(1.0)
  })

  it('injects the non-thinking defaults (enable_thinking: false) when thinking=false', () => {
    const out = applyQwenSamplingDefaults({ model: 'qwen/qwen3.6-27b', messages: [] }, false)
    expect(out.temperature).toBe(MIXLAYER_NON_THINKING_DEFAULTS.temperature)
    expect(out.chat_template_kwargs).toEqual({ enable_thinking: false })
  })

  it('lets caller-set request values override the defaults', () => {
    const out = applyQwenSamplingDefaults({ model: 'qwen/qwen3.5-9b', temperature: 0, top_p: 0.1 })
    expect(out.temperature).toBe(0)
    expect(out.top_p).toBe(0.1)
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
    expect(typeof provider.chatModel).toBe('function')
  })

  it('builds a wrapped language model for a prefixed id', () => {
    const provider = createMixlayer({ apiKey: 'test' })
    const model = provider('mixlayer/qwen/qwen3.5-9b')
    expect(model).toBeDefined()
    // wrapLanguageModel produces a spec-versioned language model
    expect((model as { specificationVersion?: string }).specificationVersion).toMatch(/^v\d+$/)
  })

  it('the default provider instance is usable', () => {
    expect(typeof mixlayer).toBe('function')
    expect(mixlayer('qwen/qwen3.5-9b')).toBeDefined()
  })

  it('exposes the default base URL constant', () => {
    expect(MIXLAYER_DEFAULT_BASE_URL).toBe('https://models.mixlayer.ai/v1')
  })
})
