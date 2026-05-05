import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('src/utils/log.ts', logMock)
mock.module('bun:bundle', () => ({ feature: () => false }))
mock.module('src/utils/settings/settings.js', () => ({
  getSettings_DEPRECATED: () => ({}),
  updateSettingsForSource: () => {},
}))

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'launch-provider-test-'))
  process.env['CLAUDE_CONFIG_DIR'] = tmpDir
  // Ensure clean OpenAI env for each test
  delete process.env['CLAUDE_CODE_USE_OPENAI']
  delete process.env['OPENAI_BASE_URL']
  delete process.env['OPENAI_API_KEY']
  delete process.env['ANTHROPIC_API_KEY']
  delete process.env['CEREBRAS_API_KEY']
  delete process.env['GROQ_API_KEY']
  delete process.env['DEEPSEEK_API_KEY']
  delete process.env['DASHSCOPE_API_KEY']
})

afterEach(() => {
  delete process.env['CLAUDE_CONFIG_DIR']
  rmSync(tmpDir, { recursive: true, force: true })
})

// Minimal context stub
const mockContext = {} as Parameters<typeof callProviders>[1]

// We test through callProviders which exercises the full dispatch
let callProviders: Awaited<
  ReturnType<typeof import('../launchProvider.js')['callProviders']>
> extends never
  ? never
  : typeof import('../launchProvider.js')['callProviders']

beforeEach(async () => {
  const m = await import('../launchProvider.js')
  callProviders = m.callProviders
})

describe('callProviders - list', () => {
  test('list sub-command calls onDone with provider count', async () => {
    const calls: string[] = []
    await callProviders(
      msg => {
        if (msg) calls.push(msg)
      },
      mockContext,
      'list',
    )
    expect(calls[0]).toContain('4 provider(s)')
  })

  test('empty args defaults to list', async () => {
    const calls: string[] = []
    await callProviders(
      msg => {
        if (msg) calls.push(msg)
      },
      mockContext,
      '',
    )
    expect(calls[0]).toContain('provider(s)')
  })
})

describe('callProviders - show', () => {
  test('show with no active provider reports none', async () => {
    const calls: string[] = []
    await callProviders(
      msg => {
        if (msg) calls.push(msg)
      },
      mockContext,
      'show',
    )
    expect(calls[0]).toContain('No active')
  })

  test('show with active provider (env set) reports provider id', async () => {
    process.env['CLAUDE_CODE_USE_OPENAI'] = '1'
    process.env['OPENAI_BASE_URL'] = 'https://api.cerebras.ai/v1'
    const calls: string[] = []
    await callProviders(
      msg => {
        if (msg) calls.push(msg)
      },
      mockContext,
      'show',
    )
    expect(calls[0]).toContain('cerebras')
    delete process.env['CLAUDE_CODE_USE_OPENAI']
    delete process.env['OPENAI_BASE_URL']
  })
})

describe('callProviders - use', () => {
  test('use cerebras prints shell block in onDone message', async () => {
    const calls: string[] = []
    await callProviders(
      msg => {
        if (msg) calls.push(msg)
      },
      mockContext,
      'use cerebras',
    )
    expect(calls[0]).toContain('cerebras')
  })

  test('use unknown provider reports error', async () => {
    const calls: string[] = []
    await callProviders(
      msg => {
        if (msg) calls.push(msg)
      },
      mockContext,
      'use unknown-provider-xyz',
    )
    expect(calls[0]).toContain('Failed')
  })

  test('use with no id reports invalid', async () => {
    const calls: string[] = []
    await callProviders(
      msg => {
        if (msg) calls.push(msg)
      },
      mockContext,
      'use',
    )
    expect(calls[0]).toContain('use requires a provider id')
  })

  test('use does NOT mutate OPENAI_BASE_URL', async () => {
    const before = process.env['OPENAI_BASE_URL']
    await callProviders(() => {}, mockContext, 'use groq')
    expect(process.env['OPENAI_BASE_URL']).toBe(before)
  })
})

describe('callProviders - add', () => {
  test('add returns guidance message', async () => {
    const calls: string[] = []
    await callProviders(
      msg => {
        if (msg) calls.push(msg)
      },
      mockContext,
      'add',
    )
    expect(calls[0]).toContain('providers.json')
  })
})

describe('callProviders - invalid', () => {
  test('unknown sub-command reports error', async () => {
    const calls: string[] = []
    await callProviders(
      msg => {
        if (msg) calls.push(msg)
      },
      mockContext,
      'frobnicate',
    )
    expect(calls[0]).toContain('frobnicate')
  })
})
