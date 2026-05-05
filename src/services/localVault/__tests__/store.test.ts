import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  statSync,
  readFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('src/utils/log.ts', logMock)
mock.module('bun:bundle', () => ({ feature: () => false }))

// ── Keychain mock (unavailable by default to test fallback path) ───────────────

import { KeychainUnavailableError } from '../keychain.js'

const keychainUnavailable = async (): Promise<never> => {
  throw new KeychainUnavailableError('test: keychain mocked as unavailable')
}

const keychainMock = {
  set: mock(keychainUnavailable),
  get: mock(keychainUnavailable),
  delete: mock(keychainUnavailable),
  list: mock(keychainUnavailable),
  _addToIndex: mock(keychainUnavailable),
  _removeFromIndex: mock(keychainUnavailable),
}

mock.module('../keychain.js', () => ({
  KeychainUnavailableError,
  tryKeychain: keychainMock,
  _resetKeychainModuleCache: () => {},
}))

// ── Crypto fallback tests ─────────────────────────────────────────────────────

describe('store (AES-256-GCM file fallback)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'local-vault-test-'))
    process.env['CLAUDE_CONFIG_DIR'] = tmpDir
    // Use a fixed passphrase via env to avoid file creation
    process.env['CLAUDE_LOCAL_VAULT_PASSPHRASE'] =
      'test-passphrase-fixed-32chars-xxx'
    // Reset all keychain mocks to unavailable
    keychainMock.set.mockImplementation(keychainUnavailable)
    keychainMock.get.mockImplementation(keychainUnavailable)
    keychainMock.delete.mockImplementation(keychainUnavailable)
    keychainMock.list.mockImplementation(keychainUnavailable)
    keychainMock._addToIndex.mockImplementation(keychainUnavailable)
    keychainMock._removeFromIndex.mockImplementation(keychainUnavailable)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    delete process.env['CLAUDE_CONFIG_DIR']
    delete process.env['CLAUDE_LOCAL_VAULT_PASSPHRASE']
  })

  test('round-trip: set then get returns same value', async () => {
    const { setSecret, getSecret } = await import('../store.js')
    await setSecret('API_KEY', 'super-secret-value-abc123')
    const result = await getSecret('API_KEY')
    expect(result).toBe('super-secret-value-abc123')
  })

  test('get returns null for missing key', async () => {
    const { getSecret } = await import('../store.js')
    const result = await getSecret('NONEXISTENT_KEY')
    expect(result).toBeNull()
  })

  test('delete removes key; subsequent get returns null', async () => {
    const { setSecret, getSecret, deleteSecret } = await import('../store.js')
    await setSecret('TO_DELETE', 'temporary-value')
    const deleted = await deleteSecret('TO_DELETE')
    expect(deleted).toBe(true)
    expect(await getSecret('TO_DELETE')).toBeNull()
  })

  test('delete returns false for nonexistent key', async () => {
    const { deleteSecret } = await import('../store.js')
    const result = await deleteSecret('GHOST_KEY')
    expect(result).toBe(false)
  })

  test('listKeys returns stored keys without values', async () => {
    const { setSecret, listKeys } = await import('../store.js')
    await setSecret('KEY_A', 'value-a')
    await setSecret('KEY_B', 'value-b')
    const keys = await listKeys()
    expect(keys).toContain('KEY_A')
    expect(keys).toContain('KEY_B')
    expect(keys.join('')).not.toContain('value-a')
    expect(keys.join('')).not.toContain('value-b')
  })

  test('wrong passphrase throws LocalVaultDecryptionError (does not leak bytes)', async () => {
    const { setSecret } = await import('../store.js')
    await setSecret('SENSITIVE', 'my-secret-12345')

    // Change passphrase to simulate wrong key
    process.env['CLAUDE_LOCAL_VAULT_PASSPHRASE'] =
      'wrong-passphrase-different-xxxxx'
    const { getSecret, LocalVaultDecryptionError } = await import('../store.js')
    await expect(getSecret('SENSITIVE')).rejects.toBeInstanceOf(
      LocalVaultDecryptionError,
    )
    // Restore
    process.env['CLAUDE_LOCAL_VAULT_PASSPHRASE'] =
      'test-passphrase-fixed-32chars-xxx'
  })

  test('file does not exist → getSecret returns null (not error)', async () => {
    const { getSecret } = await import('../store.js')
    const result = await getSecret('ANY_KEY')
    expect(result).toBeNull()
  })

  test('corrupted JSON vault file → getSecret returns null (graceful)', async () => {
    writeFileSync(join(tmpDir, 'local-vault.enc.json'), 'not-valid-json')
    const { getSecret } = await import('../store.js')
    const result = await getSecret('ANY_KEY')
    expect(result).toBeNull()
  })

  test('large value round-trip (>1MB)', async () => {
    const { setSecret, getSecret } = await import('../store.js')
    const largeValue = 'X'.repeat(1_048_576)
    await setSecret('LARGE_KEY', largeValue)
    const result = await getSecret('LARGE_KEY')
    expect(result).toBe(largeValue)
  })

  test('Unicode key round-trip', async () => {
    const { setSecret, getSecret } = await import('../store.js')
    await setSecret('KEY_🔑', 'unicode-secret-日本語')
    const result = await getSecret('KEY_🔑')
    expect(result).toBe('unicode-secret-日本語')
  })

  test('IV is unique per encryption (AES-GCM invariant)', async () => {
    // Write two entries; IVs in vault file should differ
    const { setSecret } = await import('../store.js')
    await setSecret('KEY_1', 'value-1')
    await setSecret('KEY_2', 'value-2')
    const vaultRaw = readFileSync(join(tmpDir, 'local-vault.enc.json'), 'utf8')
    const vault = JSON.parse(vaultRaw) as Record<string, { iv: string }>
    const ivs = Object.values(vault).map(r => r.iv)
    expect(new Set(ivs).size).toBe(ivs.length) // all IVs unique
  })

  test('passphrase file mode 600 on POSIX', async () => {
    // Remove env passphrase to force file creation
    delete process.env['CLAUDE_LOCAL_VAULT_PASSPHRASE']
    const { setSecret } = await import('../store.js')
    await setSecret('MODE_TEST', 'value')
    const passphraseFile = join(tmpDir, '.local-vault-passphrase')
    if (process.platform !== 'win32') {
      const stat = statSync(passphraseFile)
      const mode = stat.mode & 0o777
      expect(mode).toBe(0o600)
    }
    // On Windows: file should exist (mode check is best-effort)
    const { existsSync } = await import('node:fs')
    expect(existsSync(passphraseFile)).toBe(true)
    process.env['CLAUDE_LOCAL_VAULT_PASSPHRASE'] =
      'test-passphrase-fixed-32chars-xxx'
  })
})

// ── maskSecret tests ──────────────────────────────────────────────────────────

describe('maskSecret', () => {
  test('masks long secret correctly', async () => {
    const { maskSecret } = await import('../store.js')
    const masked = maskSecret('ABCDEFGHIJKLMNOP')
    expect(masked.startsWith('ABCD')).toBe(true)
    expect(masked).toContain('...')
    expect(masked).not.toBe('ABCDEFGHIJKLMNOP')
  })

  test('short secret uses length notation', async () => {
    const { maskSecret } = await import('../store.js')
    expect(maskSecret('abc')).toContain('len=3')
    expect(maskSecret('abc')).not.toContain('abc')
  })
})
