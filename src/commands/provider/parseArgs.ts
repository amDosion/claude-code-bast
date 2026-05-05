/**
 * Parse args string for the /providers command.
 *
 * Supported sub-commands:
 *   (empty) | list           → { action: 'list' }
 *   show                     → { action: 'show' }
 *   use <id>                 → { action: 'use', id }
 *   add                      → { action: 'add' }
 *   (anything else)          → { action: 'invalid', reason }
 */

export type ProviderArgs =
  | { action: 'list' }
  | { action: 'show' }
  | { action: 'use'; id: string }
  | { action: 'add' }
  | { action: 'invalid'; reason: string }

const USAGE = 'Usage: /providers [list | show | use <id> | add]'

export function parseProviderArgs(args: string): ProviderArgs {
  const trimmed = args.trim()

  if (trimmed === '' || trimmed === 'list') {
    return { action: 'list' }
  }

  if (trimmed === 'show') {
    return { action: 'show' }
  }

  if (trimmed === 'add') {
    return { action: 'add' }
  }

  if (trimmed.startsWith('use')) {
    const rest = trimmed.slice(3).trim()
    if (!rest) {
      return {
        action: 'invalid',
        reason: `use requires a provider id, e.g. use cerebras\n${USAGE}`,
      }
    }
    const parts = rest.split(/\s+/)
    const id = parts[0] ?? rest
    // D7: warn if extra tokens follow the id — likely a typo
    if (parts.length > 1) {
      return {
        action: 'invalid',
        reason: `use expects a single provider id but got extra tokens: "${parts.slice(1).join(' ')}". ${USAGE}`,
      }
    }
    return { action: 'use', id }
  }

  const subCmd = trimmed.split(/\s+/)[0] ?? trimmed
  return {
    action: 'invalid',
    reason: `Unknown sub-command "${subCmd}".\n${USAGE}`,
  }
}
