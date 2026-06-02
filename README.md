# mixlayer-ai-provider

An [AI SDK](https://sdk.vercel.ai) provider for **Mixlayer** — the open-weight
[Qwen](https://qwenlm.github.io) inference API served over an OpenAI-compatible
endpoint at `https://models.mixlayer.ai/v1`.

It wraps [`@ai-sdk/openai-compatible`](https://www.npmjs.com/package/@ai-sdk/openai-compatible)
and bakes in everything Mixlayer needs to behave correctly:

- the Mixlayer base URL default
- the official Qwen open-weight sampling defaults (thinking / non-thinking),
  including the vLLM `chat_template_kwargs.enable_thinking` toggle
- reasoning middleware that extracts `<think>` tags into AI SDK reasoning parts
  (the provider also emits native `reasoning_content`)
- an optional Cloudflare AI Gateway fetch wrapper
- tolerant model-id handling (strips a leading `mixlayer/` prefix)

## Install

```bash
pnpm add mixlayer-ai-provider ai
```

`ai` is a peer dependency, so your app dedupes a single AI SDK version.

## Usage

```ts
import { mixlayer } from 'mixlayer-ai-provider'
import { streamText } from 'ai'

const result = streamText({
  model: mixlayer('qwen/qwen3-8b'),
  prompt: 'Explain reasoning models in one paragraph.',
})

for await (const text of result.textStream) process.stdout.write(text)
```

The default `mixlayer` instance reads no configuration. To set an API key (or
any other option), create your own provider with `createMixlayer`.

### Explicit settings

```ts
import { createMixlayer } from 'mixlayer-ai-provider'

const provider = createMixlayer({
  apiKey: process.env.MIXLAYER_API_KEY,
  thinking: false, // use the non-thinking Qwen sampling defaults
})

const model = provider('qwen/qwen3-8b')
```

### Cloudflare AI Gateway

```ts
const provider = createMixlayer({
  apiKey,
  gateway: {
    viaCfGateway: true,
    // Only needed in local dev (wrangler/bun); in production CF Workers,
    // Worker identity handles gateway auth automatically.
    cfGatewayToken: process.env.CF_AI_GATEWAY_TOKEN,
  },
})
```

## API

| Export                                                         | Description                                                       |
| -------------------------------------------------------------- | ---------------------------------------------------------------- |
| `mixlayer`                                                     | Default provider instance (thinking mode, no API key configured) |
| `createMixlayer(settings)`                                     | Provider factory                                                 |
| `createMixlayerFetch(baseFetch, gateway?)`                     | Cloudflare AI Gateway fetch wrapper                              |
| `extractMixlayerModelId(id)`                                   | Strips a leading `mixlayer/` prefix                              |
| `getMixlayerSamplingDefaults(thinking)`                        | Returns the Qwen sampling defaults for a mode                    |
| `MIXLAYER_DEFAULT_BASE_URL`                                    | `https://models.mixlayer.ai/v1`                                  |
| `MIXLAYER_THINKING_DEFAULTS` / `MIXLAYER_NON_THINKING_DEFAULTS` | The raw sampling-default objects                                 |

### `MixlayerProviderSettings`

| Option     | Type                      | Default                       | Description                                                              |
| ---------- | ------------------------- | ----------------------------- | ------------------------------------------------------------------------ |
| `apiKey`   | `string`                  | —                             | Mixlayer API key                                                         |
| `baseURL`  | `string`                  | `MIXLAYER_DEFAULT_BASE_URL`   | Override the inference endpoint                                          |
| `headers`  | `Record<string, string>`  | —                             | Extra headers sent with every request                                   |
| `fetch`    | `typeof fetch`            | `globalThis.fetch`            | Custom fetch (e.g. instrumented or proxied)                             |
| `gateway`  | `MixlayerGatewayOptions`  | —                             | Cloudflare AI Gateway routing                                            |
| `thinking` | `boolean`                 | `true`                        | Apply the thinking (`true`) or non-thinking (`false`) sampling defaults |

## Development

```bash
pnpm install
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
pnpm build       # tsup (ESM + CJS + d.ts)
```

## License

[MIT](./LICENSE) © Runtype Labs
