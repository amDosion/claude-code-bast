/**
 * LocalVault store — OS keychain primary, AES-256-GCM file fallback.
 *
 * Passphrase priority:
 *   1. CLAUDE_LOCAL_VAULT_PASSPHRASE env var
 *   2. ~/.claude/.local-vault-passphrase (mode 600 on POSIX)
 *   3. Auto-generate + write to file (warns user to backup)
 *
 * Fallback file: ~/.claude/local-vault.enc.json (gitignored)
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from 'node:crypto'
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
} from 'node:fs'
import { readFile, writeFile, chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logError } from '../../utils/log.js'
import { KeychainUnavailableError, tryKeychain } from './keychain.js'

// ── Error types ───────────────────────────────────────────────────────────────

export class LocalVaultDecryptionError extends Error {
  constructor(reason: string) {
    super(`LocalVault decryption failed: ${reason}`)
    this.name = 'LocalVaultDecryptionError'
  }
}

// ── Path helpers ──────────────────────────────────────────────────────────────

function getClaudeDir(): string {
  return process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude')
}

function getVaultFilePath(): string {
  return join(getClaudeDir(), 'local-vault.enc.json')
}

function getPassphraseFilePath(): string {
  return join(getClaudeDir(), '.local-vault-passphrase')
}

// ── Passphrase management ─────────────────────────────────────────────────────

function deriveKey(passphrase: string): Buffer {
  // PBKDF2-equivalent via a single SHA-256 hash is intentionally simple;
  // the file is on the local filesystem which is the threat model boundary.
  return createHash('sha256').update(passphrase).digest()
}

async function getOrCreatePassphrase(): Promise<string> {
  // Priority 1: env var
  const envVal = process.env['CLAUDE_LOCAL_VAULT_PASSPHRASE']
  if (envVal) return envVal

  const passphraseFile = getPassphraseFilePath()

  // Priority 2: existing passphrase file
  if (existsSync(passphraseFile)) {
    return readFileSync(passphraseFile, 'utf8').trim()
  }

  // Priority 3: auto-generate + write to file
  const claudeDir = getClaudeDir()
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true })
  }

  const generated = randomBytes(32).toString('hex')
  writeFileSync(passphraseFile, generated, { encoding: 'utf8', mode: 0o600 })
  // Ensure mode 600 even if umask interfered
  try {
    chmodSync(passphraseFile, 0o600)
  } catch {
    // Windows — best effort; warn user
    logError(
      new Error(
        'LocalVault: could not set passphrase file mode 600 (Windows). ' +
          'Protect ~/.claude/.local-vault-passphrase manually.',
      ),
    )
  }

  console.warn(
    '[LocalVault] Generated new passphrase file: ' +
      passphraseFile +
      '\n' +
      '  Back it up! Losing this file means losing access to your encrypted vault.',
  )

  return generated
}

// ── Encrypted file store ──────────────────────────────────────────────────────

const ALGORITHM = 'aes-256-gcm' as const
const IV_BYTES = 12
const TAG_BYTES = 16

type EncryptedRecord = {
  iv: string // hex
  tag: string // hex
  data: string // hex
}

type VaultFile = Record<string, EncryptedRecord>

function encrypt(plaintext: string, key: Buffer): EncryptedRecord {
  // New IV per encryption — invariant: no IV reuse
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return {
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted.toString('hex'),
  }
}

function decrypt(record: EncryptedRecord, key: Buffer): string {
  let iv: Buffer
  let tag: Buffer
  let data: Buffer
  try {
    iv = Buffer.from(record.iv, 'hex')
    tag = Buffer.from(record.tag, 'hex')
    data = Buffer.from(record.data, 'hex')
  } catch {
    throw new LocalVaultDecryptionError('corrupted record encoding')
  }

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new LocalVaultDecryptionError('invalid IV or tag length')
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  try {
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()])
    return decrypted.toString('utf8')
  } catch {
    // Do not leak partial decrypted bytes — invariant from plan §安全 invariant 6
    throw new LocalVaultDecryptionError(
      'authentication tag mismatch — wrong passphrase or tampered data',
    )
  }
}

async function readVaultFile(): Promise<VaultFile> {
  const filePath = getVaultFilePath()
  if (!existsSync(filePath)) return {}
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {}
    }
    return parsed as VaultFile
  } catch {
    return {}
  }
}

async function writeVaultFile(data: VaultFile): Promise<void> {
  const claudeDir = getClaudeDir()
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true })
  }
  const filePath = getVaultFilePath()
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8')
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function setSecret(key: string, value: string): Promise<void> {
  // Primary: OS keychain
  try {
    await tryKeychain.set(key, value)
    await tryKeychain._addToIndex(key)
    return
  } catch (err: unknown) {
    if (!(err instanceof KeychainUnavailableError)) {
      throw err
    }
    // Keychain unavailable → fall through to file
    console.warn(
      '[LocalVault] OS keychain not available, falling back to encrypted file. ' +
        'Install platform keychain or set CLAUDE_LOCAL_VAULT_PASSPHRASE env.',
    )
  }

  // Fallback: encrypted file
  const passphrase = await getOrCreatePassphrase()
  const key256 = deriveKey(passphrase)
  const vaultData = await readVaultFile()
  vaultData[key] = encrypt(value, key256)
  await writeVaultFile(vaultData)
}

export async function getSecret(key: string): Promise<string | null> {
  // Primary: OS keychain
  try {
    const val = await tryKeychain.get(key)
    return val
  } catch (err: unknown) {
    if (!(err instanceof KeychainUnavailableError)) {
      throw err
    }
  }

  // Fallback: encrypted file
  const vaultData = await readVaultFile()
  const record = vaultData[key]
  if (!record) return null

  const passphrase = await getOrCreatePassphrase()
  const key256 = deriveKey(passphrase)
  return decrypt(record, key256)
}

export async function deleteSecret(key: string): Promise<boolean> {
  // Primary: OS keychain
  try {
    const deleted = await tryKeychain.delete(key)
    await tryKeychain._removeFromIndex(key)
    return deleted
  } catch (err: unknown) {
    if (!(err instanceof KeychainUnavailableError)) {
      throw err
    }
  }

  // Fallback: encrypted file
  const vaultData = await readVaultFile()
  if (!(key in vaultData)) return false
  const updated = { ...vaultData }
  delete updated[key]
  await writeVaultFile(updated)
  return true
}

export async function listKeys(): Promise<string[]> {
  // Primary: OS keychain index
  try {
    return await tryKeychain.list()
  } catch (err: unknown) {
    if (!(err instanceof KeychainUnavailableError)) {
      throw err
    }
  }

  // Fallback: encrypted file keys (no decryption needed — just keys)
  const vaultData = await readVaultFile()
  return Object.keys(vaultData)
}

/** Mask a secret value for display: first 4 chars + ... + last 2 chars + length */
export function maskSecret(value: string): string {
  if (value.length <= 6) return `***[len=${value.length}]`
  return `${value.slice(0, 4)}...[len=${value.length}]`
}
