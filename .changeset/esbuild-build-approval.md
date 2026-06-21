---
"@runtypelabs/mixlayer-ai-provider": patch
---

Approve esbuild's install build script via `pnpm-workspace.yaml` (`onlyBuiltDependencies`) so `pnpm install --frozen-lockfile` no longer halts on `ERR_PNPM_IGNORED_BUILDS`.
