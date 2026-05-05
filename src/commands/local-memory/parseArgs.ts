/**
 * Parse the args string for the /local-memory command.
 *
 * Supported sub-commands:
 *   list                           → { action: 'list' }
 *   create <store>                 → { action: 'create', store }
 *   store <store> <key> <value>    → { action: 'store', store, key, value }
 *   fetch <store> <key>            → { action: 'fetch', store, key }
 *   entries <store>                → { action: 'entries', store }
 *   archive <store>                → { action: 'archive', store }
 *   (empty)                        → { action: 'list' }
 *   anything else                  → { action: 'invalid', reason }
 */

export type LocalMemoryArgs =
  | { action: 'list' }
  | { action: 'create'; store: string }
  | { action: 'store'; store: string; key: string; value: string }
  | { action: 'fetch'; store: string; key: string }
  | { action: 'entries'; store: string }
  | { action: 'archive'; store: string }
  | { action: 'invalid'; reason: string }

const USAGE =
  'Usage: /local-memory list | create <store> | store <store> <key> <value> | fetch <store> <key> | entries <store> | archive <store>'

export function parseLocalMemoryArgs(args: string): LocalMemoryArgs {
  const trimmed = args.trim()

  if (trimmed === '' || trimmed === 'list') {
    return { action: 'list' }
  }

  const tokens = trimmed.split(/\s+/)
  const subCmd = tokens[0]

  // ── list ──────────────────────────────────────────────────────────────────
  if (subCmd === 'list') {
    return { action: 'list' }
  }

  // ── create ────────────────────────────────────────────────────────────────
  if (subCmd === 'create') {
    const store = tokens[1]
    if (!store) {
      return {
        action: 'invalid',
        reason: `create requires a store name. ${USAGE}`,
      }
    }
    return { action: 'create', store }
  }

  // ── store ─────────────────────────────────────────────────────────────────
  if (subCmd === 'store') {
    const store = tokens[1]
    const key = tokens[2]
    if (!store) {
      return {
        action: 'invalid',
        reason: `store requires a store name. ${USAGE}`,
      }
    }
    if (!key) {
      return { action: 'invalid', reason: `store requires a key. ${USAGE}` }
    }
    // Value is everything after <key>
    const keyIdx = trimmed.indexOf(key, trimmed.indexOf(store) + store.length)
    const rest = trimmed.slice(keyIdx + key.length).trim()
    if (!rest) {
      return { action: 'invalid', reason: `store requires a value. ${USAGE}` }
    }
    return { action: 'store', store, key, value: rest }
  }

  // ── fetch ─────────────────────────────────────────────────────────────────
  if (subCmd === 'fetch') {
    const store = tokens[1]
    const key = tokens[2]
    if (!store) {
      return {
        action: 'invalid',
        reason: `fetch requires a store name. ${USAGE}`,
      }
    }
    if (!key) {
      return { action: 'invalid', reason: `fetch requires a key. ${USAGE}` }
    }
    return { action: 'fetch', store, key }
  }

  // ── entries ───────────────────────────────────────────────────────────────
  if (subCmd === 'entries') {
    const store = tokens[1]
    if (!store) {
      return {
        action: 'invalid',
        reason: `entries requires a store name. ${USAGE}`,
      }
    }
    return { action: 'entries', store }
  }

  // ── archive ───────────────────────────────────────────────────────────────
  if (subCmd === 'archive') {
    const store = tokens[1]
    if (!store) {
      return {
        action: 'invalid',
        reason: `archive requires a store name. ${USAGE}`,
      }
    }
    return { action: 'archive', store }
  }

  return {
    action: 'invalid',
    reason: `Unknown sub-command "${subCmd}". ${USAGE}`,
  }
}
