import { describe, expect, it } from 'vitest'
import {
  LIVE_MODES,
  createLiveTasks,
  parseAllowedList,
} from '../scripts/live-matrix-config.mjs'

const cases = [
  { id: 'default', modes: ['generate', 'stream'] },
  { id: 'temperature', modes: ['generate', 'stream'] },
  { id: 'playground-sampling', modes: ['stream'] },
  {
    id: 'vision',
    modes: ['generate', 'stream'],
    transports: ['chat', 'responses-http', 'responses-websocket'],
    modelIds: ['model-a'],
  },
]

describe('live matrix configuration', () => {
  it('generates the expected chat and Responses tasks', () => {
    const tasks = createLiveTasks({
      models: ['model-a'],
      thinkingModes: [true, false],
      transports: ['chat', 'responses-http', 'responses-websocket'],
      cases,
      modes: [...LIVE_MODES],
    })

    expect(tasks).toHaveLength(26)
    expect(tasks.filter(task => task.transport === 'chat')).toHaveLength(14)
    expect(tasks.filter(task => task.transport === 'responses-http')).toHaveLength(8)
    expect(tasks.filter(task => task.transport === 'responses-websocket')).toEqual([
      expect.objectContaining({
        modelId: 'model-a',
        thinking: true,
        mode: 'stream',
        testCase: cases[0],
      }),
      expect.objectContaining({
        modelId: 'model-a',
        thinking: true,
        mode: 'stream',
        testCase: cases[3],
      }),
      expect.objectContaining({
        modelId: 'model-a',
        thinking: false,
        mode: 'stream',
        testCase: cases[0],
      }),
      expect.objectContaining({
        modelId: 'model-a',
        thinking: false,
        mode: 'stream',
        testCase: cases[3],
      }),
    ])
  })

  it('limits capability-specific cases to their declared models and transports', () => {
    const visionCase = cases[3]
    const tasks = createLiveTasks({
      models: ['model-a', 'model-b'],
      thinkingModes: [false],
      transports: ['chat', 'responses-http', 'responses-websocket'],
      cases: [visionCase],
      modes: [...LIVE_MODES],
    })

    expect(tasks).toHaveLength(5)
    expect(tasks.every(task => task.modelId === 'model-a')).toBe(true)
    expect(tasks.map(task => `${task.transport}/${task.mode}`)).toEqual([
      'chat/generate',
      'chat/stream',
      'responses-http/generate',
      'responses-http/stream',
      'responses-websocket/stream',
    ])
  })

  it('normalizes routed model ids for capability filtering', () => {
    const visionCase = {
      id: 'vision',
      modes: ['generate'],
      transports: ['chat'],
      modelIds: ['qwen/qwen3.6-27b'],
    }
    const tasks = createLiveTasks({
      models: [
        'mixlayer/qwen/qwen3.6-27b',
        'mixlayer:qwen/qwen3.6-27b',
      ],
      thinkingModes: [false],
      transports: ['chat'],
      cases: [visionCase],
      modes: ['generate'],
      normalizeModelId: modelId => modelId.replace(/^mixlayer[/:]/, ''),
    })

    expect(tasks.map(task => task.modelId)).toEqual([
      'mixlayer/qwen/qwen3.6-27b',
      'mixlayer:qwen/qwen3.6-27b',
    ])
  })

  it('rejects unknown modes', () => {
    expect(() => parseAllowedList('generate,typo', LIVE_MODES, 'mode')).toThrow(
      'Unknown mode(s): typo'
    )
  })

  it('rejects a Responses HTTP selection without the default case', () => {
    expect(() =>
      createLiveTasks({
        models: ['model-a'],
        thinkingModes: [false],
        transports: ['responses-http'],
        cases: [cases[1]],
        modes: ['stream'],
      })
    ).toThrow('No live validation tasks match')
  })

  it('rejects generate-only Responses WebSocket selections', () => {
    expect(() =>
      createLiveTasks({
        models: ['model-a'],
        thinkingModes: [false],
        transports: ['responses-websocket'],
        cases: [cases[0]],
        modes: ['generate'],
      })
    ).toThrow('No live validation tasks match')
  })
})
