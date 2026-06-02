# @runtypelabs/mixlayer-ai-provider

## 0.1.1

Initial release. An AI SDK (Vercel) provider for Mixlayer — open-weight model
inference (currently the Qwen 3.5 / 3.6 family) over an OpenAI-compatible
endpoint.

- `createMixlayer` / `mixlayer` — a provider built on `@ai-sdk/openai-compatible`
  that bakes in the Mixlayer base URL, `<think>`-tag reasoning middleware,
  `mixlayer/` model-id prefix stripping, and a `MIXLAYER_API_KEY` env fallback.
- The recommended Qwen open-weight sampling defaults (thinking / non-thinking,
  including the vLLM `enable_thinking` toggle) are scoped to the Qwen 3.5 / 3.6
  generations (`isQwen35Or36`) and overridable per request; later Qwen
  generations and other model families pass through untouched. The provider is
  model-family-agnostic, leaving room for non-Qwen families (e.g. Kimi).
- `MixlayerChatModelId` autocomplete for the current catalog (open union). Works
  with `createProviderRegistry` for language models (Mixlayer is
  text-generation only today — no embedding models).
