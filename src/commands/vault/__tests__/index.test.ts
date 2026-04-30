/**
 * Tests for vault index.tsx (command definition)
 */

import { describe, expect, test } from 'bun:test'
import type { LocalJSXCommandModule } from '../../../types/command.js'

describe('vaultCommand definition', () => {
  test('command is type local-jsx', async () => {
    const mod = await import('../index.js')
    const cmd = mod.default
    expect(cmd.type).toBe('local-jsx')
  })

  test('command name is vault', async () => {
    const mod = await import('../index.js')
    const cmd = mod.default
    expect(cmd.name).toBe('vault')
  })

  test('command has vaults alias', async () => {
    const mod = await import('../index.js')
    const cmd = mod.default
    expect(cmd.aliases).toContain('vaults')
  })

  test('command isEnabled returns true', async () => {
    const mod = await import('../index.js')
    const cmd = mod.default
    expect(cmd.isEnabled?.()).toBe(true)
  })

  test('command is not hidden', async () => {
    const mod = await import('../index.js')
    const cmd = mod.default
    expect(cmd.isHidden).toBe(false)
  })

  test('command load resolves callVault function', async () => {
    const mod = await import('../index.js')
    const cmd = mod.default as unknown as {
      load: () => Promise<LocalJSXCommandModule>
    }
    expect(cmd.load).toBeDefined()
    const loaded = await cmd.load()
    expect(typeof loaded.call).toBe('function')
  })
})
