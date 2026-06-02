---
"@runtypelabs/mixlayer-ai-provider": minor
---

Align Qwen sampling defaults with Mixlayer's documented request parameters, use the `thinking` toggle instead of vLLM chat template kwargs, avoid sending unsupported default `min_p`, preserve defaults when AI SDK passes undefined values, and expose `includeUsage` for streaming usage chunks.
