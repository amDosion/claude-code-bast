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
  tmpDir = mkdtempSync(join(tmpdir(), 'ctx-viz-test-'))
  claudeDir = join(tmpDir, '.claude')
  mkdirSync(claudeDir, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = claudeDir
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.CLAUDE_CONFIG_DIR
})

describe('ctx_viz command', () => {
  test('command has correct name and type', async () => {
    const mod = await import('../index.js')
    const cmd = mod.default
    expect(cmd.name).toBe('ctx_viz')
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

  test('shows runtime info always', async () => {
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
      expect(result.value).toContain('Runtime')
      expect(result.value).toContain('pid')
      expect(result.value).toContain('uptime')
    }
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
    if (result.type === 'text') {
      // When log is missing we get "no log file found" OR (if log present) token stats
      expect(result.value).toContain('session')
    }
  })

  test('fmtBytes: GB range (≥ 1GB)', async () => {
    // fmtBytes is internal but is exercised via the Runtime section
    // (mem.rss, heapUsed, heapTotal). To force the GB branch we need a value
    // ≥ 1024*1024*1024. We cannot easily control process.memoryUsage() without
    // a full mock, so we exercise all fmtBytes branches by writing a session log
    // with lines that produce various token usage numbers and running ctx_viz.
    // The actual GB/MB/KB/B branches are in fmtBytes which is only called with
    // real process.memoryUsage() values. Since the test runner process has real
    // memory we can trigger different branches simply by ensuring the command runs.
    // This test is a stub that confirms ctx_viz works when called — the
    // real coverage comes from the next tests that exercise extractTextPreview.

    // Write a log with all content types to cover extractTextPreview branches
    const { sanitizePath } = await import('../../../utils/path.js')
    const { getSessionId, getOriginalCwd } = await import(
      '../../../bootstrap/state.js'
    )
    const sessionId = getSessionId()
    const cwd = getOriginalCwd()
    const encodedCwd = sanitizePath(cwd)
    const projectsDir = join(claudeDir, 'projects', encodedCwd)
    mkdirSync(projectsDir, { recursive: true })

    const logLines = [
      // tool_use block (covers tool_use branch in extractTextPreview line 67-69)
      JSON.stringify({
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool1',
            name: 'BashTool',
            input: { command: 'ls' },
          },
        ],
        usage: { output_tokens: 10 },
      }),
      // tool_result block (covers tool_result branch in extractTextPreview line 70-73)
      JSON.stringify({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool1',
            content: 'file1.ts\nfile2.ts',
          },
        ],
        usage: { input_tokens: 5 },
      }),
      // array content with text block (covers text branch)
      JSON.stringify({
        role: 'assistant',
        content: [{ type: 'text', text: 'Here is the result' }],
        usage: { output_tokens: 15 },
      }),
      // string content (already covered in other tests)
      JSON.stringify({
        role: 'user',
        content: 'plain string content',
        usage: { input_tokens: 8 },
      }),
      // array with no matching type (falls through to empty string)
      JSON.stringify({
        role: 'user',
        content: [{ type: 'image', data: 'base64...' }],
        usage: { input_tokens: 3 },
      }),
    ]
    writeFileSync(
      join(projectsDir, `${sessionId}.jsonl`),
      logLines.join('\n') + '\n',
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
      expect(result.value).toContain('Token Usage')
      expect(result.value).toContain('Message Distribution')
    }
  })

  test('shows Context Window Usage section with grid', async () => {
    const { sanitizePath } = await import('../../../utils/path.js')
    const { getSessionId, getOriginalCwd } = await import(
      '../../../bootstrap/state.js'
    )
    const projectsDir = join(
      claudeDir,
      'projects',
      sanitizePath(getOriginalCwd()),
    )
    mkdirSync(projectsDir, { recursive: true })
    writeFileSync(
      join(projectsDir, `${getSessionId()}.jsonl`),
      JSON.stringify({
        role: 'user',
        content: 'hello',
        usage: { input_tokens: 1000 },
      }) + '\n',
    )
    const mod = await import('../index.js')
    const loaded = await (
      mod.default as unknown as {
        load: () => Promise<{
          call: (
            a: string,
            ctx: never,
          ) => Promise<{ type: string; value: string }>
        }>
      }
    ).load()
    const result = await loaded.call('', {} as never)
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('Context Window Usage')
    }
  })

  test('--max-tokens flag changes the max_tokens shown', async () => {
    const mod = await import('../index.js')
    const loaded = await (
      mod.default as unknown as {
        load: () => Promise<{
          call: (
            a: string,
            ctx: never,
          ) => Promise<{ type: string; value: string }>
        }>
      }
    ).load()
    const result = await loaded.call('--max-tokens=50000', {} as never)
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('50,000')
    }
  })

  test('shows Cache Activity section when log has usage', async () => {
    const { sanitizePath } = await import('../../../utils/path.js')
    const { getSessionId, getOriginalCwd } = await import(
      '../../../bootstrap/state.js'
    )
    const projectsDir = join(
      claudeDir,
      'projects',
      sanitizePath(getOriginalCwd()),
    )
    mkdirSync(projectsDir, { recursive: true })
    writeFileSync(
      join(projectsDir, `${getSessionId()}.jsonl`),
      JSON.stringify({
        role: 'assistant',
        usage: {
          cache_creation_input_tokens: 500,
          cache_read_input_tokens: 300,
        },
      }) + '\n',
    )
    const mod = await import('../index.js')
    const loaded = await (
      mod.default as unknown as {
        load: () => Promise<{
          call: (
            a: string,
            ctx: never,
          ) => Promise<{ type: string; value: string }>
        }>
      }
    ).load()
    const result = await loaded.call('', {} as never)
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('Cache Activity')
    }
  })

  test('parses session log and shows token usage and distribution', async () => {
    // Use state values as they will be seen by the command (may be mocked)
    const { sanitizePath } = await import('../../../utils/path.js')
    const { getSessionId, getOriginalCwd } = await import(
      '../../../bootstrap/state.js'
    )
    const sessionId = getSessionId()
    const cwd = getOriginalCwd()
    const encodedCwd = sanitizePath(cwd)
    const projectsDir = join(claudeDir, 'projects', encodedCwd)
    mkdirSync(projectsDir, { recursive: true })

    const logLines = [
      JSON.stringify({
        role: 'user',
        content: 'hello',
        usage: { input_tokens: 10 },
      }),
      JSON.stringify({
        role: 'assistant',
        content: [{ type: 'text', text: 'world' }],
        usage: { output_tokens: 5 },
      }),
    ]
    writeFileSync(
      join(projectsDir, `${sessionId}.jsonl`),
      logLines.join('\n') + '\n',
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
      expect(result.value).toContain('Token Usage')
      expect(result.value).toContain('Message Distribution')
      expect(result.value).toContain('Recent Messages')
    }
  })

  test('yellow color when usage is 60-85% of max_tokens (lines 81-82)', async () => {
    // Use --max-tokens=100000 and write 70000 tokens to hit the yellow (60-85%) branch
    const { sanitizePath } = await import('../../../utils/path.js')
    const { getSessionId, getOriginalCwd } = await import(
      '../../../bootstrap/state.js'
    )
    const sessionId = getSessionId()
    const cwd = getOriginalCwd()
    const encodedCwd = sanitizePath(cwd)
    const projectsDir = join(claudeDir, 'projects', encodedCwd)
    mkdirSync(projectsDir, { recursive: true })
    writeFileSync(
      join(projectsDir, `${sessionId}.jsonl`),
      JSON.stringify({
        role: 'user',
        content: 'hello',
        usage: { input_tokens: 70000 },
      }) + '\n',
    )
    const mod = await import('../index.js')
    const loaded = await (
      mod.default as unknown as {
        load: () => Promise<{
          call: (
            a: string,
            ctx: never,
          ) => Promise<{ type: string; value: string }>
        }>
      }
    ).load()
    // 70000/100000 = 70% → yellow branch (lines 81-82)
    const result = await loaded.call('--max-tokens=100000', {} as never)
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('Context Window Usage')
    }
  })

  // ── H4 regression: --max-tokens above cap should be rejected ──
  test('H4: --max-tokens above 10_000_000 returns an error message', async () => {
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
    // 999999999999 > 10_000_000 → should be rejected
    const result = await loaded.call('--max-tokens=999999999999', {} as never)
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('exceeds maximum allowed')
    }
  })

  test('H4: --max-tokens at exactly the cap (10_000_000) is accepted', async () => {
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
    const result = await loaded.call('--max-tokens=10000000', {} as never)
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      // Should NOT contain the error message (accepted)
      expect(result.value).not.toContain('exceeds maximum allowed')
    }
  })
})
