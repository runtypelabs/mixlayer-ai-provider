// mixlayer-ai-provider — an AI SDK provider for Mixlayer.
//
// Mixlayer serves the open-weight Qwen family over an OpenAI-compatible
// inference API at https://models.mixlayer.ai/v1. This package
// wraps `@ai-sdk/openai-compatible` with everything that makes Mixlayer behave
// correctly out of the box:
//
//   - the Mixlayer base URL default
//   - the official Qwen open-weight sampling defaults (thinking / non-thinking)
//   - reasoning middleware that extracts `<think>` tags into AI SDK reasoning
//     parts (the provider also emits native `reasoning_content`)
//   - an optional Cloudflare AI Gateway fetch wrapper
//   - tolerant model-id handling (strips a leading `mixlayer/` prefix)
//
// Usage mirrors any other AI SDK provider:
//
//   import { mixlayer } from 'mixlayer-ai-provider'
//   import { streamText } from 'ai'
//
//   const result = streamText({
//     model: mixlayer('qwen/qwen3-8b'),
//     prompt: 'Hello',
//   })
//
//   // or with explicit settings / non-thinking sampling:
//   const provider = createMixlayer({ apiKey, thinking: false })

import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { wrapLanguageModel, extractReasoningMiddleware, type LanguageModel } from 'ai'

/** Default Mixlayer OpenAI-compatible inference endpoint. */
export const MIXLAYER_DEFAULT_BASE_URL = 'https://models.mixlayer.ai/v1'

/**
 * Official Qwen open-weight sampling defaults (from the HuggingFace model
 * cards). These are the same across all open-weight Qwen sizes (9B / 27B /
 * 35B-A3B / 122B-A10B / 397B-A17B) and stable across the 3.5 / 3.6
 * generations. Mixlayer only serves the open-weight Qwen family, so these
 * defaults apply to every model handled by this provider.
 *
 * Qwen thinks by default. To disable thinking we send
 * `chat_template_kwargs: { enable_thinking: false }` (the vLLM convention).
 *
 * `extraBody` is merged into every request body via `transformRequestBody`.
 * The scalar fields (`temperature`, `topP`, `topK`, `presencePenalty`) are
 * exposed so callers that build their own `streamText`/`generateText` params
 * can use them as fallbacks.
 */
export const MIXLAYER_THINKING_DEFAULTS = {
  temperature: 1.0,
  topP: 0.95,
  topK: 20,
  presencePenalty: 1.5,
  extraBody: { min_p: 0, repetition_penalty: 1.0 } as Record<string, unknown>,
} as const

export const MIXLAYER_NON_THINKING_DEFAULTS = {
  temperature: 0.7,
  topP: 0.8,
  topK: 20,
  presencePenalty: 1.5,
  extraBody: {
    min_p: 0,
    repetition_penalty: 1.0,
    chat_template_kwargs: { enable_thinking: false },
  } as Record<string, unknown>,
} as const

export type MixlayerSamplingDefaults =
  | typeof MIXLAYER_THINKING_DEFAULTS
  | typeof MIXLAYER_NON_THINKING_DEFAULTS

/** Returns the Qwen sampling defaults for the given thinking mode. */
export function getMixlayerSamplingDefaults(thinking: boolean): MixlayerSamplingDefaults {
  return thinking ? MIXLAYER_THINKING_DEFAULTS : MIXLAYER_NON_THINKING_DEFAULTS
}

/**
 * Strips a leading `mixlayer/` (or `mixlayer:`) prefix from a model id so
 * callers can pass either the bare upstream id (`qwen/qwen3-8b`) or a
 * routed/prefixed id (`mixlayer/qwen/qwen3-8b`). Anything without a recognized
 * prefix is returned unchanged.
 */
export function extractMixlayerModelId(model: string): string {
  const trimmed = model.trim()
  return trimmed.replace(/^mixlayer[/:]/i, '')
}

/** Cloudflare AI Gateway options for routing Mixlayer through the gateway. */
export interface MixlayerGatewayOptions {
  /** Route requests through the Cloudflare AI Gateway. */
  viaCfGateway?: boolean
  /**
   * Gateway authorization token. In production Cloudflare Workers, Worker
   * identity handles gateway auth automatically and this is unnecessary; it is
   * only needed for local dev (wrangler/bun) where Worker identity isn't
   * available.
   */
  cfGatewayToken?: string
}

/**
 * Returns a fetch wrapper that adds the Cloudflare AI Gateway authorization
 * header when routing Mixlayer through the gateway. When gateway routing is
 * disabled (or no token is supplied) the base fetch is returned unchanged.
 */
export function createMixlayerFetch(
  baseFetch: typeof fetch,
  gateway?: MixlayerGatewayOptions
): typeof fetch {
  if (!gateway?.viaCfGateway) return baseFetch
  const token = gateway.cfGatewayToken
  if (!token) return baseFetch
  const withAuth = (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const headers = new Headers((init?.headers as HeadersInit | undefined) ?? {})
    headers.set('cf-aig-authorization', `Bearer ${token}`)
    return baseFetch(url, { ...init, headers })
  }
  return withAuth as typeof fetch
}

/** Settings for {@link createMixlayer}. */
export interface MixlayerProviderSettings {
  /** Mixlayer API key. */
  apiKey?: string
  /** Override the inference base URL (defaults to {@link MIXLAYER_DEFAULT_BASE_URL}). */
  baseURL?: string
  /** Extra headers to send with every request. */
  headers?: Record<string, string>
  /** Custom fetch implementation (e.g. an instrumented or proxied fetch). */
  fetch?: typeof fetch
  /** Cloudflare AI Gateway routing options. */
  gateway?: MixlayerGatewayOptions
  /**
   * Whether to apply the Qwen *thinking* sampling defaults. When `false`, the
   * non-thinking defaults are used (including `enable_thinking: false`).
   * Defaults to `true` — Qwen thinks by default.
   */
  thinking?: boolean
}

/**
 * A Mixlayer provider. Callable directly (`mixlayer(modelId)`) and via the
 * standard AI SDK accessors (`.languageModel` / `.chatModel`).
 */
export interface MixlayerProvider {
  (modelId: string): LanguageModel
  languageModel(modelId: string): LanguageModel
  chatModel(modelId: string): LanguageModel
}

/**
 * Creates a Mixlayer provider backed by `@ai-sdk/openai-compatible`, with the
 * Qwen sampling defaults baked into the request body and `<think>`-tag
 * reasoning extraction wrapped around every model.
 */
export function createMixlayer(settings: MixlayerProviderSettings = {}): MixlayerProvider {
  const thinking = settings.thinking ?? true
  const defaults = getMixlayerSamplingDefaults(thinking)
  const baseFetch = settings.fetch ?? globalThis.fetch.bind(globalThis)

  const openaiCompatible = createOpenAICompatible({
    name: 'mixlayer',
    apiKey: settings.apiKey,
    baseURL: settings.baseURL ?? MIXLAYER_DEFAULT_BASE_URL,
    headers: settings.headers,
    fetch: createMixlayerFetch(baseFetch, settings.gateway),
    transformRequestBody: (body: Record<string, unknown>) => ({
      ...body,
      ...defaults.extraBody,
    }),
  })

  const createModel = (modelId: string): LanguageModel => {
    const resolved = extractMixlayerModelId(modelId)
    // The provider natively emits `reasoning_content`; the middleware handles
    // `<think>` tags so both paths surface as AI SDK reasoning parts.
    return wrapLanguageModel({
      model: openaiCompatible.chatModel(resolved),
      middleware: extractReasoningMiddleware({ tagName: 'think' }),
    })
  }

  const provider = ((modelId: string) => createModel(modelId)) as MixlayerProvider
  provider.languageModel = createModel
  provider.chatModel = createModel
  return provider
}

/** Default Mixlayer provider instance (thinking mode, env-free). */
export const mixlayer: MixlayerProvider = createMixlayer()
