# @runtypelabs/mixlayer-ai-provider

## 0.2.2

### Patch Changes

- 28345d9: Docs: clean up README for npm — fix the models page link to https://docs.mixlayer.com/models, link the first Mixlayer mention to https://www.mixlayer.com/, and trim internal release tooling detail.

## 0.2.1

### Patch Changes

- e03f081: Update the release workflow to use a Node/npm toolchain that supports npm trusted publishing and remove the unused npm token environment variable.

## 0.2.0

### Minor Changes

- 8a52734: Align Qwen sampling defaults with Mixlayer's documented request parameters, use the `thinking` toggle instead of vLLM chat template kwargs, avoid sending unsupported default `min_p`, preserve defaults when AI SDK passes undefined values, and expose `includeUsage` for streaming usage chunks.

### Patch Changes

- e00d7f7: Add live Mixlayer validation tooling, including a configurable model/option matrix runner and a scheduled GitHub Action that compares the live `/models` catalog with the provider autocomplete list.

## 0.1.1

Initial release. An AI SDK (Vercel) provider for Mixlayer — open-weight model
inference (currently the Qwen 3.5 / 3.6 family) over an OpenAI-compatible
endpoint.

- `createMixlayer` / `mixlayer` — a provider built on `@ai-sdk/openai-compatible`
  that bakes in the Mixlayer base URL, `<think>`-tag reasoning middleware,
  `mixlayer/` model-id prefix stripping, and a `MIXLAYER_API_KEY` env fallback.
- The recommended Qwen open-weight sampling defaults (thinking / non-thinking,
  including Mixlayer's documented `thinking` toggle) are scoped to the Qwen 3.5
  / 3.6 generations (`isQwen35Or36`) and overridable per request; later Qwen
  generations and other model families pass through untouched. The provider is
  model-family-agnostic, leaving room for non-Qwen families (e.g. Kimi).
- `MixlayerChatModelId` autocomplete for the current catalog (open union). Works
  with `createProviderRegistry` for language models (Mixlayer is
  text-generation only today — no embedding models).
