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

    expect(tasks).toHaveLength(16)
    expect(tasks.filter(task => task.transport === 'chat')).toHaveLength(10)
    expect(tasks.filter(task => task.transport === 'responses-http')).toHaveLength(4)
    expect(tasks.filter(task => task.transport === 'responses-websocket')).toEqual([
      expect.objectContaining({
        modelId: 'model-a',
        thinking: true,
        mode: 'stream',
        testCase: cases[0],
      }),
      expect.objectContaining({
        modelId: 'model-a',
        thinking: false,
        mode: 'stream',
        testCase: cases[0],
      }),
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
