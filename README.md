# @runtypelabs/mixlayer-ai-provider

[![npm](https://img.shields.io/npm/v/@runtypelabs/mixlayer-ai-provider.svg)](https://www.npmjs.com/package/@runtypelabs/mixlayer-ai-provider)
[![license](https://img.shields.io/npm/l/@runtypelabs/mixlayer-ai-provider.svg)](./LICENSE)

An [AI SDK](https://sdk.vercel.ai) provider for [Mixlayer](https://www.mixlayer.com/) —
fast, open-weight model inference served over an OpenAI-compatible endpoint.
Mixlayer's catalog spans Qwen, Kimi, and GLM models and grows over time; this
provider is model-family-agnostic and only layers family-specific behavior on
models it recognizes.

It wraps [`@ai-sdk/openai-compatible`](https://www.npmjs.com/package/@ai-sdk/openai-compatible)
for Chat Completions and [`@ai-sdk/openai`](https://www.npmjs.com/package/@ai-sdk/openai)
for Responses API models, baking in everything Mixlayer needs to behave
correctly out of the box:

- the Mixlayer base URL
- the Qwen thinking toggle (Chat Completions `thinking` field / Responses
  `reasoning.effort`), scoped to the Qwen 3.5 / 3.6 models
- reasoning support — `<think>` tags and native `reasoning_content` both surface
  as AI SDK reasoning parts
- image input through standard AI SDK file parts on vision-capable models
- Responses API models and a Responses WebSocket `fetch` adapter for lower
  latency streaming on repeat calls
- tolerant model-id handling (strips a leading `mixlayer/` prefix)

## Install

```bash
pnpm add @runtypelabs/mixlayer-ai-provider ai@^7
```

This package targets AI SDK v7 and is ESM-only. For Node.js applications, use
Node.js 22+; the package itself avoids Node-only WebSocket dependencies so it
can be bundled for standards-based runtimes such as Cloudflare Workers. `ai` is
a peer dependency, so your app dedupes a single AI SDK version.

## Usage

```ts
import { mixlayer } from '@runtypelabs/mixlayer-ai-provider'
import { streamText } from 'ai'

const result = streamText({
  model: mixlayer('qwen/qwen3.6-27b'),
  prompt: 'Explain reasoning models in one paragraph.',
})

for await (const text of result.textStream) process.stdout.write(text)
```

The default `mixlayer` instance reads `MIXLAYER_API_KEY` from the environment
(Node). To set the key (or any other option) explicitly, create your own
provider with `createMixlayer`:

```ts
import { createMixlayer } from '@runtypelabs/mixlayer-ai-provider'

const provider = createMixlayer({
  apiKey: process.env.MIXLAYER_API_KEY,
  thinking: false, // disable Qwen thinking
})

const model = provider('qwen/qwen3.5-9b')
```

### Vision

Models in `MIXLAYER_VISION_MODEL_IDS` accept image inputs through standard AI
SDK file parts. The same message shape works with Chat Completions and
Responses models:

```ts
import { readFile } from 'node:fs/promises'
import { generateText } from 'ai'
import { mixlayer } from '@runtypelabs/mixlayer-ai-provider'

const image = await readFile('./diagram.png')
const result = await generateText({
  model: mixlayer('qwen/qwen3.6-27b'),
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What does this diagram show?' },
        { type: 'file', mediaType: 'image/png', data: image },
      ],
    },
  ],
})

console.log(result.text)
```

Mixlayer also accepts supported remote image URLs. See the
[Mixlayer vision guide](https://docs.mixlayer.com/vision) for current formats
and limits. Text-only models return a media error when sent an image.

### Responses API and WebSocket mode

The callable provider and `provider.languageModel(id)` use Chat Completions by
default for backwards compatibility. Use `provider.responses(id)` for Mixlayer's
OpenAI-compatible Responses API:

```ts
import { createMixlayer } from '@runtypelabs/mixlayer-ai-provider'
import { streamText } from 'ai'

const provider = createMixlayer({
  apiKey: process.env.MIXLAYER_API_KEY,
  thinking: false, // for Qwen Responses API calls, maps to reasoning.effort: 'none'
})

const result = streamText({
  model: provider.responses('qwen/qwen3.5-9b'),
  prompt: 'Say hello via the Responses API.',
})
```

To route streaming Responses API requests over Mixlayer's WebSocket endpoint,
pass `createMixlayerWebSocketFetch()` as the provider fetch:

```ts
import {
  createMixlayer,
  createMixlayerWebSocketFetch,
} from '@runtypelabs/mixlayer-ai-provider'
import { streamText } from 'ai'

const wsFetch = createMixlayerWebSocketFetch()
const provider = createMixlayer({
  apiKey: process.env.MIXLAYER_API_KEY,
  thinking: false,
  fetch: wsFetch,
})

try {
  const result = streamText({
    model: provider.responses('qwen/qwen3.5-9b'),
    prompt: 'Say hello over WebSocket.',
  })

  for await (const text of result.textStream) process.stdout.write(text)
} finally {
  wsFetch.close()
}
```

`createMixlayerWebSocketFetch()` is designed to be Workers-friendly by default:
it performs a `fetch()` request with `Upgrade: websocket`, uses
`Response.webSocket`, and calls `accept()` before sending the `response.create`
event. That matches Cloudflare Workers' outbound WebSocket API and keeps this
package free of a hard `ws` / Node.js dependency.

Runtimes that do not expose `Response.webSocket` on upgraded fetch responses
(for example, typical Node.js fetch implementations) can pass a custom
`connect` option. Browsers also cannot attach arbitrary `Authorization` headers
to direct WebSocket handshakes, so browser apps should use a server/Worker
connector or proxy rather than connecting directly with a secret API key.

If you want provider registries or `provider(id)` to use Responses API models,
set `defaultModelApi: 'responses'` in `createMixlayer(...)`.

The provider also slots into `createProviderRegistry`:

```ts
import { createProviderRegistry } from 'ai'

const registry = createProviderRegistry({ mixlayer })
const model = registry.languageModel('mixlayer:qwen/qwen3.6-27b')
```

## Models

Pass any model id from Mixlayer's catalog — see the
[Mixlayer models page](https://docs.mixlayer.com/models) for the live list and
pricing. Ids look like `qwen/qwen3.6-27b` or
`moonshotai/kimi-k2.7-code`.

`MIXLAYER_KNOWN_MODEL_IDS` is the package's readonly snapshot of known ids for
editor autocomplete and offline tooling. `MixlayerChatModelId` derives its
known members from that snapshot but remains open — any model id string is
accepted, so new models and future families work without a package update.
`MIXLAYER_VISION_MODEL_IDS` is the corresponding conservative snapshot for
models validated with image input; `MixlayerVisionModelId` derives from it.

## Sampling and thinking

Mixlayer applies each model's recommended sampling defaults **server-side** (see
the [chat completions parameter reference](https://docs.mixlayer.com/chat-completions#sampling-parameters)
and [per-model notes](https://docs.mixlayer.com/models#qwen-35)), so the
provider does not inject any sampling parameters — only values you set on a
request (`temperature`, `topP`, etc.) are sent.

For Chat Completions models (`provider(id)`, `provider.chat(id)`, and
`provider.chatModel(id)`), the provider sends Mixlayer's documented `thinking`
request field based on the `thinking` setting. It applies **only to Qwen 3.5 /
3.6 models**, so later Qwen generations and other model families pass through
untouched; a `thinking` value you set on the request body yourself wins. Use the
exported `isQwen35Or36(modelId)` helper if you need the same predicate.

Responses API models (`provider.responses(id)`) use the OpenAI Responses request
shape so they remain compatible with Mixlayer's Responses HTTP and WebSocket
endpoints. For Qwen 3.5 / 3.6 Responses API calls, `thinking: false` maps to the
OpenAI-compatible `reasoning.effort: 'none'` request shape because the Responses
API rejects the Chat Completions-only `thinking` field.

## API

| Export                                                          | Description                                                       |
| --------------------------------------------------------------- | ---------------------------------------------------------------- |
| `mixlayer`                                                      | Default provider instance (thinking mode, key from env)          |
| `createMixlayer(settings)`                                      | Provider factory                                                 |
| `createMixlayerWebSocketFetch(options?)`                        | Fetch adapter for Responses API streaming over WebSocket         |
| `MIXLAYER_KNOWN_MODEL_IDS`                                     | Readonly snapshot of known model ids                              |
| `MIXLAYER_VISION_MODEL_IDS`                                    | Readonly snapshot of known image-input model ids                  |
| `extractMixlayerModelId(id)`                                    | Strips a leading `mixlayer/` prefix                              |
| `isQwen35Or36(modelId)`                                         | Whether an id is a Qwen 3.5 / 3.6 model (the scoped generations) |
| `applyQwenThinking(body, thinking?)`                            | Sets the `thinking` field on a request body, scoped to Qwen 3.5 / 3.6 |
| `MIXLAYER_DEFAULT_BASE_URL`                                     | `https://models.mixlayer.ai/v1`                                  |
| `MIXLAYER_DEFAULT_RESPONSES_WEBSOCKET_URL`                      | `wss://models.mixlayer.ai/v1/responses`                          |
| `getMixlayerResponsesWebSocketURL(baseURL?)`                    | Derives a Responses WebSocket URL from an HTTP base URL          |

The provider also exposes:

- `provider.languageModel(id)` — equivalent to calling `provider(id)`
- `provider.chat(id)` / `provider.chatModel(id)` — Chat Completions model
- `provider.responses(id)` / `provider.responsesModel(id)` — Responses API model

### `MixlayerProviderSettings`

| Option            | Type                   | Default                     | Description                                                              |
| ----------------- | ---------------------- | --------------------------- | ------------------------------------------------------------------------ |
| `apiKey`          | `string`               | `MIXLAYER_API_KEY` env      | Mixlayer API key                                                         |
| `baseURL`         | `string`               | `MIXLAYER_DEFAULT_BASE_URL` | Override the inference endpoint                                          |
| `headers`         | `Record<string,string>` | —                           | Extra headers sent with every request                                    |
| `fetch`           | `typeof fetch`         | `globalThis.fetch`          | Custom fetch; pass `createMixlayerWebSocketFetch()` for WS streaming     |
| `includeUsage`    | `boolean`              | —                           | Include usage information in streaming Chat Completions responses        |
| `thinking`        | `boolean`              | `true`                      | Qwen thinking toggle (`thinking` field); Responses uses `reasoning.effort: 'none'` for `false` |
| `defaultModelApi` | `'chat' \| 'responses'` | `'chat'`                    | API used by `provider(id)` and `provider.languageModel(id)`              |

### `createMixlayerWebSocketFetch(options)`

| Option       | Type                  | Default                                  | Description                                      |
| ------------ | --------------------- | ---------------------------------------- | ------------------------------------------------ |
| `url`        | `string`              | Derived from `baseURL`                   | Responses WebSocket destination                  |
| `baseURL`    | `string`              | `MIXLAYER_DEFAULT_BASE_URL`              | HTTP Responses endpoint to intercept; also derives `url` when omitted |
| `headers`    | `Record<string,string>` | —                                      | Extra headers for the WebSocket handshake        |
| `betaHeader` | `string \| false`     | `MIXLAYER_RESPONSES_WEBSOCKET_BETA`      | OpenAI Responses WebSocket beta header value     |
| `fetch`      | `typeof fetch`        | `globalThis.fetch`                       | Fallback fetch and default fetch-upgrade client  |
| `connect`    | WebSocket connector   | Workers-compatible fetch upgrade         | Override for runtimes without `Response.webSocket` |

## License

[MIT](./LICENSE)
