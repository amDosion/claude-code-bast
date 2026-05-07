import type { Command, LocalCommandResult } from '../types/command.js';
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../utils/settings/settings.js';

/**
 * /statusline — toggle the fork's built-in status line (BuiltinStatusLine +
 * CachePill).
 *
 * Was a prompt-type wrapper that spawned the upstream `statusline-setup`
 * agent to scrape PS1 and write `settings.statusLine.command`. The fork ships
 * its own React rendering, so the agent step was redundant. Replaced with a
 * pure-local toggle that flips `statusLineEnabled` in user settings.
 *
 * - Default state: off (no row rendered).
 * - `/statusline`        → toggle (off → on, on → off).
 * - `/statusline on`     → force on.
 * - `/statusline off`    → force off.
 *
 * The optional bottom-row shell command (`settings.statusLine.command`) is
 * still loaded when present and the top row is enabled. Configure it by
 * editing `~/.claude/settings.json` directly.
 */

function parseDesired(args: string, current: boolean): boolean {
  const trimmed = args.trim().toLowerCase();
  if (trimmed === 'on' || trimmed === 'enable' || trimmed === 'true') return true;
  if (trimmed === 'off' || trimmed === 'disable' || trimmed === 'false') return false;
  return !current;
}

function describeBottomRow(settings: ReturnType<typeof getInitialSettings>): string[] {
  const command = settings.statusLine?.command;
  const hasCommand = typeof command === 'string' && command.trim().length > 0;
  if (hasCommand) {
    return [
      `  • Bottom row (shell): active. Command: \`${command}\``,
      '  • Disable by removing `statusLine.command` in `~/.claude/settings.json`.',
    ];
  }
  return [
    '  • Bottom row (shell): not configured.',
    '  • Optional — to enable, add to `~/.claude/settings.json`:',
    '    `"statusLine": { "type": "command", "command": "/path/to/script.sh" }`',
  ];
}

const statusline: Command = {
  type: 'local',
  name: 'statusline',
  description: "Toggle Claude Code's built-in status line (top row: model + ctx + limits + cost + cache pill)",
  argumentHint: '[on|off]',
  isHidden: false,
  isEnabled: () => true,
  supportsNonInteractive: true,
  load: async () => ({
    call: async (args: string): Promise<LocalCommandResult> => {
      const before = getInitialSettings();
      const current = before.statusLineEnabled === true;
      const next = parseDesired(args, current);

      if (next === current) {
        const lines = [
          `Status line is already **${next ? 'on' : 'off'}**.`,
          '',
          ...describeBottomRow(before),
        ];
        return { type: 'text', value: lines.join('\n') };
      }

      const { error } = updateSettingsForSource('userSettings', {
        statusLineEnabled: next,
      });
      if (error) {
        return {
          type: 'text',
          value: `Failed to update settings: ${error.message}`,
        };
      }

      const after = getInitialSettings();
      const lines = [
        `Status line **${next ? 'enabled' : 'disabled'}**${current === next ? '' : ' (was ' + (current ? 'on' : 'off') + ')'}`,
        '',
        '**Top row** (fork built-in): model + Context % + Session/Weekly limits + cost + Cache hit-rate pill.',
        ...describeBottomRow(after),
        '',
        '_Settings written to `~/.claude/settings.json` (`statusLineEnabled`)._',
      ];
      return { type: 'text', value: lines.join('\n') };
    },
  }),
};

export default statusline;
