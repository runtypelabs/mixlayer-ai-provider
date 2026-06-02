// @runtypelabs/mixlayer-ai-provider — an AI SDK provider for Mixlayer.
//
// Mixlayer serves open-weight models over an OpenAI-compatible inference API at
// https://models.mixlayer.ai/v1. Today the catalog is the Qwen 3.5 / 3.6 family,
// but Mixlayer is expected to add other open-weight families (e.g. Kimi) over
// time — so this provider is model-family-agnostic and only layers
// family-specific sampling defaults on models it recognizes.
//
// It wraps `@ai-sdk/openai-compatible` with everything that makes Mixlayer
// behave correctly out of the box:
//
//   - the Mixlayer base URL default
//   - family-specific sampling defaults (currently the Qwen 3.5 / 3.6 defaults,
//     thinking / non-thinking)
//   - reasoning middleware that extracts `<think>` tags into AI SDK reasoning
//     parts (the provider also emits native `reasoning_content`)
//   - an optional Cloudflare AI Gateway fetch wrapper
//   - tolerant model-id handling (strips a leading `mixlayer/` prefix)
//
// Usage mirrors any other AI SDK provider:
//
//   import { mixlayer } from '@runtypelabs/mixlayer-ai-provider'
//   import { streamText } from 'ai'
//
//   const result = streamText({
//     model: mixlayer('qwen/qwen3.5-9b'),
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
 * Recommended Qwen open-weight sampling defaults. These are the same across the
 * open-weight Qwen sizes Mixlayer serves (4B / 9B / 27B / 35B-A3B / 397B-A17B)
 * and stable across the **3.5 and 3.6** generations.
 *
 * Source: the official Qwen HuggingFace model cards' "recommended sampling
 * parameters for generation", e.g.
 * https://huggingface.co/Qwen/Qwen3.6-35B-A3B#:~:text=We%20recommend%20using%20the%20following%20set%20of%20sampling%20parameters%20for%20generation
 *
 * The provider applies them automatically, but ONLY to Qwen 3.5 / 3.6 models
 * (see {@link isQwen35Or36}). Future Qwen generations and any other model family
 * pass through untouched, and any value the caller sets on the request wins
 * (the defaults are overridable per call).
 *
 * Qwen thinks by default. To disable thinking we send
 * `chat_template_kwargs: { enable_thinking: false }` (the vLLM convention).
 *
 * `extraBody` carries the vLLM-specific fields. The scalar fields
 * (`temperature`, `topP`, `topK`, `presencePenalty`) are also exposed so
 * callers that build their own `streamText`/`generateText` params can reuse
 * them as fallbacks.
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
 * Whether a model id is a Qwen **3.5 or 3.6** model — the generations the
 * bundled sampling defaults are tuned for. Later Qwen generations (3.7+) and
 * other model families return `false`, so they receive vanilla
 * OpenAI-compatible behavior with no injected defaults.
 *
 * Matches the dotted ids Mixlayer uses (`qwen/qwen3.5-27b`, `qwen/qwen3.6-35b-a3b`),
 * with or without the `qwen/` org segment, and tolerates a dash form
 * (`qwen3-5-9b`) too. The minor version must be followed by a separator or the
 * end of the id, so a bare size token like `qwen3-5b` is not misread as 3.5.
 */
export function isQwen35Or36(modelId: string): boolean {
  return /qwen-?3[.-][56](?![0-9a-z])/i.test(modelId)
}

/**
 * Returns `body` with the Qwen sampling defaults applied — but only when
 * `body.model` is a Qwen 3.5 / 3.6 model ({@link isQwen35Or36}). Defaults are
 * spread first and the original `body` last, so any value the caller already
 * set on the request takes precedence (the defaults are overridable per call).
 * Models from other families and later Qwen generations are returned unchanged.
 *
 * This is the Qwen-family helper; other model families Mixlayer adds in future
 * (e.g. Kimi) would get their own scoped helper alongside this one.
 */
export function applyQwenSamplingDefaults(
  body: Record<string, unknown>,
  thinking = true
): Record<string, unknown> {
  const modelId = typeof body.model === 'string' ? body.model : ''
  if (!isQwen35Or36(modelId)) return body
  const defaults = getMixlayerSamplingDefaults(thinking)
  // Body keys use the OpenAI/vLLM snake_case wire format.
  return {
    temperature: defaults.temperature,
    top_p: defaults.topP,
    top_k: defaults.topK,
    presence_penalty: defaults.presencePenalty,
    ...defaults.extraBody,
    ...body,
  }
}

/**
 * Strips a leading `mixlayer/` (or `mixlayer:`) prefix from a model id so
 * callers can pass either the bare upstream id (`qwen/qwen3.5-9b`) or a
 * routed/prefixed id (`mixlayer/qwen/qwen3.5-9b`). The model's own org segment
 * (e.g. `qwen/`) is preserved; anything without a recognized prefix is returned
 * unchanged.
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

/**
 * Resolves the Mixlayer API key. Falls back to the `MIXLAYER_API_KEY`
 * environment variable when no explicit key is supplied. The `process` guard
 * keeps this safe in non-Node runtimes (e.g. Cloudflare Workers, the browser),
 * where you pass `apiKey` explicitly instead.
 */
function resolveMixlayerApiKey(explicit?: string): string | undefined {
  if (explicit) return explicit
  if (typeof process !== 'undefined' && process.env) return process.env.MIXLAYER_API_KEY
  return undefined
}

/** Settings for {@link createMixlayer}. */
export interface MixlayerProviderSettings {
  /**
   * Mixlayer API key. Defaults to the `MIXLAYER_API_KEY` environment variable
   * when omitted (Node only — pass it explicitly in Workers / the browser).
   */
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
 * Known Mixlayer chat model ids (current catalog). The `(string & {})` member
 * keeps the union open: Mixlayer adds models over time and is expected to serve
 * non-Qwen families (e.g. Kimi) in future, so any model id string is accepted —
 * the listed ids just provide editor autocomplete.
 */
export type MixlayerChatModelId =
  | 'qwen/qwen3.5-4b-free'
  | 'qwen/qwen3.5-9b'
  | 'qwen/qwen3.5-27b'
  | 'qwen/qwen3.5-35b-a3b'
  | 'qwen/qwen3.5-397b-a17b'
  | 'qwen/qwen3.6-27b'
  | 'qwen/qwen3.6-35b-a3b'
  // eslint-disable-next-line @typescript-eslint/ban-types -- open-union autocomplete idiom
  | (string & {})

/**
 * A Mixlayer provider. Callable directly (`mixlayer(modelId)`) and via the
 * standard AI SDK accessors. Works with `createProviderRegistry` for language
 * models. (Mixlayer is text-generation only today — no embedding models.)
 */
export interface MixlayerProvider {
  (modelId: MixlayerChatModelId): LanguageModel
  languageModel(modelId: MixlayerChatModelId): LanguageModel
  chatModel(modelId: MixlayerChatModelId): LanguageModel
}

/**
 * Creates a Mixlayer provider backed by `@ai-sdk/openai-compatible`, with the
 * Qwen sampling defaults baked into the request body (scoped to Qwen 3.5 / 3.6)
 * and `<think>`-tag reasoning extraction wrapped around every chat model.
 */
export function createMixlayer(settings: MixlayerProviderSettings = {}): MixlayerProvider {
  const thinking = settings.thinking ?? true
  const baseFetch = settings.fetch ?? globalThis.fetch.bind(globalThis)

  const openaiCompatible = createOpenAICompatible({
    name: 'mixlayer',
    apiKey: resolveMixlayerApiKey(settings.apiKey),
    baseURL: settings.baseURL ?? MIXLAYER_DEFAULT_BASE_URL,
    headers: settings.headers,
    fetch: createMixlayerFetch(baseFetch, settings.gateway),
    // Layer in family-specific sampling defaults. Today that's the Qwen 3.5 /
    // 3.6 family only; other families pass through, and any value the caller
    // set on the request wins (overridable per call).
    transformRequestBody: (body: Record<string, unknown>) =>
      applyQwenSamplingDefaults(body, thinking),
  })

  const createModel = (modelId: MixlayerChatModelId): LanguageModel => {
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

/**
 * Default Mixlayer provider instance. Reads `MIXLAYER_API_KEY` from the
 * environment (Node); construct your own with {@link createMixlayer} to set the
 * key or other options explicitly.
 */
export const mixlayer: MixlayerProvider = createMixlayer()
