---
'@runtypelabs/mixlayer-ai-provider': patch
---

Reject Mixlayer `choice` and `score` decision questions without `instructions`
before sending a request. Mixlayer requires them and otherwise fails with a
misleading "only text input is supported" error.
