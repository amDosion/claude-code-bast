/**
 * Regression tests for ultrareviewCommand preflight integration.
 * Mocks fetchUltrareviewPreflight to verify the three action paths:
 * proceed / confirm / blocked.
 */
import { describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'

// Mock dependency chain before any subject import
mock.module('src/utils/debug.ts', debugMock)
mock.module('src/utils/log.ts', logMock)
mock.module('src/services/analytics/index.js', () => ({
  logEvent: () => {},
}))
mock.module('src/services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => null,
}))

// Mock auth utilities
mock.module('src/utils/auth.js', () => ({
  isClaudeAISubscriber: () => true,
  isTeamSubscriber: () => false,
  isEnterpriseSubscriber: () => false,
}))

// Mock checkOverageGate to always return proceed (gate logic tested separately)
mock.module('src/commands/review/reviewRemote.js', () => ({
  checkOverageGate: async () => ({ kind: 'proceed', billingNote: '' }),
  confirmOverage: () => {},
  launchRemoteReview: async () => [{ type: 'text', text: 'Launched successfully.' }],
}))

// Mock preflight module — we'll override per-test via the mock variable
const mockFetchPreflight = mock(async (_args: unknown) => null as unknown)

mock.module('src/services/api/ultrareviewPreflight.js', () => ({
  fetchUltrareviewPreflight: mockFetchPreflight,
}))

// Mock detectCurrentRepositoryWithHost
mock.module('src/utils/detectRepository.js', () => ({
  detectCurrentRepositoryWithHost: async () => ({
    host: 'github.com',
    owner: 'testowner',
    name: 'testrepo',
  }),
}))

// Minimal mock for React/Ink so we don't need a full renderer
mock.module('react', () => {
  const createElement = (type: unknown, props: unknown, ...children: unknown[]) => ({
    $$typeof: Symbol.for('react.element'),
    type,
    props: { ...(props as object), children },
  })
  return { default: { createElement }, createElement }
})

mock.module('@anthropic/ink', () => ({
  Box: 'Box',
  Dialog: 'Dialog',
  Text: 'Text',
}))

mock.module('src/components/CustomSelect/select.js', () => ({
  Select: 'Select',
}))

// UltrareviewOverageDialog and PreflightDialog — return a simple marker
mock.module('src/commands/review/UltrareviewOverageDialog.js', () => ({
  UltrareviewOverageDialog: () => ({ type: 'UltrareviewOverageDialog' }),
}))
mock.module('src/commands/review/UltrareviewPreflightDialog.js', () => ({
  UltrareviewPreflightDialog: () => ({ type: 'UltrareviewPreflightDialog' }),
}))

import { call } from '../ultrareviewCommand.js'

const makeContext = () =>
  ({
    abortController: { signal: {} },
  }) as Parameters<typeof call>[1]

describe('ultrareviewCommand preflight integration', () => {
  test('proceed action: launches immediately without dialog', async () => {
    mockFetchPreflight.mockImplementationOnce(async () => ({
      action: 'proceed',
      billing_note: null,
    }))

    const messages: string[] = []
    const onDone = (msg: string) => messages.push(msg)

    const result = await call(onDone as Parameters<typeof call>[0], makeContext(), '')
    // Should not render a dialog — returns null after calling onDone
    expect(result).toBeNull()
    expect(messages.length).toBe(1)
    expect(messages[0]).toContain('Launched successfully')
  })

  test('blocked action: calls onDone with unavailable message', async () => {
    mockFetchPreflight.mockImplementationOnce(async () => ({
      action: 'blocked',
      billing_note: null,
    }))

    const messages: string[] = []
    const opts: Array<unknown> = []
    const onDone = (msg: string, opt: unknown) => {
      messages.push(msg)
      opts.push(opt)
    }

    const result = await call(onDone as Parameters<typeof call>[0], makeContext(), '')
    expect(result).toBeNull()
    expect(messages.length).toBe(1)
    expect(messages[0]).toBe('Ultrareview is currently unavailable.')
    expect((opts[0] as { display: string }).display).toBe('system')
  })

  test('blocked action with billing_note: shows billing_note as message', async () => {
    mockFetchPreflight.mockImplementationOnce(async () => ({
      action: 'blocked',
      billing_note: 'Ultrareview is unavailable for your organization.',
    }))

    const messages: string[] = []
    const onDone = (msg: string) => messages.push(msg)

    await call(onDone as Parameters<typeof call>[0], makeContext(), '')
    expect(messages[0]).toBe('Ultrareview is unavailable for your organization.')
  })

  test('confirm action: returns UltrareviewPreflightDialog element', async () => {
    mockFetchPreflight.mockImplementationOnce(async () => ({
      action: 'confirm',
      billing_note: 'This run will cost ~$2.',
    }))

    const onDone = (_msg: string) => {}
    const result = await call(onDone as Parameters<typeof call>[0], makeContext(), '')
    // Should return a React element (the PreflightDialog)
    expect(result).not.toBeNull()
    expect(typeof result).toBe('object')
    // The element type should be the PreflightDialog component
    const element = result as { type: unknown }
    expect(element.type).toBeDefined()
  })

  test('null preflight (network failure): falls back to direct launch', async () => {
    mockFetchPreflight.mockImplementationOnce(async () => null)

    const messages: string[] = []
    const onDone = (msg: string) => messages.push(msg)

    const result = await call(onDone as Parameters<typeof call>[0], makeContext(), '')
    expect(result).toBeNull()
    expect(messages.length).toBe(1)
    expect(messages[0]).toContain('Launched successfully')
  })

  test('PR number args: extracts pr_number for preflight request', async () => {
    const capturedArgs: Array<unknown> = []
    mockFetchPreflight.mockImplementationOnce(async (args: unknown) => {
      capturedArgs.push(args)
      return { action: 'proceed', billing_note: null }
    })

    const messages: string[] = []
    const onDone = (msg: string) => messages.push(msg)

    await call(onDone as Parameters<typeof call>[0], makeContext(), '42')

    expect(capturedArgs.length).toBe(1)
    const a = capturedArgs[0] as { pr_number: number; repo: string }
    expect(a.pr_number).toBe(42)
    expect(a.repo).toBe('testowner/testrepo')
  })
})
