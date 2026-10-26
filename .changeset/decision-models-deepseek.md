---
'@runtypelabs/mixlayer-ai-provider': minor
---

Add experimental decision models through `provider.decisionModel(id)` for the
AI SDK's `experimental_decide`, backed by Mixlayer's `/v1/decisions` endpoint.
Add `mixlayer/jini-qwen3.8-27b` to the new `MIXLAYER_DECISION_MODEL_IDS`
snapshot and `deepseek/deepseek-v4.1-flash` to `MIXLAYER_KNOWN_MODEL_IDS`.

Preserve first-party `mixlayer/` model ids such as `mixlayer/jini-qwen3.8-27b`
instead of stripping them as a routing prefix.

Extend the `thinking` toggle to DeepSeek V4 models, and add
`applyMixlayerThinking` and `supportsMixlayerThinking`. `applyQwenThinking`
remains as a deprecated alias.

Send an empty `description` for Chat Completions tools defined without one,
since Mixlayer rejects tools that omit the field.

Update the AI SDK dependencies and require `ai` 7.0.146 or later.
