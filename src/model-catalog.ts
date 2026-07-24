/**
 * Snapshot used for editor autocomplete and offline fallback. This is not a
 * closed allowlist or the result of live model discovery.
 */
export const MIXLAYER_KNOWN_MODEL_IDS = [
  'qwen/qwen3.5-4b-free',
  'qwen/qwen3.5-9b',
  'qwen/qwen3.5-35b-a3b',
  'qwen/qwen3.5-397b-a17b',
  'qwen/qwen3.6-27b',
  'qwen/qwen3.6-35b-a3b',
  'moonshotai/kimi-k2.7-code',
  'z-ai/glm-5.2',
] as const

export type MixlayerKnownModelId = (typeof MIXLAYER_KNOWN_MODEL_IDS)[number]

/**
 * Known models that accept image input through both Chat Completions and
 * Responses. Text-only models remain in {@link MIXLAYER_KNOWN_MODEL_IDS}.
 */
export const MIXLAYER_VISION_MODEL_IDS = [
  'qwen/qwen3.5-4b-free',
  'qwen/qwen3.5-9b',
  'qwen/qwen3.5-35b-a3b',
  'qwen/qwen3.5-397b-a17b',
  'qwen/qwen3.6-27b',
  'qwen/qwen3.6-35b-a3b',
] as const satisfies readonly MixlayerKnownModelId[]

export type MixlayerVisionModelId = (typeof MIXLAYER_VISION_MODEL_IDS)[number]
