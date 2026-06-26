---
'@runtypelabs/mixlayer-ai-provider': minor
---

Add explicit Mixlayer Responses API model support plus a Responses WebSocket fetch adapter. The provider now exposes `provider.responses(id)` / `provider.responsesModel(id)`, `defaultModelApi: 'responses'`, `createMixlayerWebSocketFetch()`, and constants/helpers for deriving the Mixlayer Responses WebSocket URL.
