import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug'
import { logMock } from '../../../../tests/mocks/log'
import { asAgentId } from '../../../types/ids.js'
import type { Message } from '../../../types/message.js'
import type { CacheSafeParams } from '../../../utils/forkedAgent.js'
import * as sessionStorageModule from '../../../utils/sessionStorage.js'

const transcriptMessages = [
  { type: 'user', message: { content: 'start' }, uuid: 'u1' },
  {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'working' }] },
    uuid: 'a1',
  },
  { type: 'user', message: { content: 'continue' }, uuid: 'u2' },
] as unknown as Message[]

type ForkCall = {
  cacheSafeParams: CacheSafeParams
}

describe('startAgentSummarization', () => {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  let scheduled: (() => void | Promise<void>) | undefined
  let handle: { stop: () => void } | undefined
  let forkCalls: ForkCall[]
  let updateCalls: Array<{ taskId: string; summary: string }>

  beforeEach(() => {
    forkCalls = []
    updateCalls = []
    scheduled = undefined
    handle = undefined

    mock.module('src/commands/poor/poorMode.js', () => ({
      isPoorModeActive: () => false,
    }))
    mock.module('src/tasks/LocalAgentTask/LocalAgentTask.js', () => ({
      updateAgentSummary: (taskId: string, summary: string) => {
        updateCalls.push({ taskId, summary })
      },
    }))
    mock.module('src/utils/debug.js', debugMock)
    mock.module('src/utils/log.js', logMock)
    mock.module('src/utils/sessionStorage.js', () => ({
      ...sessionStorageModule,
      getAgentTranscript: async () => ({ messages: transcriptMessages }),
    }))
    mock.module('src/utils/forkedAgent.js', () => ({
      runForkedAgent: async (args: ForkCall) => {
        forkCalls.push(args)
        return {
          messages: [
            {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: 'Reading udsClient.ts' }],
              },
            },
          ],
        }
      },
    }))

    globalThis.setTimeout = ((callback: TimerHandler) => {
      if (typeof callback !== 'function') {
        throw new Error('Expected timer callback')
      }
      scheduled = callback as () => void | Promise<void>
      return 1 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout
    globalThis.clearTimeout = (() => undefined) as typeof clearTimeout
  })

  afterEach(() => {
    handle?.stop()
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
    // Defensive cleanup: this file mocks side-effect modules that otherwise
    // leak across Bun's shared in-process test runtime.
    mock.restore()
    mock.module('src/utils/sessionStorage.js', () => sessionStorageModule)
  })

  test('summarizes bounded transcript once and skips unchanged fingerprints', async () => {
    const { startAgentSummarization } = await import('../agentSummary.js')

    handle = startAgentSummarization(
      'task-1',
      asAgentId('a0000000000000000'),
      {
        forkContextMessages: [
          { type: 'user', message: { content: 'stale' }, uuid: 'old' },
        ],
        model: 'claude-test',
      } as unknown as CacheSafeParams,
      () => undefined,
    )

    expect(typeof scheduled).toBe('function')
    await scheduled!()

    expect(forkCalls).toHaveLength(1)
    expect(updateCalls).toEqual([
      { taskId: 'task-1', summary: 'Reading udsClient.ts' },
    ])

    const forkContext = forkCalls[0].cacheSafeParams.forkContextMessages ?? []
    expect(forkContext.map(message => String(message.uuid))).toEqual([
      'u1',
      'a1',
      'u2',
    ])
    expect(forkContext.some(message => String(message.uuid) === 'old')).toBe(
      false,
    )

    await scheduled!()

    expect(forkCalls).toHaveLength(1)
    expect(updateCalls).toHaveLength(1)
  })
})
