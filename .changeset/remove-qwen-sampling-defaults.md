---
'@runtypelabs/mixlayer-ai-provider': major
---

Remove client-side Qwen sampling defaults — Mixlayer now applies the recommended per-model sampling defaults server-side, so the provider no longer injects `temperature`, `top_p`, `top_k`, `presence_penalty`, or `repetition_penalty` into Chat Completions requests. Only values the caller sets explicitly are sent. The Qwen `thinking` toggle is unchanged and still sent for Qwen 3.5 / 3.6 models (Chat Completions `thinking` field; Responses `reasoning.effort: 'none'` for `thinking: false`).

BREAKING: the `getMixlayerSamplingDefaults`, `applyQwenSamplingDefaults`, `MIXLAYER_THINKING_DEFAULTS`, `MIXLAYER_NON_THINKING_DEFAULTS`, and `MixlayerSamplingDefaults` exports are removed. A new `applyQwenThinking(body, thinking?)` helper replaces `applyQwenSamplingDefaults` for the thinking field only.
