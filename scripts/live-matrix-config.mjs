export const LIVE_MODES = ['generate', 'stream']

export function parseAllowedList(value, allowed, label) {
  const selected = parseList(value, allowed)
  const unknown = selected.filter(item => !allowed.includes(item))
  if (unknown.length > 0) {
    throw new Error(`Unknown ${label}(s): ${unknown.join(', ')}`)
  }
  return selected
}

export function createLiveTasks({ models, thinkingModes, transports, cases, modes }) {
  const tasks = []

  for (const modelId of models) {
    for (const thinking of thinkingModes) {
      if (transports.includes('chat')) {
        for (const testCase of cases) {
          if (testCase.thinkingModes && !testCase.thinkingModes.includes(thinking)) {
            continue
          }
          for (const mode of modes) {
            if (testCase.modes.includes(mode)) {
              tasks.push({ modelId, thinking, testCase, mode, transport: 'chat' })
            }
          }
        }
      }

      const defaultCase = cases.find(testCase => testCase.id === 'default')
      if (!defaultCase) continue

      if (transports.includes('responses-http')) {
        for (const mode of modes) {
          if (defaultCase.modes.includes(mode)) {
            tasks.push({
              modelId,
              thinking,
              testCase: defaultCase,
              mode,
              transport: 'responses-http',
            })
          }
        }
      }

      if (transports.includes('responses-websocket') && modes.includes('stream')) {
        tasks.push({
          modelId,
          thinking,
          testCase: defaultCase,
          mode: 'stream',
          transport: 'responses-websocket',
        })
      }
    }
  }

  if (tasks.length === 0) {
    throw new Error(
      `No live validation tasks match transports=${transports.join(',')} cases=${cases
        .map(testCase => testCase.id)
        .join(',')} modes=${modes.join(',')}.`
    )
  }

  return tasks
}

function parseList(value, fallback = []) {
  if (value == null || value === '') return fallback
  if (Array.isArray(value)) return value
  return String(value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}
