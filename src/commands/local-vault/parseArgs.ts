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

// Markdown renderer in REPL output treats `<key>` / `<value>` as HTML tags
// and strips them. Use uppercase placeholder names without angle brackets
// so the full usage line is visible to users.
const USAGE =
  'Usage: /local-vault list | set KEY VALUE | get KEY [--reveal] | delete KEY'

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
    // D3: reject keys that start with '-' (would be mistaken for flags)
    if (key.startsWith('-')) {
      return {
        action: 'invalid',
        reason: `Key name must not start with "-" (reserved for flags). ${USAGE}`,
      }
    }
    // D4: value is tokens[2..] joined, not substring math (handles keys with repeated substrings)
    const rest = tokens.slice(2).join(' ')
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
