import { streamText } from 'ai'
import { describe, expect, it } from 'vitest'

import {
  createMixlayer,
  createMixlayerWebSocketFetch,
  type MixlayerWebSocketConnection,
} from '../src/index'

class ErrorWebSocket extends EventTarget implements MixlayerWebSocketConnection {
  readyState = 1

  constructor(private readonly frame: Record<string, unknown>) {
    super()
  }

  send() {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(this.frame) }))
  }

  close() {
    this.readyState = 3
    this.dispatchEvent(new Event('close'))
  }
}

async function streamErrors(frame: Record<string, unknown>): Promise<unknown[]> {
  const fetch = createMixlayerWebSocketFetch({
    connect: async () => new ErrorWebSocket(frame),
  })

  try {
    const provider = createMixlayer({ apiKey: 'test-key', fetch })
    const result = streamText({
      model: provider.responses('qwen/qwen3.8-27b'),
      prompt: 'Say hello',
      maxRetries: 0,
      onError: () => {},
    })
    const errors: unknown[] = []
    for await (const part of result.stream) {
      if (part.type === 'error') errors.push(part.error)
    }
    return errors
  } finally {
    fetch.close()
  }
}

describe('Responses WebSocket error compatibility', () => {
  it('surfaces the upstream failure from an unnumbered Mixlayer error frame', async () => {
    const errors = await streamErrors({
      type: 'error',
      status: 500,
      error: {
        type: 'server_error',
        code: 'model_server_error',
        message: 'failed to prefill rendered prompt',
      },
    })

    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      name: 'AI_APICallError',
      message: 'failed to prefill rendered prompt',
      statusCode: 500,
      data: {
        error: {
          type: 'server_error',
          code: 'model_server_error',
          message: 'failed to prefill rendered prompt',
        },
      },
    })
  })

  it('preserves a numbered, flat Responses error frame', async () => {
    const errors = await streamErrors({
      type: 'error',
      sequence_number: 42,
      code: 'invalid_request_error',
      message: 'The requested model does not support this input.',
      param: 'input',
    })

    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      name: 'AI_APICallError',
      message: 'The requested model does not support this input.',
      statusCode: 400,
      data: {
        type: 'error',
        sequence_number: 42,
        code: 'invalid_request_error',
        param: 'input',
      },
    })
  })
})
