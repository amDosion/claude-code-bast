import { describe, test, expect, mock, beforeEach } from 'bun:test'

// ── Mock infrastructure ─────────────────────────────────────────────────────
// All mock.module calls must precede the import of the module under test.
// mock.module is process-global; mocks here must cover all exported names used
// transitively so sibling test files are not broken by an incomplete mock.

const mockGetMainLoopModel = mock(() => 'claude-opus-4-7')
const mockGetDisplayedEffortLevel = mock(() => 'high' as const)

mock.module('src/utils/model/model.js', () => ({
  getMainLoopModel: mockGetMainLoopModel,
  getSmallFastModel: mock(() => 'claude-haiku'),
  getUserSpecifiedModelSetting: mock(() => undefined),
  getBestModel: mock(() => 'claude-opus-4-7'),
  getDefaultOpusModel: mock(() => 'claude-opus-4-7'),
  getDefaultSonnetModel: mock(() => 'claude-sonnet-4-6'),
  getDefaultHaikuModel: mock(() => 'claude-haiku-3-5'),
  getRuntimeMainLoopModel: mock(() => 'claude-opus-4-7'),
  getDefaultMainLoopModelSetting: mock(() => 'claude-opus-4-7'),
  getDefaultMainLoopModel: mock(() => 'claude-opus-4-7'),
  firstPartyNameToCanonical: mock((n: string) => n),
  getCanonicalName: mock((n: string) => n),
  getClaudeAiUserDefaultModelDescription: mock(() => ''),
  renderDefaultModelSetting: mock(() => ''),
  getOpusPricingSuffix: mock(() => ''),
  isOpus1mMergeEnabled: mock(() => false),
  renderModelSetting: mock((s: string) => s),
  getPublicModelDisplayName: mock(() => null),
  renderModelName: mock((n: string) => n),
  getPublicModelName: mock((n: string) => n),
  parseUserSpecifiedModel: mock((m: string) => m),
  resolveSkillModelOverride: mock(() => undefined),
  isLegacyModelRemapEnabled: mock(() => false),
  modelDisplayString: mock(() => ''),
  getMarketingNameForModel: mock(() => undefined),
  normalizeModelStringForAPI: mock((m: string) => m),
  isNonCustomOpusModel: mock(() => false),
}))

mock.module('src/utils/effort.js', () => ({
  getDisplayedEffortLevel: mockGetDisplayedEffortLevel,
  getEffortEnvOverride: mock(() => undefined),
  resolveAppliedEffort: mock(() => 'high'),
  getInitialEffortSetting: mock(() => undefined),
  parseEffortValue: mock(() => undefined),
  toPersistableEffort: mock(() => undefined),
  modelSupportsEffort: mock(() => true),
  modelSupportsMaxEffort: mock(() => true),
  modelSupportsXhighEffort: mock(() => false),
  isEffortLevel: mock(() => true),
  getEffortSuffix: mock(() => ''),
  convertEffortValueToLevel: mock(() => 'high'),
  getDefaultEffortForModel: mock(() => undefined),
  getEffortLevelDescription: mock(() => ''),
  getEffortValueDescription: mock(() => ''),
  getOpusDefaultEffortConfig: mock(() => ({
    enabled: true,
    dialogTitle: '',
    dialogDescription: '',
  })),
  resolvePickerEffortPersistence: mock(() => undefined),
  isValidNumericEffort: mock(() => false),
  EFFORT_LEVELS: ['low', 'medium', 'high', 'xhigh', 'max'],
}))

mock.module('src/utils/envUtils.js', () => ({
  getClaudeConfigHomeDir: mock(() => '/mock/home/.claude'),
  isEnvTruthy: mock(() => false),
  getEnvBool: mock(() => false),
  getEnvNumber: mock(() => undefined),
  getVertexRegionForModel: mock(() => undefined),
}))

mock.module('src/utils/log.js', () => ({
  logError: mock(() => {}),
  getLogDisplayTitle: mock(() => ''),
  dateToFilename: mock((d: Date) => d.toISOString()),
  attachErrorLogSink: mock(() => {}),
  getInMemoryErrors: mock(() => []),
  loadErrorLogs: mock(async () => []),
  getErrorLogByIndex: mock(async () => null),
  logMCPError: mock(() => {}),
  logMCPDebug: mock(() => {}),
  captureAPIRequest: mock(() => {}),
  _resetErrorLogForTesting: mock(() => {}),
}))

mock.module('src/services/tokenEstimation.js', () => ({
  roughTokenCountEstimation: mock((s: string) => Math.ceil(s.length / 4)),
  countTokens: mock(async () => 0),
}))

mock.module('src/utils/errors.js', () => ({
  getErrnoCode: mock((e: unknown) => (e as NodeJS.ErrnoException)?.code),
  toError: mock((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
}))

// Mock fs/promises so loadSessionMemoryPrompt() and loadSessionMemoryTemplate()
// return our controlled templates
const mockReadFileFsPromises = mock(
  async (_path: string, _opts?: unknown): Promise<string> => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  },
)

mock.module('fs/promises', () => ({
  readFile: mockReadFileFsPromises,
}))

// ── Import module under test (after all mock.module calls) ──────────────────
import { buildSessionMemoryUpdatePrompt } from '../prompts.js'

// ── Tests ───────────────────────────────────────────────────────────────────

describe('buildSessionMemoryUpdatePrompt – dynamic variable substitution', () => {
  beforeEach(() => {
    mockGetMainLoopModel.mockReturnValue('claude-opus-4-7')
    mockGetDisplayedEffortLevel.mockReturnValue('high')
    // Default: ENOENT so the built-in default prompt is used
    mockReadFileFsPromises.mockImplementation(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
  })

  test('substitutes {{CLAUDE_MODEL}} with the current model', async () => {
    mockReadFileFsPromises.mockImplementation(async (path: string) => {
      if ((path as string).includes('prompt.md')) return 'Model: {{CLAUDE_MODEL}}'
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockGetMainLoopModel.mockReturnValue('claude-opus-4-7')

    const result = await buildSessionMemoryUpdatePrompt('notes', '/notes.md')
    expect(result).toContain('Model: claude-opus-4-7')
    expect(result).not.toContain('{{CLAUDE_MODEL}}')
  })

  test('substitutes {{CLAUDE_EFFORT}} with the current effort level', async () => {
    mockReadFileFsPromises.mockImplementation(async (path: string) => {
      if ((path as string).includes('prompt.md')) return 'Effort: {{CLAUDE_EFFORT}}'
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockGetDisplayedEffortLevel.mockReturnValue('high')

    const result = await buildSessionMemoryUpdatePrompt('notes', '/notes.md')
    expect(result).toContain('Effort: high')
    expect(result).not.toContain('{{CLAUDE_EFFORT}}')
  })

  test('substitutes {{CLAUDE_CWD}} with process.cwd()', async () => {
    mockReadFileFsPromises.mockImplementation(async (path: string) => {
      if ((path as string).includes('prompt.md')) return 'CWD: {{CLAUDE_CWD}}'
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const result = await buildSessionMemoryUpdatePrompt('notes', '/notes.md')
    expect(result).toContain(`CWD: ${process.cwd()}`)
    expect(result).not.toContain('{{CLAUDE_CWD}}')
  })

  test('substitutes all three dynamic variables in one template', async () => {
    mockReadFileFsPromises.mockImplementation(async (path: string) => {
      if ((path as string).includes('prompt.md'))
        return 'effort={{CLAUDE_EFFORT}} model={{CLAUDE_MODEL}} cwd={{CLAUDE_CWD}}'
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockGetMainLoopModel.mockReturnValue('claude-sonnet-4-6')
    mockGetDisplayedEffortLevel.mockReturnValue('medium')

    const result = await buildSessionMemoryUpdatePrompt('notes', '/notes.md')
    expect(result).toContain('effort=medium')
    expect(result).toContain('model=claude-sonnet-4-6')
    expect(result).toContain(`cwd=${process.cwd()}`)
  })

  test('leaves unknown template variables unchanged', async () => {
    mockReadFileFsPromises.mockImplementation(async (path: string) => {
      if ((path as string).includes('prompt.md'))
        return '{{UNKNOWN_VAR}} {{CLAUDE_MODEL}}'
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockGetMainLoopModel.mockReturnValue('claude-opus-4-7')

    const result = await buildSessionMemoryUpdatePrompt('notes', '/notes.md')
    expect(result).toContain('{{UNKNOWN_VAR}}')
    expect(result).toContain('claude-opus-4-7')
  })

  test('existing substitution variables still work alongside new ones', async () => {
    mockReadFileFsPromises.mockImplementation(async (path: string) => {
      if ((path as string).includes('prompt.md'))
        return '{{notesPath}} effort={{CLAUDE_EFFORT}} model={{CLAUDE_MODEL}}'
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockGetMainLoopModel.mockReturnValue('claude-haiku')
    mockGetDisplayedEffortLevel.mockReturnValue('low')

    const result = await buildSessionMemoryUpdatePrompt('notes', '/notes.md')
    expect(result).toContain('/notes.md')
    expect(result).toContain('effort=low')
    expect(result).toContain('model=claude-haiku')
  })
})
