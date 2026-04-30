import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs'
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
  tmpDir = mkdtempSync(join(tmpdir(), 'break-cache-test-'))
  claudeDir = join(tmpDir, '.claude')
  mkdirSync(claudeDir, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = claudeDir
})

afterEach(() => {
  // Clean up any lingering marker files
  try {
    const { getBreakCacheMarkerPath } = require('../index.js')
    const markerPath = getBreakCacheMarkerPath()
    if (existsSync(markerPath)) unlinkSync(markerPath)
  } catch {
    // ignore
  }
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.CLAUDE_CONFIG_DIR
})

describe('break-cache command', () => {
  test('command has correct name and type', async () => {
    const mod = await import('../index.js')
    const cmd = mod.default
    expect(cmd.name).toBe('break-cache')
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

  test('writes marker file and confirms in message', async () => {
    const mod = await import('../index.js')
    const cmd = mod.default
    const { getBreakCacheMarkerPath } = mod

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
      expect(result.value).toContain('Cache break scheduled')
      expect(result.value).toContain('next API call')
    }

    // Marker file must exist under CLAUDE_CONFIG_DIR
    const markerPath = getBreakCacheMarkerPath()
    expect(markerPath).toContain('.next-request-no-cache')
    expect(existsSync(markerPath)).toBe(true)

    // Clean up
    unlinkSync(markerPath)
  })

  test('--clear removes an existing marker', async () => {
    const mod = await import('../index.js')
    const cmd = mod.default
    const { getBreakCacheMarkerPath } = mod
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

    // Set the marker first
    await loaded.call('', {} as never)
    const markerPath = getBreakCacheMarkerPath()
    expect(existsSync(markerPath)).toBe(true)

    // Now clear it
    const clearResult = await loaded.call('--clear', {} as never)
    expect(clearResult.type).toBe('text')
    if (clearResult.type === 'text') {
      expect(clearResult.value).toContain('cleared')
    }
    expect(existsSync(markerPath)).toBe(false)
  })

  test('--clear when no marker returns no-marker message', async () => {
    const mod = await import('../index.js')
    const cmd = mod.default
    const { getBreakCacheMarkerPath } = mod
    const markerPath = getBreakCacheMarkerPath()

    // Ensure it does not exist
    if (existsSync(markerPath)) unlinkSync(markerPath)

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
    const result = await loaded.call('--clear', {} as never)
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('No cache-break marker')
    }
  })

  test('getBreakCacheMarkerPath points inside CLAUDE_CONFIG_DIR', async () => {
    const { getBreakCacheMarkerPath } = await import('../index.js')
    const path = getBreakCacheMarkerPath()
    expect(path).toContain('.next-request-no-cache')
    // The path should be under claudeDir (CLAUDE_CONFIG_DIR)
    expect(path.startsWith(claudeDir)).toBe(true)
  })

  test('"once" scope is same as empty args', async () => {
    const mod = await import('../index.js')
    const cmd = mod.default
    const { getBreakCacheMarkerPath } = mod
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
    const result = await loaded.call('once', {} as never)
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('Cache break scheduled')
    }
    const markerPath = getBreakCacheMarkerPath()
    expect(existsSync(markerPath)).toBe(true)
  })

  test('"always" scope writes the always flag', async () => {
    const mod = await import('../index.js')
    const cmd = mod.default
    const { getBreakCacheAlwaysPath } = mod
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
    const result = await loaded.call('always', {} as never)
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('Always-on')
    }
    expect(existsSync(getBreakCacheAlwaysPath())).toBe(true)
    // Clean up
    unlinkSync(getBreakCacheAlwaysPath())
  })

  test('"off" scope clears both flags', async () => {
    const mod = await import('../index.js')
    const cmd = mod.default
    const { getBreakCacheMarkerPath, getBreakCacheAlwaysPath } = mod
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
    // Set both markers
    await loaded.call('', {} as never)
    await loaded.call('always', {} as never)
    expect(existsSync(getBreakCacheMarkerPath())).toBe(true)
    expect(existsSync(getBreakCacheAlwaysPath())).toBe(true)
    // Clear both
    const result = await loaded.call('off', {} as never)
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('disabled')
    }
    expect(existsSync(getBreakCacheMarkerPath())).toBe(false)
    expect(existsSync(getBreakCacheAlwaysPath())).toBe(false)
  })

  test('"status" scope shows current state', async () => {
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
    const result = await loaded.call('status', {} as never)
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('Break-Cache Status')
      expect(result.value).toContain('Once marker')
      expect(result.value).toContain('Always mode')
    }
  })

  test('unknown scope returns usage text', async () => {
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
    const result = await loaded.call('foobar', {} as never)
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('Unknown scope')
      expect(result.value).toContain('Usage')
    }
  })

  test('getBreakCacheAlwaysPath and getBreakCacheStatsPath are exported', async () => {
    const { getBreakCacheAlwaysPath, getBreakCacheStatsPath } = await import(
      '../index.js'
    )
    expect(typeof getBreakCacheAlwaysPath()).toBe('string')
    expect(typeof getBreakCacheStatsPath()).toBe('string')
    expect(getBreakCacheAlwaysPath()).toContain('.break-cache-always')
    // File was renamed to append-only JSONL (H3 fix: atomic append prevents RMW race)
    expect(getBreakCacheStatsPath()).toContain('break-cache-events.jsonl')
  })

  // ── H3 regression: append-only stats log accumulates correctly ──
  test('H3: each /break-cache once appends one event; totalBreaks reflects all calls', async () => {
    const { readFileSync } = await import('node:fs')
    const mod = await import('../index.js')
    const { getBreakCacheStatsPath } = mod
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

    // Call /break-cache once, twice
    await loaded.call('once', {} as never)
    await loaded.call('once', {} as never)
    await loaded.call('once', {} as never)

    // Stats path should be a JSONL file with 3 'once' events
    const statsPath = getBreakCacheStatsPath()
    const lines = readFileSync(statsPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
    const events = lines.map(l => JSON.parse(l) as { kind: string })
    const onceEvents = events.filter(e => e.kind === 'once')
    expect(onceEvents.length).toBe(3)

    // The status command should report totalBreaks = 3
    const statusResult = await loaded.call('status', {} as never)
    if (statusResult.type === 'text') {
      expect(statusResult.value).toContain('total_breaks:   3')
    }
  })
})
