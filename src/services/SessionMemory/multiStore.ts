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
import { homedir } from 'node:os'
import { join } from 'node:path'

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

function validateStoreName(store: string): void {
  if (!store || /[/\\]/.test(store) || store.startsWith('.')) {
    throw new Error(
      `Invalid store name: "${store}". Store names must not contain path separators or start with "."`,
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
  const storeDir = getStoreDir(store)
  if (!existsSync(storeDir)) {
    mkdirSync(storeDir, { recursive: true })
  }
  const entryPath = getEntryPath(store, key)
  writeFileSync(entryPath, value, 'utf8')
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
