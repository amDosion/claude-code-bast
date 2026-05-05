import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// No mocks needed — multiStore.ts is pure fs, no log/debug/bun:bundle side effects.

describe('multiStore', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'multi-store-test-'))
    process.env['CLAUDE_CONFIG_DIR'] = tmpDir
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    delete process.env['CLAUDE_CONFIG_DIR']
  })

  test('listStores returns empty when no stores exist', async () => {
    const { listStores } = await import('../multiStore.js')
    expect(listStores()).toEqual([])
  })

  test('createStore creates a store directory', async () => {
    const { createStore, listStores } = await import('../multiStore.js')
    createStore('my-store')
    expect(listStores()).toContain('my-store')
  })

  test('createStore throws if store already exists', async () => {
    const { createStore } = await import('../multiStore.js')
    createStore('duplicate')
    expect(() => createStore('duplicate')).toThrow('already exists')
  })

  test('setEntry and getEntry round-trip', async () => {
    const { createStore, setEntry, getEntry } = await import('../multiStore.js')
    createStore('notes')
    setEntry('notes', 'hello', '# Hello\nThis is a note.')
    expect(getEntry('notes', 'hello')).toBe('# Hello\nThis is a note.')
  })

  test('getEntry returns null for missing key', async () => {
    const { createStore, getEntry } = await import('../multiStore.js')
    createStore('empty-store')
    expect(getEntry('empty-store', 'nonexistent')).toBeNull()
  })

  test('cross-store isolation: entries in different stores do not bleed', async () => {
    const { createStore, setEntry, getEntry } = await import('../multiStore.js')
    createStore('store-a')
    createStore('store-b')
    setEntry('store-a', 'shared-key', 'value-from-a')
    setEntry('store-b', 'shared-key', 'value-from-b')
    expect(getEntry('store-a', 'shared-key')).toBe('value-from-a')
    expect(getEntry('store-b', 'shared-key')).toBe('value-from-b')
  })

  test('listEntries returns keys in a store', async () => {
    const { createStore, setEntry, listEntries } = await import(
      '../multiStore.js'
    )
    createStore('listing')
    setEntry('listing', 'alpha', 'a')
    setEntry('listing', 'beta', 'b')
    const entries = listEntries('listing')
    expect(entries).toContain('alpha')
    expect(entries).toContain('beta')
  })

  test('deleteEntry removes entry and returns true', async () => {
    const { createStore, setEntry, deleteEntry, getEntry } = await import(
      '../multiStore.js'
    )
    createStore('del-store')
    setEntry('del-store', 'to-remove', 'temp')
    expect(deleteEntry('del-store', 'to-remove')).toBe(true)
    expect(getEntry('del-store', 'to-remove')).toBeNull()
  })

  test('deleteEntry returns false for missing entry', async () => {
    const { createStore, deleteEntry } = await import('../multiStore.js')
    createStore('del-store-2')
    expect(deleteEntry('del-store-2', 'ghost')).toBe(false)
  })

  test('archiveStore renames directory with .archived suffix', async () => {
    const { createStore, archiveStore, listStores, listAllStores } =
      await import('../multiStore.js')
    createStore('to-archive')
    archiveStore('to-archive')
    expect(listStores()).not.toContain('to-archive')
    expect(listAllStores()).toContain('to-archive.archived')
  })

  test('large entry round-trip (>500KB)', async () => {
    const { createStore, setEntry, getEntry } = await import('../multiStore.js')
    createStore('large')
    const largeValue = 'A'.repeat(512 * 1024)
    setEntry('large', 'big-entry', largeValue)
    expect(getEntry('large', 'big-entry')).toBe(largeValue)
  })

  test('Unicode key is accepted and stored', async () => {
    const { createStore, setEntry, getEntry } = await import('../multiStore.js')
    createStore('unicode-store')
    setEntry('unicode-store', '日本語キー', 'value with 日本語')
    expect(getEntry('unicode-store', '日本語キー')).toBe('value with 日本語')
  })
})
