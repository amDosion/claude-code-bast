/**
 * Parse the args string for the /local-vault command.
 *
 * Supported sub-commands:
 *   list                         → { action: 'list' }
 *   set <key> <value>            → { action: 'set', key, value }
 *   get <key>                    → { action: 'get', key, reveal: false }
 *   get <key> --reveal           → { action: 'get', key, reveal: true }
 *   delete <key>                 → { action: 'delete', key }
 *   (empty)                      → { action: 'list' }
 *   anything else                → { action: 'invalid', reason }
 */

export type LocalVaultArgs =
  | { action: 'list' }
  | { action: 'set'; key: string; value: string }
  | { action: 'get'; key: string; reveal: boolean }
  | { action: 'delete'; key: string }
  | { action: 'invalid'; reason: string }

const USAGE =
  'Usage: /local-vault list | set <key> <value> | get <key> [--reveal] | delete <key>'

export function parseLocalVaultArgs(args: string): LocalVaultArgs {
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

  // ── set ───────────────────────────────────────────────────────────────────
  if (subCmd === 'set') {
    const key = tokens[1]
    if (!key) {
      return { action: 'invalid', reason: `set requires a key name. ${USAGE}` }
    }
    // Value is everything after <key> (supports spaces in value)
    const rest = trimmed.slice(trimmed.indexOf(key) + key.length).trim()
    if (!rest) {
      return {
        action: 'invalid',
        reason: `set requires a value. ${USAGE}`,
      }
    }
    return { action: 'set', key, value: rest }
  }

  // ── get ───────────────────────────────────────────────────────────────────
  if (subCmd === 'get') {
    const key = tokens[1]
    if (!key) {
      return { action: 'invalid', reason: `get requires a key name. ${USAGE}` }
    }
    const reveal = tokens.includes('--reveal')
    return { action: 'get', key, reveal }
  }

  // ── delete ────────────────────────────────────────────────────────────────
  if (subCmd === 'delete') {
    const key = tokens[1]
    if (!key) {
      return {
        action: 'invalid',
        reason: `delete requires a key name. ${USAGE}`,
      }
    }
    return { action: 'delete', key }
  }

  return {
    action: 'invalid',
    reason: `Unknown sub-command "${subCmd}". ${USAGE}`,
  }
}
