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
      for (const transport of transports) {
        if (transport === 'responses-websocket' && !modes.includes('stream')) {
          continue
        }

        for (const testCase of cases) {
          if (testCase.thinkingModes && !testCase.thinkingModes.includes(thinking)) {
            continue
          }
          if (testCase.modelIds && !testCase.modelIds.includes(modelId)) {
            continue
          }
          if (!supportsTransport(testCase, transport)) {
            continue
          }

          for (const mode of modes) {
            if (!testCase.modes.includes(mode)) continue
            if (transport === 'responses-websocket' && mode !== 'stream') continue
            tasks.push({ modelId, thinking, testCase, mode, transport })
          }
        }
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

function supportsTransport(testCase, transport) {
  if (testCase.transports) return testCase.transports.includes(transport)
  return transport === 'chat' || testCase.id === 'default'
}

function parseList(value, fallback = []) {
  if (value == null || value === '') return fallback
  if (Array.isArray(value)) return value
  return String(value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}
