---
'@runtypelabs/mixlayer-ai-provider': minor
---

Add the `z-ai/glm-5.2` model id to `MixlayerChatModelId` so autocomplete matches the live Mixlayer catalog (verified via `pnpm run validate:models`). Also fix `pnpm run validate:models` (and any `pnpm run` script) failing with `[ERR_PNPM_IGNORED_BUILDS]` on pnpm 11.9+ by setting `allowBuilds.esbuild: true` in `pnpm-workspace.yaml` — the `allowBuilds` map takes precedence over `onlyBuiltDependencies` in pnpm 11.9+.