// @runtypelabs/mixlayer-ai-provider — an AI SDK provider for Mixlayer.
//
// Mixlayer serves open-weight models over an OpenAI-compatible inference API at
// https://models.mixlayer.ai/v1. Today the catalog is the Qwen 3.5 / 3.6 family,
// but Mixlayer is expected to add other open-weight families (e.g. Kimi) over
// time — so this provider is model-family-agnostic and only layers
// family-specific sampling defaults on models it recognizes.
//
// It wraps `@ai-sdk/openai-compatible` for Chat Completions and
// `@ai-sdk/openai` for Responses API models with everything that makes
// Mixlayer behave correctly out of the box:
//
//   - the Mixlayer base URL default
//   - family-specific Chat Completions sampling defaults (currently the Qwen
//     3.5 / 3.6 defaults, thinking / non-thinking)
//   - reasoning middleware that extracts `<think>` tags into AI SDK reasoning
//     parts (the provider also emits native `reasoning_content`)
//   - OpenAI Responses API models, which can be paired with
//     `createMixlayerWebSocketFetch()` for Responses WebSocket streaming
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
import { createOpenAI } from '@ai-sdk/openai'
import { wrapLanguageModel, extractReasoningMiddleware } from 'ai'
import type { LanguageModelMiddleware } from 'ai'
import type { LanguageModelV4 } from '@ai-sdk/provider'
import { MIXLAYER_DEFAULT_BASE_URL } from './constants'

type MixlayerFetchFunction = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * Recommended Qwen open-weight sampling defaults. These are the same across the
 * open-weight Qwen sizes Mixlayer serves (4B / 9B / 27B / 35B-A3B / 397B-A17B)
 * and stable across the **3.5 and 3.6** generations.
 *
 * Source: Mixlayer's chat completion and per-model documentation, which adapts
 * Qwen's published guidance to the parameters the Mixlayer API exposes:
 * https://docs.mixlayer.com/chat-completions#sampling-parameters
 * https://docs.mixlayer.com/models#qwen-35
 *
 * The provider applies them automatically, but ONLY to Qwen 3.5 / 3.6 models
 * (see {@link isQwen35Or36}). Future Qwen generations and any other model family
 * pass through untouched, and any value the caller sets on the request wins
 * (the defaults are overridable per call).
 *
 * Qwen thinking is controlled with Mixlayer's documented `thinking` request
 * field.
 *
 * `extraBody` carries Mixlayer-specific fields. The scalar fields
 * (`temperature`, `topP`, `topK`, `presencePenalty`) are also exposed so
 * callers that build their own `streamText`/`generateText` params can reuse
 * them as fallbacks.
 */
export const MIXLAYER_THINKING_DEFAULTS = {
  temperature: 1.0,
  topP: 0.95,
  topK: 20,
  presencePenalty: 0.0,
  extraBody: { thinking: true, repetition_penalty: 1.0 } as Record<string, unknown>,
} as const

export const MIXLAYER_NON_THINKING_DEFAULTS = {
  temperature: 0.7,
  topP: 0.8,
  topK: 20,
  presencePenalty: 1.5,
  extraBody: {
    thinking: false,
    repetition_penalty: 1.0,
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
 * Matches the dotted ids Mixlayer uses (`qwen/qwen3.5-9b`, `qwen/qwen3.6-35b-a3b`),
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
  const definedBody = Object.fromEntries(
    Object.entries(body).filter(([, value]) => value !== undefined)
  )
  // Body keys use the OpenAI/vLLM snake_case wire format.
  return {
    temperature: defaults.temperature,
    top_p: defaults.topP,
    top_k: defaults.topK,
    presence_penalty: defaults.presencePenalty,
    ...defaults.extraBody,
    ...definedBody,
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

function hasAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  return Object.keys(headers ?? {}).some(key => key.toLowerCase() === 'authorization')
}

function resolveOpenAIResponsesApiKey(settings: MixlayerProviderSettings): string {
  const resolved = resolveMixlayerApiKey(settings.apiKey)
  if (resolved) return resolved
  // `@ai-sdk/openai` normally falls back to OPENAI_API_KEY when apiKey is
  // undefined. Mixlayer must never silently use an OpenAI key, so provide a
  // harmless placeholder. A caller-supplied Authorization header still wins.
  return hasAuthorizationHeader(settings.headers) ? 'unused' : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function createResponsesThinkingMiddleware(thinking: boolean): LanguageModelMiddleware {
  return {
    transformParams: async ({ params, model }) => {
      if (thinking || !isQwen35Or36(model.modelId)) return params

      const openaiOptions = isRecord(params.providerOptions?.openai)
        ? params.providerOptions.openai
        : {}

      if (openaiOptions.reasoningEffort != null || openaiOptions.reasoning != null) {
        return params
      }

      return {
        ...params,
        providerOptions: {
          ...params.providerOptions,
          openai: {
            ...openaiOptions,
            // Mixlayer's Responses API rejects the Chat Completions-only
            // `thinking` field, but accepts the OpenAI Responses reasoning
            // object. Force reasoning mode because Mixlayer model ids are not in
            // @ai-sdk/openai's built-in OpenAI reasoning-model allowlist.
            forceReasoning: true,
            reasoningEffort: 'none',
          },
        },
      }
    },
  }
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
  fetch?: MixlayerFetchFunction
  /** Include usage information in streaming responses. */
  includeUsage?: boolean
  /**
   * Whether to apply the Qwen *thinking* sampling defaults. When `false`, the
   * non-thinking Chat Completions defaults are used (including
   * `thinking: false`). Responses API Qwen 3.5 / 3.6 models use
   * `reasoning.effort: "none"` instead because `/responses` rejects the
   * Chat Completions-only `thinking` field.
   * Defaults to `true` — Qwen thinks by default.
   */
  thinking?: boolean
  /**
   * Which API backs the callable provider and `languageModel(id)`.
   *
   * Defaults to `chat` for backwards compatibility. Use `responses` to make
   * `provider(id)` and provider registries create Responses API models. The
   * explicit `provider.chat(id)` and `provider.responses(id)` accessors are
   * always available regardless of this setting.
   */
  defaultModelApi?: 'chat' | 'responses'
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
  | 'qwen/qwen3.5-35b-a3b'
  | 'qwen/qwen3.5-397b-a17b'
  | 'qwen/qwen3.6-27b'
  | 'qwen/qwen3.6-35b-a3b'
  | 'moonshotai/kimi-k2.6'
  | 'moonshotai/kimi-k2.7-code'
  // eslint-disable-next-line @typescript-eslint/ban-types -- open-union autocomplete idiom
  | (string & {})

/** Alias for model ids accepted by Mixlayer Responses API accessors. */
export type MixlayerResponsesModelId = MixlayerChatModelId

/** Alias for any Mixlayer language model id accepted by this provider. */
export type MixlayerLanguageModelId = MixlayerChatModelId

/**
 * A Mixlayer provider. Callable directly (`mixlayer(modelId)`) and via the
 * standard AI SDK accessors. Works with `createProviderRegistry` for language
 * models. (Mixlayer is text-generation only today — no embedding models.)
 */
export interface MixlayerProvider {
  (modelId: MixlayerChatModelId): LanguageModelV4
  languageModel(modelId: MixlayerChatModelId): LanguageModelV4
  /** Creates a Chat Completions API model. */
  chat(modelId: MixlayerChatModelId): LanguageModelV4
  /** Creates a Responses API model. Pair with `createMixlayerWebSocketFetch()` for WebSocket mode. */
  responses(modelId: MixlayerChatModelId): LanguageModelV4
  chatModel(modelId: MixlayerChatModelId): LanguageModelV4
  responsesModel(modelId: MixlayerChatModelId): LanguageModelV4
}

/**
 * Creates a Mixlayer provider backed by `@ai-sdk/openai-compatible` for Chat
 * Completions and `@ai-sdk/openai` for Responses API models. Chat Completions
 * models get Qwen sampling defaults baked into the request body (scoped to Qwen
 * 3.5 / 3.6). Responses API models use the OpenAI-compatible request shape so
 * they work with Mixlayer's Responses HTTP and WebSocket endpoints; for Qwen
 * 3.5 / 3.6, `thinking: false` maps to `reasoning.effort: "none"`. Both model
 * types are wrapped with `<think>`-tag reasoning extraction.
 */
export function createMixlayer(settings: MixlayerProviderSettings = {}): MixlayerProvider {
  const thinking = settings.thinking ?? true
  const baseURL = settings.baseURL ?? MIXLAYER_DEFAULT_BASE_URL

  const openaiCompatible = createOpenAICompatible({
    name: 'mixlayer',
    apiKey: resolveMixlayerApiKey(settings.apiKey),
    baseURL,
    headers: settings.headers,
    fetch: settings.fetch,
    includeUsage: settings.includeUsage,
    // Layer in family-specific sampling defaults. Today that's the Qwen 3.5 /
    // 3.6 family only; other families pass through, and any value the caller
    // set on the request wins (overridable per call).
    transformRequestBody: (body: Record<string, unknown>) =>
      applyQwenSamplingDefaults(body, thinking),
  })

  const openaiResponses = createOpenAI({
    name: 'mixlayer',
    apiKey: resolveOpenAIResponsesApiKey(settings),
    baseURL,
    headers: settings.headers,
    fetch: settings.fetch,
  })

  const wrapWithReasoning = (model: LanguageModelV4): LanguageModelV4 =>
    wrapLanguageModel({
      model,
      middleware: extractReasoningMiddleware({ tagName: 'think' }),
    })

  const wrapResponsesModel = (model: LanguageModelV4): LanguageModelV4 =>
    wrapLanguageModel({
      model,
      middleware: [
        createResponsesThinkingMiddleware(thinking),
        extractReasoningMiddleware({ tagName: 'think' }),
      ],
    })

  const createChatModel = (modelId: MixlayerChatModelId): LanguageModelV4 => {
    const resolved = extractMixlayerModelId(modelId)
    // The provider natively emits `reasoning_content`; the middleware handles
    // `<think>` tags so both paths surface as AI SDK reasoning parts.
    return wrapWithReasoning(openaiCompatible.chatModel(resolved))
  }

  const createResponsesModel = (modelId: MixlayerChatModelId): LanguageModelV4 => {
    const resolved = extractMixlayerModelId(modelId)
    return wrapResponsesModel(openaiResponses.responses(resolved))
  }

  const createDefaultModel =
    settings.defaultModelApi === 'responses' ? createResponsesModel : createChatModel

  const provider = ((modelId: string) => createDefaultModel(modelId)) as MixlayerProvider
  provider.languageModel = createDefaultModel
  provider.chat = createChatModel
  provider.responses = createResponsesModel
  provider.chatModel = createChatModel
  provider.responsesModel = createResponsesModel
  return provider
}

/**
 * Default Mixlayer provider instance. Reads `MIXLAYER_API_KEY` from the
 * environment (Node); construct your own with {@link createMixlayer} to set the
 * key or other options explicitly.
 */
export const mixlayer: MixlayerProvider = createMixlayer()
