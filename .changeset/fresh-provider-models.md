---
'@runtypelabs/mixlayer-ai-provider': patch
---

Refresh the model catalog with Qwen 3.8 and GLM 5.3, remove retired models,
and include Qwen 3.8 in the vision snapshot. Update the AI SDK dependencies
and maintenance toolchain. Require AI SDK 7.0.127 or later in the v7 series
for compatible provider types, while preserving Node.js 22 support.

Preserve upstream WebSocket error details when Mixlayer omits the sequence
number required by the Responses streaming schema.
