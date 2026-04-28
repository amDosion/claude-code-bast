import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  resetStateForTests,
  setCwdState,
  setOriginalCwd,
  setProjectRoot,
} from '../../../bootstrap/state'
import {
  createAutonomyQueuedPrompt,
  getAutonomyRunById,
  listAutonomyRuns,
  markAutonomyRunRunning,
} from '../../autonomyRuns'
import { resetAutonomyAuthorityForTests } from '../../autonomyAuthority'
import { createScheduledTaskQueuedCommand } from '../../../hooks/useScheduledTasks'
import {
  cleanupTempDir,
  createTempDir,
} from '../../../../tests/mocks/file-system'

let runAgentBlocker: Promise<void> | null = null
let releaseRunAgentBlocker: (() => void) | null = null
let runAgentStartCount = 0

function holdRunAgent(): void {
  runAgentBlocker = new Promise(resolve => {
    releaseRunAgentBlocker = resolve
  })
}

function releaseRunAgent(): void {
  releaseRunAgentBlocker?.()
  runAgentBlocker = null
  releaseRunAgentBlocker = null
}

mock.module('bun:bundle', () => ({
  feature: (name: string) => name === 'KAIROS',
}))

mock.module('src/commands.js', () => ({
  builtInCommandNames: () => new Set(['forked']),
  clearCommandsCache: () => {},
  findCommand: (commandName: string, commands: any[]) =>
    commands.find(
      command =>
        command.name === commandName ||
        command.userFacingName?.() === commandName ||
        command.aliases?.includes(commandName),
    ),
  getCommand: (commandName: string, commands: any[]) => {
    const command = commands.find(
      command =>
        command.name === commandName ||
        command.userFacingName?.() === commandName ||
        command.aliases?.includes(commandName),
    )
    if (!command) {
      throw new ReferenceError(`Command ${commandName} not found`)
    }
    return command
  },
  getCommandName: (command: { name: string; userFacingName?: () => string }) =>
    command.userFacingName?.() ?? command.name,
  getCommands: async () => [],
  getMcpSkillCommands: async () => [],
  getSlashCommandToolSkills: async () => [],
  getSkillToolCommands: async () => [],
  hasCommand: (commandName: string, commands: any[]) =>
    commands.some(
      command =>
        command.name === commandName ||
        command.userFacingName?.() === commandName ||
        command.aliases?.includes(commandName),
    ),
}))

mock.module(
  '@claude-code-best/builtin-tools/tools/AgentTool/runAgent.js',
  () => ({
    runAgent: async function* () {
      runAgentStartCount += 1
      if (runAgentBlocker) {
        await runAgentBlocker
      }
      yield {
        type: 'assistant',
        uuid: 'assistant-1',
        timestamp: new Date().toISOString(),
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [{ type: 'text', text: 'forked command done' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
          },
        },
      }
    },
  }),
)

mock.module('@claude-code-best/builtin-tools/tools/AgentTool/UI.js', () => ({
  AgentPromptDisplay: () => null,
  AgentResponseDisplay: () => null,
  extractLastToolInfo: () => null,
  renderGroupedAgentToolUse: () => null,
  renderToolResultMessage: () => null,
  renderToolUseErrorMessage: () => null,
  renderToolUseMessage: () => null,
  renderToolUseProgressMessage: () => null,
  renderToolUseRejectedMessage: () => null,
  renderToolUseTag: () => null,
  userFacingName: () => 'Agent',
  userFacingNameBackgroundColor: () => 'gray',
}))

const { processSlashCommand } = await import('../processSlashCommand')
const { getCommandQueue, resetCommandQueue } = await import(
  '../../messageQueueManager'
)

let tempDir = ''

async function waitForRunStatus(
  runId: string,
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled',
): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const run = await getAutonomyRunById(runId, tempDir)
    if (run?.status === status) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const run = await getAutonomyRunById(runId, tempDir)
  throw new Error(`Expected ${runId} to be ${status}, got ${run?.status}`)
}

async function waitForRunAgentStarts(expected: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (runAgentStartCount >= expected) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(
    `Expected runAgent to start ${expected} time(s), got ${runAgentStartCount}`,
  )
}

beforeEach(async () => {
  tempDir = await createTempDir('process-slash-command-')
  runAgentBlocker = null
  releaseRunAgentBlocker = null
  runAgentStartCount = 0
  resetStateForTests()
  resetAutonomyAuthorityForTests()
  resetCommandQueue()
  setOriginalCwd(tempDir)
  setProjectRoot(tempDir)
  setCwdState(tempDir)
})

afterEach(async () => {
  releaseRunAgent()
  resetStateForTests()
  resetAutonomyAuthorityForTests()
  resetCommandQueue()
  if (tempDir) {
    await cleanupTempDir(tempDir)
  }
})

describe('processSlashCommand', () => {
  const forkedCommand = {
    type: 'prompt',
    name: 'forked',
    description: 'test forked command',
    progressMessage: 'forking',
    contentLength: 0,
    source: 'builtin',
    context: 'fork',
    getPromptForCommand: async () => [
      { type: 'text', text: 'review from fork' },
    ],
  } as const

  function createContext() {
    return {
      getAppState: () => ({
        kairosEnabled: true,
        mcp: { clients: [] },
        toolPermissionContext: {
          mode: 'default',
          alwaysAllowRules: {},
        },
      }),
      options: {
        commands: [forkedCommand],
        allowBackgroundForkedSlashCommands: true,
        tools: [],
        refreshTools: () => [],
        agentDefinitions: {
          activeAgents: [{ agentType: 'general-purpose' }],
        },
      },
      setResponseLength: mock((_updater: (length: number) => number) => {}),
    } as any
  }

  test('defers autonomy completion until a KAIROS background forked command completes', async () => {
    const queued = await createAutonomyQueuedPrompt({
      basePrompt: '/forked review',
      trigger: 'scheduled-task',
      rootDir: tempDir,
      currentDir: tempDir,
      sourceId: 'cron-1',
    })
    expect(queued).not.toBeNull()
    const runId = queued!.autonomy!.runId
    await markAutonomyRunRunning(runId, tempDir, 100)

    const result = await processSlashCommand(
      '/forked review',
      [],
      [],
      [],
      createContext(),
      mock(() => {}),
      undefined,
      false,
      async () => ({ behavior: 'allow', updatedInput: {} }) as any,
      queued!.autonomy,
    )

    expect(result).toMatchObject({
      messages: [],
      shouldQuery: false,
      deferAutonomyCompletion: true,
    })

    await waitForRunStatus(runId, 'completed')
    expect(getCommandQueue()).toEqual([
      expect.objectContaining({
        mode: 'prompt',
        isMeta: true,
        skipSlashCommands: true,
        value: expect.stringContaining(
          '<scheduled-task-result command="/forked">',
        ),
      }),
    ])
  })

  test('keeps repeated /loop scheduled fires bounded while a background fork is running', async () => {
    const task = {
      id: 'cron-loop',
      prompt: '/forked review',
    }
    const first = await createScheduledTaskQueuedCommand(task)
    expect(first?.autonomy?.runId).toBeDefined()
    const runId = first!.autonomy!.runId
    await markAutonomyRunRunning(runId, tempDir, 100)

    holdRunAgent()
    const result = await processSlashCommand(
      '/forked review',
      [],
      [],
      [],
      createContext(),
      mock(() => {}),
      undefined,
      false,
      async () => ({ behavior: 'allow', updatedInput: {} }) as any,
      first!.autonomy,
    )

    expect(result.deferAutonomyCompletion).toBe(true)
    await waitForRunAgentStarts(1)

    const repeatedFires = await Promise.all(
      Array.from({ length: 200 }, () => createScheduledTaskQueuedCommand(task)),
    )
    expect(repeatedFires.every(command => command === null)).toBe(true)
    expect(
      (await listAutonomyRuns(tempDir)).filter(
        run => run.sourceId === 'cron-loop',
      ),
    ).toHaveLength(1)
    expect(getCommandQueue()).toHaveLength(0)

    releaseRunAgent()
    await waitForRunStatus(runId, 'completed')
    expect(getCommandQueue()).toHaveLength(1)

    const next = await createScheduledTaskQueuedCommand(task)
    expect(next?.autonomy?.runId).toBeDefined()
    expect(
      (await listAutonomyRuns(tempDir)).filter(
        run => run.sourceId === 'cron-loop',
      ),
    ).toHaveLength(2)
  })
})
