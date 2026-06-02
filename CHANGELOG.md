# Changelog

## 0.1.0

Initial release. Extracted from the Runtype monorepo.

- `createMixlayer` / `mixlayer` — an AI SDK provider for Mixlayer, built on
  `@ai-sdk/openai-compatible`.
- Bakes in the official Qwen open-weight sampling defaults (thinking /
  non-thinking, including the vLLM `enable_thinking` toggle), `<think>`-tag
  reasoning middleware, an optional Cloudflare AI Gateway fetch wrapper, and
  `mixlayer/` model-id prefix stripping.
- Sampling defaults are scoped to the Qwen 3.5 / 3.6 generations
  (`isQwen35Or36`) and overridable per request; future Qwen generations and
  non-Qwen models pass through untouched.
