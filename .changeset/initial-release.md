---
'mixlayer-ai-provider': minor
---

Initial release. An AI SDK (Vercel) provider for Mixlayer — the open-weight Qwen
inference API served over an OpenAI-compatible endpoint.

- `createMixlayer` / `mixlayer` — a provider built on `@ai-sdk/openai-compatible`
  that bakes in the Mixlayer base URL, `<think>`-tag reasoning middleware, an
  optional Cloudflare AI Gateway fetch wrapper, `mixlayer/` model-id prefix
  stripping, and a `MIXLAYER_API_KEY` env fallback.
- The official Qwen open-weight sampling defaults (thinking / non-thinking,
  including the vLLM `enable_thinking` toggle) are scoped to the Qwen 3.5 / 3.6
  generations (`isQwen35Or36`) and overridable per request; future Qwen
  generations and non-Qwen models pass through untouched.
- `textEmbeddingModel` passthrough for Qwen embeddings, so the provider works
  with `createProviderRegistry`.
