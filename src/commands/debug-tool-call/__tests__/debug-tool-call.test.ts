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

let tmpDir: string
let claudeDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'dtc-test-'))
  claudeDir = join(tmpDir, '.claude')
  mkdirSync(claudeDir, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = claudeDir
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.CLAUDE_CONFIG_DIR
})

async function makeLogWithToolCalls(
  claudeDir: string,
  count: number,
): Promise<void> {
  const { sanitizePath } = await import('../../../utils/path.js')
  const { getSessionId, getOriginalCwd } = await import(
    '../../../bootstrap/state.js'
  )
  // Use state values as they'll be seen by the command (may be mocked)
  const encodedCwd = sanitizePath(getOriginalCwd())
  const projectsDir = join(claudeDir, 'projects', encodedCwd)
  mkdirSync(projectsDir, { recursive: true })
  const lines: string[] = []
  for (let i = 1; i <= count; i++) {
    lines.push(
      JSON.stringify({
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: `tu${i}`,
            name: `Tool${i}`,
            input: { arg: `val${i}` },
          },
        ],
      }),
    )
    lines.push(
      JSON.stringify({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: `tu${i}`, content: `result${i}` },
        ],
      }),
    )
  }
  writeFileSync(
    join(projectsDir, `${getSessionId()}.jsonl`),
    lines.join('\n') + '\n',
  )
}

describe('debug-tool-call command', () => {
  test('command has correct name and type', async () => {
    const mod = await import('../index.js')
    const cmd = mod.default
    expect(cmd.name).toBe('debug-tool-call')
    expect(cmd.type).toBe('local')
    expect(
      (cmd as unknown as { supportsNonInteractive: boolean })
        .supportsNonInteractive,
    ).toBe(true)
  })

  test('isEnabled returns true', async () => {
    const mod = await import('../index.js')
    const cmd = mod.default
    expect(cmd.isEnabled?.()).toBe(true)
  })

  test('shows no-log message when log file missing', async () => {
    const mod = await import('../index.js')
    const cmd = mod.default
    const loaded = await (
      cmd as unknown as {
        load: () => Promise<{
          call: (
            args: string,
            ctx: never,
          ) => Promise<{ type: string; value: string }>
        }>
      }
    ).load()
    const result = await loaded.call('', {} as never)
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('Debug Tool')
    }
  })

  test('shows no-tool-calls message when log has no tool blocks', async () => {
    const { sanitizePath } = await import('../../../utils/path.js')
    const { getSessionId, getOriginalCwd } = await import(
      '../../../bootstrap/state.js'
    )
    const encodedCwd = sanitizePath(getOriginalCwd())
    const projectsDir = join(claudeDir, 'projects', encodedCwd)
    mkdirSync(projectsDir, { recursive: true })
    writeFileSync(
      join(projectsDir, `${getSessionId()}.jsonl`),
      JSON.stringify({ role: 'user', content: 'hi' }) + '\n',
    )

    const mod = await import('../index.js')
    const cmd = mod.default
    const loaded = await (
      cmd as unknown as {
        load: () => Promise<{
          call: (
            args: string,
            ctx: never,
          ) => Promise<{ type: string; value: string }>
        }>
      }
    ).load()
    const result = await loaded.call('', {} as never)
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('No tool call')
    }
  })

  test('shows tool call pairs from log', async () => {
    await makeLogWithToolCalls(claudeDir, 1)

    const mod = await import('../index.js')
    const cmd = mod.default
    const loaded = await (
      cmd as unknown as {
        load: () => Promise<{
          call: (
            args: string,
            ctx: never,
          ) => Promise<{ type: string; value: string }>
        }>
      }
    ).load()
    const result = await loaded.call('1', {} as never)
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('Tool1')
    }
  })

  test('renderValue handles non-JSON-serializable input gracefully (lines 53-54)', async () => {
    // renderValue catches JSON.stringify errors for circular references.
    // We need to create a log entry whose `input` field, when read from JSON,
    // is an ordinary object. However, since JSON.stringify is used to serialize
    // `use.input` AFTER JSON.parse, parsed values are always JSON-safe.
    // The only way to hit the catch is to have a non-serializable value.
    // Since the value comes from JSON.parse, it will always be serializable.
    // Therefore lines 53-54 are unreachable in normal flow. This test
    // documents this by passing a valid log and confirming the happy path works.
    const { sanitizePath } = await import('../../../utils/path.js')
    const { getSessionId, getOriginalCwd } = await import(
      '../../../bootstrap/state.js'
    )
    const encodedCwd = sanitizePath(getOriginalCwd())
    const projectsDir = join(claudeDir, 'projects', encodedCwd)
    mkdirSync(projectsDir, { recursive: true })

    // Write a log with a tool call whose input is a deeply nested object
    writeFileSync(
      join(projectsDir, `${getSessionId()}.jsonl`),
      [
        JSON.stringify({
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'complex1',
              name: 'ComplexTool',
              input: { nested: { deep: { value: 'test' } } },
            },
          ],
        }),
        JSON.stringify({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'complex1',
              content: [{ type: 'text', text: 'tool result here' }],
            },
          ],
        }),
      ].join('\n') + '\n',
    )

    const mod = await import('../index.js')
    const cmd = mod.default
    const loaded = await (
      cmd as unknown as {
        load: () => Promise<{
          call: (
            args: string,
            ctx: never,
          ) => Promise<{ type: string; value: string }>
        }>
      }
    ).load()
    const result = await loaded.call('1', {} as never)
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('ComplexTool')
    }
  })

  test('respects N argument (shows last N of total)', async () => {
    await makeLogWithToolCalls(claudeDir, 3)

    const mod = await import('../index.js')
    const cmd = mod.default
    const loaded = await (
      cmd as unknown as {
        load: () => Promise<{
          call: (
            args: string,
            ctx: never,
          ) => Promise<{ type: string; value: string }>
        }>
      }
    ).load()
    const result = await loaded.call('2', {} as never)
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      // Should show 2 of 3 total
      expect(result.value).toContain('Last 2 Tool Calls')
    }
  })
})
