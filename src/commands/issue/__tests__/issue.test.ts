/**
 * Tests for issue/index.ts
 *
 * NOTE: issue/index.ts calls execFileSync at module-function level (not top-level).
 * The child_process functions are imported by reference and cannot be reliably
 * mocked after module load with Bun's mock.module. Tests here cover what's
 * testable without child_process control: parseIssueArgs, metadata, and
 * environment-agnostic paths.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('bun:bundle', () => ({
  feature: (_name: string) => true,
}))

mock.module('src/services/analytics/index.js', () => ({
  logEvent: () => {},
  stripProtoFields: (v: unknown) => v,
}))

// NOTE: We do NOT mock src/bootstrap/state.js to avoid interfering with
// launchAutofixPr.test.ts which needs its own state mock for mocking detectRepository.

// ── State ──
let tmpDir: string
let claudeDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'issue-test-'))
  claudeDir = join(tmpDir, '.claude')
  mkdirSync(claudeDir, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = claudeDir
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.CLAUDE_CONFIG_DIR
})

// ── Helpers ──
type CallFn = (
  args: string,
  ctx?: never,
) => Promise<{ type: string; value: string }>

async function getCallFn(): Promise<CallFn> {
  const mod = await import('../index.js')
  const loaded = await (
    mod.default as unknown as { load: () => Promise<{ call: CallFn }> }
  ).load()
  return loaded.call.bind(loaded) as CallFn
}

async function writeSessionLog(entries?: string[]): Promise<void> {
  const { sanitizePath } = await import('../../../utils/path.js')
  const { getSessionId, getOriginalCwd } = await import(
    '../../../bootstrap/state.js'
  )
  const sessionId = getSessionId()
  const cwd = getOriginalCwd()
  const encoded = sanitizePath(cwd)
  const dir = join(claudeDir, 'projects', encoded)
  mkdirSync(dir, { recursive: true })
  const content = entries ?? [
    JSON.stringify({ role: 'user', content: 'Fix the login bug' }),
    JSON.stringify({
      role: 'assistant',
      content: [{ type: 'text', text: 'I will investigate' }],
    }),
  ]
  writeFileSync(join(dir, `${sessionId}.jsonl`), content.join('\n') + '\n')
}

describe('issue command — metadata', () => {
  test('command has correct name and type', async () => {
    const mod = await import('../index.js')
    const cmd = mod.default
    expect(cmd.name).toBe('issue')
    expect(cmd.type).toBe('local')
    expect(
      (cmd as unknown as { supportsNonInteractive: boolean })
        .supportsNonInteractive,
    ).toBe(true)
  })

  test('isEnabled returns true', async () => {
    const mod = await import('../index.js')
    expect(mod.default.isEnabled?.()).toBe(true)
  })
})

describe('issue command — parseIssueArgs', () => {
  test('--label without value → parse error message', async () => {
    const call = await getCallFn()
    const result = await call('--label')
    expect(result.type).toBe('text')
    expect(result.value).toContain('--label requires a value')
  })

  test('--label with empty next flag → parse error', async () => {
    const call = await getCallFn()
    const result = await call('--label --public')
    expect(result.type).toBe('text')
    expect(result.value).toContain('--label requires a value')
  })

  test('--assignee without value → parse error message', async () => {
    const call = await getCallFn()
    const result = await call('--assignee')
    expect(result.type).toBe('text')
    expect(result.value).toContain('--assignee requires a value')
  })

  test('-l without value → parse error', async () => {
    const call = await getCallFn()
    const result = await call('-l')
    expect(result.type).toBe('text')
    expect(result.value).toContain('--label requires a value')
  })

  test('-a without value → parse error', async () => {
    const call = await getCallFn()
    const result = await call('-a')
    expect(result.type).toBe('text')
    expect(result.value).toContain('--assignee requires a value')
  })

  test('unknown flag → parse error', async () => {
    const call = await getCallFn()
    const result = await call('--unknown Fix bug')
    expect(result.type).toBe('text')
    expect(result.value).toContain('Unknown flag')
  })
})

describe('issue command — no title', () => {
  test('empty args → usage hint', async () => {
    const call = await getCallFn()
    const result = await call('')
    expect(result.type).toBe('text')
    expect(result.value).toContain('Usage')
  })

  test('whitespace-only args → usage hint', async () => {
    const call = await getCallFn()
    const result = await call('   ')
    expect(result.type).toBe('text')
    expect(result.value).toContain('Usage')
  })
})

describe('issue command — with title', () => {
  test('title only → returns some text result', async () => {
    const call = await getCallFn()
    const result = await call('Fix login bug')
    expect(result.type).toBe('text')
    expect(typeof result.value).toBe('string')
    expect(result.value.length).toBeGreaterThan(0)
  })

  test('title with --label → returns some text result', async () => {
    const call = await getCallFn()
    const result = await call('--label bug Fix login bug')
    expect(result.type).toBe('text')
    expect(typeof result.value).toBe('string')
    expect(result.value.length).toBeGreaterThan(0)
  })

  test('title with --assignee → returns some text result', async () => {
    const call = await getCallFn()
    const result = await call('--assignee alice Fix login bug')
    expect(result.type).toBe('text')
    expect(typeof result.value).toBe('string')
    expect(result.value.length).toBeGreaterThan(0)
  })

  test('title with both --label and --assignee → returns some text result', async () => {
    const call = await getCallFn()
    const result = await call('--label bug --assignee alice Fix login bug')
    expect(result.type).toBe('text')
    expect(typeof result.value).toBe('string')
    expect(result.value.length).toBeGreaterThan(0)
  })

  test('title with log file present → exercises transcript summary paths', async () => {
    await writeSessionLog()
    const call = await getCallFn()
    const result = await call('Fix login bug')
    expect(result.type).toBe('text')
    expect(typeof result.value).toBe('string')
    expect(result.value.length).toBeGreaterThan(0)
  })

  test('transcript with array content → covers array branch in getTranscriptSummary', async () => {
    await writeSessionLog([
      JSON.stringify({
        role: 'user',
        content: [{ type: 'text', text: 'What is the issue?' }],
      }),
      // tool_result with is_error → covers error collection
      JSON.stringify({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu1',
            is_error: true,
            content: 'Command failed',
          },
        ],
      }),
      // malformed line
      'NOT_JSON{{{',
    ])
    const call = await getCallFn()
    const result = await call('Test issue')
    expect(result.type).toBe('text')
    expect(typeof result.value).toBe('string')
  })

  test('transcript with only system entries → no conversation content', async () => {
    await writeSessionLog([
      JSON.stringify({ role: 'system', content: 'system prompt' }),
    ])
    const call = await getCallFn()
    const result = await call('Test issue empty summary')
    expect(result.type).toBe('text')
    expect(typeof result.value).toBe('string')
  })
})
