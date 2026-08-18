# @runtypelabs/mixlayer-ai-provider

## 2.2.1

### Patch Changes

- bcba054: Update package author to the current legal entity name, Runtype, Inc.

## 2.2.0

### Minor Changes

- a4c0e99: Expose the known vision-capable model snapshot, document standard AI SDK image
  inputs, and refresh the live Mixlayer model catalog.

## 2.1.0

### Minor Changes

- 1ab2d4e: - Export `MIXLAYER_KNOWN_MODEL_IDS` for consumers that need the provider's model catalog.
  - Harden WebSocket response cancellation, closure, routing, and header handling.
  - Validate Responses API HTTP and WebSocket transports in the live test matrix.

## 2.0.0

### Major Changes

- e96f56b: Remove client-side Qwen sampling defaults — Mixlayer now applies the recommended per-model sampling defaults server-side, so the provider no longer injects `temperature`, `top_p`, `top_k`, `presence_penalty`, or `repetition_penalty` into Chat Completions requests. Only values the caller sets explicitly are sent. The Qwen `thinking` toggle is unchanged and still sent for Qwen 3.5 / 3.6 models (Chat Completions `thinking` field; Responses `reasoning.effort: 'none'` for `thinking: false`).

  BREAKING: the `getMixlayerSamplingDefaults`, `applyQwenSamplingDefaults`, `MIXLAYER_THINKING_DEFAULTS`, `MIXLAYER_NON_THINKING_DEFAULTS`, and `MixlayerSamplingDefaults` exports are removed. A new `applyQwenThinking(body, thinking?)` helper replaces `applyQwenSamplingDefaults` for the thinking field only.

## 1.2.0

### Minor Changes

- 84dbf13: Add the `z-ai/glm-5.2` model id to `MixlayerChatModelId` so autocomplete matches the live Mixlayer catalog (verified via `pnpm run validate:models`). Also fix `pnpm run validate:models` (and any `pnpm run` script) failing with `[ERR_PNPM_IGNORED_BUILDS]` on pnpm 11.9+ by setting `allowBuilds.esbuild: true` in `pnpm-workspace.yaml` — the `allowBuilds` map takes precedence over `onlyBuiltDependencies` in pnpm 11.9+.

## 1.1.1

### Patch Changes

- 1350a0d: Forward AI SDK User-Agent headers into Responses WebSocket handshakes while keeping explicit WebSocket headers overridable.

## 1.1.0

### Minor Changes

- dc2e662: Add explicit Mixlayer Responses API model support plus a Responses WebSocket fetch adapter. The provider now exposes `provider.responses(id)` / `provider.responsesModel(id)`, `defaultModelApi: 'responses'`, `createMixlayerWebSocketFetch()`, and constants/helpers for deriving the Mixlayer Responses WebSocket URL. The WebSocket adapter defaults to a fetch-upgrade transport for Cloudflare Workers compatibility and no longer requires a Node-only `ws` dependency.

## 1.0.0

### Major Changes

- 8a28e41: Update the provider for AI SDK v7: depend on `@ai-sdk/openai-compatible` v3, require `ai` v7 as the peer, raise the Node.js requirement to 22+, publish ESM-only artifacts, and expose v4 language model return types.

## 0.2.4

### Patch Changes

- 752fab8: Sync `MixlayerChatModelId` autocomplete ids with the live Mixlayer catalog: drop the retired `qwen/qwen3.5-27b` and add `moonshotai/kimi-k2.6` and `moonshotai/kimi-k2.7-code`. Also make the README model section generic so it no longer needs updating on every catalog change.

## 0.2.3

### Patch Changes

- c832d1f: Approve esbuild's install build script via `pnpm-workspace.yaml` (`onlyBuiltDependencies`) so `pnpm install --frozen-lockfile` no longer halts on `ERR_PNPM_IGNORED_BUILDS`.

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
