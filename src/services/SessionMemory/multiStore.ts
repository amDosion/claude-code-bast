/**
 * Multi-store extension of local SessionMemory.
 *
 * Each store is a directory under ~/.claude/local-memory/<store>/
 * Each entry is stored as a markdown file: <key>.md
 *
 * This is a new sibling layer — does NOT modify sessionMemory.ts.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { randomBytes } from 'node:crypto'

// ── Path helpers ──────────────────────────────────────────────────────────────

function getBaseDir(): string {
  const configDir =
    process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude')
  return join(configDir, 'local-memory')
}

function getStoreDir(store: string): string {
  return join(getBaseDir(), store)
}

function getEntryPath(store: string, key: string): string {
  // Sanitize key — replace path separators to prevent directory traversal
  const safeKey = key.replace(/[/\\]/g, '_')
  return join(getStoreDir(store), `${safeKey}.md`)
}

/** Maximum allowed store name length (OS path component limit). */
const MAX_STORE_NAME_LENGTH = 255
/** Maximum allowed entry value size: 1 MB. */
const MAX_VALUE_BYTES = 1_048_576

/**
 * Validates a store name for path-safety.
 *
 * Rejects:
 *   - empty string
 *   - names that do not equal their own basename (path-like, e.g. "a/b", "../x")
 *   - forward slash, backslash, null byte, colon (Windows drive prefix: "C:foo")
 *   - names starting with "." (hidden/relative marker)
 *   - the literal ".." string
 *   - names longer than 255 characters
 *
 * E1 fix: hardened against path traversal on Windows and POSIX.
 */
function validateStoreName(store: string): void {
  if (!store) {
    throw new Error(
      'Invalid store name: store name must not be empty.',
    )
  }
  if (store.length > MAX_STORE_NAME_LENGTH) {
    throw new Error(
      `Invalid store name: "${store.slice(0, 20)}…" is too long (max ${MAX_STORE_NAME_LENGTH} chars).`,
    )
  }
  // Reject path separators (forward slash, backslash), Windows drive colons.
  // Null bytes checked separately to avoid biome noControlCharactersInRegex warning.
  if (/[/\\:]/.test(store) || store.includes('\0')) {
    throw new Error(
      `Invalid store name: "${store}" contains illegal characters (path separators, null byte, or colon).`,
    )
  }
  // Reject names starting with "." — covers ".." and hidden names
  if (store.startsWith('.')) {
    throw new Error(
      `Invalid store name: "${store}" must not start with ".".`,
    )
  }
  // Guard: resolved basename must equal the store name itself.
  // This catches any path-like names that slipped through the above checks.
  if (basename(store) !== store) {
    throw new Error(
      `Invalid store name: "${store}" is path-like and would escape the base directory.`,
    )
  }
}

function validateKey(key: string): void {
  if (!key) {
    throw new Error('Entry key must not be empty')
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** List all active (non-archived) stores. */
export function listStores(): string[] {
  const baseDir = getBaseDir()
  if (!existsSync(baseDir)) return []
  return readdirSync(baseDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.endsWith('.archived'))
    .map(d => d.name)
    .sort()
}

/** List all stores (active + archived). */
export function listAllStores(): string[] {
  const baseDir = getBaseDir()
  if (!existsSync(baseDir)) return []
  return readdirSync(baseDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort()
}

/** Create a new store directory. */
export function createStore(store: string): void {
  validateStoreName(store)
  const storeDir = getStoreDir(store)
  if (existsSync(storeDir)) {
    throw new Error(`Store "${store}" already exists`)
  }
  mkdirSync(storeDir, { recursive: true })
}

/** Archive a store by renaming it to <store>.archived */
export function archiveStore(store: string): void {
  validateStoreName(store)
  const storeDir = getStoreDir(store)
  if (!existsSync(storeDir)) {
    throw new Error(`Store "${store}" does not exist`)
  }
  const archivedDir = storeDir + '.archived'
  renameSync(storeDir, archivedDir)
}

/** Write an entry to a store. Creates the store dir if needed. */
export function setEntry(store: string, key: string, value: string): void {
  validateStoreName(store)
  validateKey(key)

  // D2: Guard against unbounded value sizes (1 MB limit).
  // File-fallback vault is not designed for large data blobs.
  const byteLength = Buffer.byteLength(value, 'utf8')
  if (byteLength > MAX_VALUE_BYTES) {
    throw new Error(
      `Entry value too large: ${byteLength} bytes exceeds the 1 MB limit. ` +
      'Use external storage for large data.',
    )
  }

  const storeDir = getStoreDir(store)
  if (!existsSync(storeDir)) {
    mkdirSync(storeDir, { recursive: true })
  }
  const entryPath = getEntryPath(store, key)

  // C2: Atomic write — write to a .tmp file then rename.
  // On POSIX, rename(2) is atomic; on Windows it is best-effort but safe.
  // This prevents half-written files on crash mid-write.
  const tmpPath = join(storeDir, `.${randomBytes(8).toString('hex')}.tmp`)
  try {
    writeFileSync(tmpPath, value, 'utf8')
    renameSync(tmpPath, entryPath)
  } catch (err) {
    // Clean up tmp file on error
    try { rmSync(tmpPath, { force: true }) } catch { /* ignore cleanup error */ }
    throw err
  }
}

/** Read an entry from a store. Returns null if not found. */
export function getEntry(store: string, key: string): string | null {
  validateStoreName(store)
  validateKey(key)
  const entryPath = getEntryPath(store, key)
  if (!existsSync(entryPath)) return null
  return readFileSync(entryPath, 'utf8')
}

/** Delete an entry from a store. Returns true if it existed. */
export function deleteEntry(store: string, key: string): boolean {
  validateStoreName(store)
  validateKey(key)
  const entryPath = getEntryPath(store, key)
  if (!existsSync(entryPath)) return false
  rmSync(entryPath)
  return true
}

/** List all entry keys in a store (without .md extension). */
export function listEntries(store: string): string[] {
  validateStoreName(store)
  const storeDir = getStoreDir(store)
  if (!existsSync(storeDir)) return []
  return readdirSync(storeDir)
    .filter(f => f.endsWith('.md'))
    .map(f => f.slice(0, -3))
    .sort()
}
