import type { Command, LocalCommandResult } from '../types/command.js'
import { getGlobalConfig } from '../utils/config.js'

/**
 * /statusline — show what the fork's built-in status line is currently
 * displaying, and explain the (optional) shell-command second row.
 *
 * Was a prompt-type wrapper that spawned the upstream `statusline-setup`
 * agent to read your shell PS1 and write `settings.statusLine.command`.
 * The fork now ships `BuiltinStatusLine` + `CachePill` as React components
 * inside `StatusLine.tsx` — they render unconditionally, so the agent step
 * is redundant. This command was changed to a pure-local status report:
 * no LLM call, no agent spawn.
 *
 * Configuring a custom bottom-row shell command is still supported — just
 * edit `~/.claude/settings.json` directly (`statusLine.command`).
 */

function formatStatusLineState(): string {
  const cfg = getGlobalConfig() as { statusLine?: { type?: string; command?: string } }
  const command = cfg.statusLine?.command
  const hasCommand = typeof command === 'string' && command.trim().length > 0

  const lines: string[] = []

  lines.push('## Status line state')
  lines.push('')
  lines.push('**Top row (always on, fork built-in):**')
  lines.push('  • model name + Context % + Session/Weekly limits + cost')
  lines.push('  • Cache hit-rate + 1h TTL countdown pill')
  lines.push('  Source: `src/components/BuiltinStatusLine.tsx` + `CachePill` in `StatusLine.tsx`')
  lines.push('')
  lines.push('**Bottom row (optional, shell stdout):**')
  if (hasCommand) {
    lines.push(`  • Active. Command: \`${command}\``)
    lines.push('  • Claude pipes a JSON payload (model, workspace, cost, context_window, rate_limits) to stdin and renders one line of stdout.')
  } else {
    lines.push('  • Inactive — no `statusLine.command` configured.')
    lines.push('  • To enable, add to `~/.claude/settings.json`:')
    lines.push('    ```json')
    lines.push('    "statusLine": {')
    lines.push('      "type": "command",')
    lines.push('      "command": "/path/to/your/script.sh"')
    lines.push('    }')
    lines.push('    ```')
    lines.push('  • The script reads JSON from stdin and prints one line to stdout.')
  }
  lines.push('')
  lines.push('_The legacy upstream behavior of `/statusline` (spawn `statusline-setup` agent to read your shell PS1) was removed because the React top row already covers the same information without any configuration._')

  return lines.join('\n')
}

const statusline: Command = {
  type: 'local',
  name: 'statusline',
  description: "Show Claude Code's status line state (top row is always on; bottom shell row is optional)",
  isHidden: false,
  isEnabled: () => true,
  supportsNonInteractive: true,
  load: async () => ({
    call: async (): Promise<LocalCommandResult> => ({
      type: 'text',
      value: formatStatusLineState(),
    }),
  }),
}

export default statusline
