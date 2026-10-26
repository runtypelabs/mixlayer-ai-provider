// @runtypelabs/mixlayer-ai-provider — an AI SDK provider for Mixlayer.
//
// Mixlayer serves open-weight models over an OpenAI-compatible inference API at
// https://mixlayer.ai/v1. The catalog spans Qwen, GLM, and DeepSeek models plus
// decision models, and grows over time, so this provider is model-family-agnostic
// and only layers family-specific behavior on models it recognizes.
//
// It wraps `@ai-sdk/openai-compatible` for Chat Completions and
// `@ai-sdk/openai` for Responses API models with everything that makes
// Mixlayer behave correctly out of the box:
//
//   - the Mixlayer base URL default
//   - the `thinking` toggle for Qwen 3.5 / 3.6 and DeepSeek V4 (Mixlayer applies
//     the recommended sampling defaults server-side, so the provider no longer
//     injects them)
//   - a `description` on every Chat Completions tool, which Mixlayer requires
//   - reasoning middleware that extracts `<think>` tags into AI SDK reasoning
//     parts (the provider also emits native `reasoning_content`)
//   - image input for vision-capable models through standard AI SDK file parts
//   - OpenAI Responses API models, which can be paired with
//     `createMixlayerWebSocketFetch()` for Responses WebSocket streaming
//   - experimental decision models (`provider.decisionModel(id)`) backed by
//     Mixlayer's OpenAI-compatible `/v1/decisions` endpoint
//   - tolerant model-id handling (strips a leading routing `mixlayer/` prefix)
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
import {
  InvalidArgumentError,
  NoSuchModelError,
  UnsupportedFunctionalityError,
  type Experimental_DecisionModelV4,
  type LanguageModelV4,
  type ProviderV4,
} from '@ai-sdk/provider'
import { MIXLAYER_DEFAULT_BASE_URL } from './constants'
import type { MixlayerKnownDecisionModelId, MixlayerKnownModelId } from './model-catalog'

type MixlayerFetchFunction = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * Whether a model id is a Qwen **3.5 or 3.6** model — the generations whose
 * `thinking` toggle this provider manages. Later Qwen generations (3.7+) and
 * other model families return `false`, so they receive vanilla
 * OpenAI-compatible behavior with no injected fields.
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
 * Whether a model id is a DeepSeek **V4** model (`deepseek/deepseek-v4.1-flash`),
 * which honors Mixlayer's `thinking` toggle on Chat Completions and
 * `reasoning.effort: "none"` on Responses.
 */
export function isDeepSeekV4(modelId: string): boolean {
  return /deepseek-?v4(?![0-9])/i.test(modelId)
}

/**
 * Whether this provider manages the `thinking` toggle for a model id: Qwen
 * 3.5 / 3.6 ({@link isQwen35Or36}) and DeepSeek V4 ({@link isDeepSeekV4}).
 * Other models receive vanilla OpenAI-compatible requests.
 */
export function supportsMixlayerThinking(modelId: string): boolean {
  return isQwen35Or36(modelId) || isDeepSeekV4(modelId)
}

/**
 * Returns `body` with Mixlayer's documented `thinking` request field set — but
 * only when `body.model` supports the toggle ({@link supportsMixlayerThinking})
 * and the caller hasn't already set `thinking` on the request themselves.
 * Other models are returned unchanged.
 *
 * Sampling defaults (`temperature`, `top_p`, `top_k`, penalties) are no longer
 * injected here — Mixlayer applies the recommended per-model defaults
 * server-side, so the provider only sends values the caller sets explicitly.
 */
export function applyMixlayerThinking(
  body: Record<string, unknown>,
  thinking = true
): Record<string, unknown> {
  const modelId = typeof body.model === 'string' ? body.model : ''
  if (!supportsMixlayerThinking(modelId)) return body
  if (body.thinking !== undefined) return body
  return { ...body, thinking }
}

/** @deprecated Use {@link applyMixlayerThinking}, which also covers DeepSeek V4. */
export const applyQwenThinking = applyMixlayerThinking

/**
 * Returns `body` with an empty `description` added to every Chat Completions
 * function tool that lacks one. Mixlayer rejects tools without the field, and
 * AI SDK tools defined without a description omit it from the request.
 */
export function applyMixlayerToolDescriptions(
  body: Record<string, unknown>
): Record<string, unknown> {
  if (!Array.isArray(body.tools)) return body

  let changed = false
  const tools = body.tools.map((tool: unknown) => {
    if (!isRecord(tool) || !isRecord(tool.function)) return tool
    if (typeof tool.function.description === 'string') return tool
    changed = true
    return { ...tool, function: { ...tool.function, description: '' } }
  })
  return changed ? { ...body, tools } : body
}

/**
 * Strips a leading `mixlayer/` (or `mixlayer:`) routing prefix from a model id
 * so callers can pass either the bare upstream id (`qwen/qwen3.5-9b`) or a
 * routed/prefixed id (`mixlayer/qwen/qwen3.5-9b`). The prefix is only stripped
 * when the rest still has its own org segment, so Mixlayer's first-party ids
 * (`mixlayer/jini-qwen3.8-27b`) are preserved. Anything without a recognized
 * prefix is returned unchanged.
 */
export function extractMixlayerModelId(model: string): string {
  const trimmed = model.trim()
  const match = /^mixlayer[/:](.+)$/i.exec(trimmed)
  return match && match[1].includes('/') ? match[1] : trimmed
}

/**
 * Resolves the Mixlayer API key. Falls back to the `MIXLAYER_API_KEY`
 * environment variable when no explicit key is supplied. The `process` guard
 * keeps this safe in non-Node runtimes (e.g. Cloudflare Workers, the browser),
 * where you pass `apiKey` explicitly instead.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function resolveMixlayerApiKey(explicit?: string): string | undefined {
  if (explicit) return explicit
  if (typeof process !== 'undefined' && process.env) return process.env.MIXLAYER_API_KEY
  return undefined
}

function getHeaderValue(
  headers: Record<string, string> | undefined,
  name: string
): string | undefined {
  const lowerName = name.toLowerCase()
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === lowerName) return value
  }
  return undefined
}

function resolveOpenAIResponsesApiKey(settings: MixlayerProviderSettings): string {
  // `@ai-sdk/openai` normally falls back to OPENAI_API_KEY when apiKey is
  // undefined. Mixlayer must never silently use an OpenAI key, so provide an
  // empty string when no Mixlayer key is configured.
  return resolveMixlayerApiKey(settings.apiKey) ?? ''
}

function createOpenAIResponsesFetch(
  settings: MixlayerProviderSettings
): MixlayerFetchFunction | undefined {
  const authorization = getHeaderValue(settings.headers, 'authorization')
  if (!authorization) return settings.fetch

  const fetchImplementation = settings.fetch ?? globalThis.fetch.bind(globalThis)
  return (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set('Authorization', authorization)
    return fetchImplementation(input, { ...init, headers })
  }
}

function createResponsesThinkingMiddleware(thinking: boolean): LanguageModelMiddleware {
  return {
    transformParams: async ({ params, model }) => {
      if (thinking || !supportsMixlayerThinking(model.modelId)) return params

      const openaiOptions = isRecord(params.providerOptions?.openai)
        ? params.providerOptions.openai
        : {}

      const hasTopLevelReasoningEffort =
        params.reasoning != null && params.reasoning !== 'provider-default'
      const hasProviderReasoningControl =
        openaiOptions.reasoningEffort != null ||
        openaiOptions.reasoning != null ||
        openaiOptions.reasoningSummary != null
      const shouldDefaultReasoningEffort =
        openaiOptions.forceReasoning !== false &&
        !hasTopLevelReasoningEffort &&
        !hasProviderReasoningControl

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
            forceReasoning: openaiOptions.forceReasoning ?? true,
            ...(shouldDefaultReasoningEffort ? { reasoningEffort: 'none' } : {}),
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
   * Whether Qwen 3.5 / 3.6 and DeepSeek V4 models think. Chat Completions
   * requests send Mixlayer's documented `thinking` field; Responses API models
   * use `reasoning.effort: "none"` for `false` instead because `/responses`
   * rejects the Chat Completions-only `thinking` field.
   * Defaults to `true` — these models think by default.
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
 * keeps the union open: Mixlayer adds models and model families over time,
 * so any model id string is accepted —
 * the listed ids just provide editor autocomplete.
 */
export type MixlayerChatModelId =
  | MixlayerKnownModelId
  // eslint-disable-next-line @typescript-eslint/ban-types -- open-union autocomplete idiom
  | (string & {})

/** Alias for model ids accepted by Mixlayer Responses API accessors. */
export type MixlayerResponsesModelId = MixlayerChatModelId

/** Alias for any Mixlayer language model id accepted by this provider. */
export type MixlayerLanguageModelId = MixlayerChatModelId

/**
 * Known Mixlayer decision model ids. Like {@link MixlayerChatModelId}, the
 * union stays open so new decision models work before the snapshot updates.
 */
export type MixlayerDecisionModelId =
  | MixlayerKnownDecisionModelId
  // eslint-disable-next-line @typescript-eslint/ban-types -- open-union autocomplete idiom
  | (string & {})

/**
 * A Mixlayer provider. Callable directly (`mixlayer(modelId)`) and via the
 * standard AI SDK accessors. Works with `createProviderRegistry` for language
 * models. Vision-capable entries accept image input through standard AI SDK
 * file parts. Decision models are exposed through `decisionModel(id)` for the
 * AI SDK's `experimental_decide`. Embeddings and image generation are not exposed.
 */
export interface MixlayerProvider extends ProviderV4 {
  (modelId: MixlayerChatModelId): LanguageModelV4
  languageModel(modelId: MixlayerChatModelId): LanguageModelV4
  /** Creates a Chat Completions API model. */
  chat(modelId: MixlayerChatModelId): LanguageModelV4
  /** Creates a Responses API model. Pair with `createMixlayerWebSocketFetch()` for WebSocket mode. */
  responses(modelId: MixlayerChatModelId): LanguageModelV4
  chatModel(modelId: MixlayerChatModelId): LanguageModelV4
  responsesModel(modelId: MixlayerChatModelId): LanguageModelV4
  /**
   * Creates an experimental decision model backed by Mixlayer's `/v1/decisions`
   * endpoint, for `experimental_decide`. Supports `boolean`, `choice`, and
   * `score` questions over text and JSON state; `choice` and `score` questions
   * require instructions, and file (image) state is rejected.
   */
  decisionModel(modelId: MixlayerDecisionModelId): Experimental_DecisionModelV4
  /** Embeddings are not exposed by this provider. Always throws NoSuchModelError. */
  embeddingModel(modelId: string): never
  /** Image generation is not exposed by this provider. Always throws NoSuchModelError. */
  imageModel(modelId: string): never
}

/**
 * Creates a Mixlayer provider backed by `@ai-sdk/openai-compatible` for Chat
 * Completions and `@ai-sdk/openai` for Responses API and decision models. Chat
 * Completions requests for Qwen 3.5 / 3.6 and DeepSeek V4 models carry the
 * `thinking` toggle (sampling defaults are applied server-side by Mixlayer).
 * Responses API models use the OpenAI-compatible request shape so they work
 * with Mixlayer's Responses HTTP and WebSocket endpoints; for those models,
 * `thinking: false` maps to `reasoning.effort: "none"`. Both language model
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
    // Set the thinking toggle; scoped to Qwen 3.5 / 3.6 and DeepSeek V4, other
    // models pass through, and a caller-set `thinking` value wins. Sampling
    // defaults are applied server-side by Mixlayer.
    transformRequestBody: (body: Record<string, unknown>) =>
      applyMixlayerToolDescriptions(applyMixlayerThinking(body, thinking)),
  })

  const openaiResponses = createOpenAI({
    name: 'mixlayer',
    apiKey: resolveOpenAIResponsesApiKey(settings),
    baseURL,
    headers: settings.headers,
    fetch: createOpenAIResponsesFetch(settings),
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

  const createDecisionModel = (
    modelId: MixlayerDecisionModelId
  ): Experimental_DecisionModelV4 => {
    // Mixlayer's `/v1/decisions` speaks the OpenAI Decisions wire format, but
    // accepts text input only — reject file state before any I/O.
    const model = openaiResponses.decisionModel(extractMixlayerModelId(modelId))
    return {
      specificationVersion: model.specificationVersion,
      provider: model.provider,
      modelId: model.modelId,
      supportedQuestionTypes: model.supportedQuestionTypes,
      doDecide: async options => {
        for (const part of options.state) {
          if (part.type === 'file') {
            throw new UnsupportedFunctionalityError({
              functionality: `Mixlayer decision file input: ${part.mediaType}`,
            })
          }
        }
        // The AI SDK lets `choice` and `score` questions omit instructions when
        // criteria define the judgment, but Mixlayer rejects them with a
        // misleading "only text input is supported" error.
        for (const [name, question] of Object.entries(options.questions)) {
          if (
            (question.type === 'choice' || question.type === 'score') &&
            (question.instructions == null || question.instructions === '')
          ) {
            throw new InvalidArgumentError({
              argument: `questions.${name}.instructions`,
              message: `Mixlayer decision ${question.type} questions require instructions (question "${name}").`,
            })
          }
        }
        return model.doDecide(options)
      },
    }
  }

  const createDefaultModel =
    settings.defaultModelApi === 'responses' ? createResponsesModel : createChatModel

  const provider = (modelId: MixlayerChatModelId) => createDefaultModel(modelId)
  provider.specificationVersion = 'v4' as const
  provider.languageModel = createDefaultModel
  provider.chat = createChatModel
  provider.responses = createResponsesModel
  provider.chatModel = createChatModel
  provider.responsesModel = createResponsesModel
  provider.decisionModel = createDecisionModel
  provider.embeddingModel = (modelId: string): never => {
    throw new NoSuchModelError({ modelId, modelType: 'embeddingModel' })
  }
  provider.imageModel = (modelId: string): never => {
    throw new NoSuchModelError({ modelId, modelType: 'imageModel' })
  }
  return provider
}

/**
 * Default Mixlayer provider instance. Reads `MIXLAYER_API_KEY` from the
 * environment (Node); construct your own with {@link createMixlayer} to set the
 * key or other options explicitly.
 */
export const mixlayer: MixlayerProvider = createMixlayer()
