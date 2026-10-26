import { createProviderRegistry, experimental_decide } from 'ai'
import { InvalidArgumentError, UnsupportedFunctionalityError } from '@ai-sdk/provider'
import { describe, expect, it } from 'vitest'
import { createMixlayer, MIXLAYER_DECISION_MODEL_IDS } from '../src/index'

const JINI = 'mixlayer/jini-qwen3.8-27b'

function createDecisionSuccessBody() {
  return {
    model: JINI,
    answers: [
      { type: 'predicate', name: 'angry', probability: 0.99 },
      {
        type: 'choice',
        name: 'intent',
        choice: 'refund',
        probabilities: [
          { value: 'refund', probability: 0.97 },
          { value: 'other', probability: 0.03 },
        ],
        confidence: 0.96,
      },
    ],
    usage: { input_tokens: 518, output_tokens: 0, total_tokens: 518 },
  }
}

function createRecordingProvider() {
  const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = []
  const provider = createMixlayer({
    apiKey: 'test',
    fetch: async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
        headers: new Headers(init?.headers),
      })
      return new Response(JSON.stringify(createDecisionSuccessBody()), {
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  return { provider, requests }
}

describe('decisionModel', () => {
  it('exports the decision model snapshot', () => {
    expect(MIXLAYER_DECISION_MODEL_IDS).toEqual([JINI])
  })

  it('posts OpenAI-format decisions to the Mixlayer endpoint', async () => {
    const { provider, requests } = createRecordingProvider()

    const result = await experimental_decide({
      model: provider.decisionModel(JINI),
      state: 'Customer: my order arrived broken and I want a refund NOW.',
      questions: {
        angry: { type: 'boolean', instructions: 'Is the customer angry?' },
        intent: {
          type: 'choice',
          instructions: 'What does the customer want?',
          criteria: { refund: null, other: null },
        },
      },
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://mixlayer.ai/v1/decisions')
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer test')
    expect(requests[0]?.body).toMatchObject({
      model: JINI,
      questions: [
        { type: 'predicate', name: 'angry' },
        { type: 'choice', name: 'intent' },
      ],
    })
    expect(result.answers.angry).toMatchObject({ type: 'boolean', probability: 0.99 })
    expect(result.answers.intent).toMatchObject({ type: 'choice', choice: 'refund' })
  })

  it('keeps the first-party model id intact', () => {
    const { provider } = createRecordingProvider()
    expect(provider.decisionModel(JINI).modelId).toBe(JINI)
    expect(provider.decisionModel(`mixlayer:${JINI}`).modelId).toBe(JINI)
  })

  it('rejects file state before sending a request', async () => {
    const { provider, requests } = createRecordingProvider()
    const model = provider.decisionModel(JINI)

    await expect(
      model.doDecide({
        state: [
          {
            type: 'file',
            mediaType: 'image/png',
            data: { type: 'data', data: new Uint8Array([1]) },
          },
        ],
        questions: { q: { type: 'boolean', instructions: 'Is it red?' } },
      })
    ).rejects.toBeInstanceOf(UnsupportedFunctionalityError)
    expect(requests).toHaveLength(0)
  })

  it.each([
    ['choice', { type: 'choice', criteria: { refund: null, other: null } }],
    ['score', { type: 'score', instructions: '', criteria: ['low', 'high'] }],
  ] as const)(
    'rejects %s questions without instructions before sending a request',
    async (_type, question) => {
      const { provider, requests } = createRecordingProvider()

      await expect(
        provider.decisionModel(JINI).doDecide({
          state: [{ type: 'text', text: 'I want a refund' }],
          questions: { q: question },
        })
      ).rejects.toBeInstanceOf(InvalidArgumentError)
      expect(requests).toHaveLength(0)
    }
  )

  it('does not advertise box questions', () => {
    const { provider } = createRecordingProvider()
    expect(provider.decisionModel(JINI).supportedQuestionTypes).not.toContain('box')
  })

  it('resolves through a provider registry', () => {
    const { provider } = createRecordingProvider()
    const registry = createProviderRegistry({ mixlayer: provider })
    const model = registry.decisionModel(`mixlayer:${JINI}`)

    expect(model.modelId).toBe(JINI)
    expect(model.provider).toBe('mixlayer.decision')
  })
})
