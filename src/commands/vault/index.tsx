import type { Command } from '../../types/command.js';

const vaultCommand: Command = {
  type: 'local-jsx',
  name: 'vault',
  aliases: ['vaults'],
  description:
    'Manage remote secret vaults and credentials for cloud agents. Requires Claude Pro/Max/Team subscription.',
  argumentHint:
    'list | create <name> | get <id> | archive <id> | add-credential <vault_id> <key> <value> | archive-credential <vault_id> <cred_id>',
  // Visible when ANTHROPIC_API_KEY is configured (workspace-scoped key required).
  // /v1/vaults requires workspace-scoped auth (probed 2026-05-03);
  // subscription bearer always 401. See SUBSCRIPTION-API-ENDPOINTS-REPORT.md.
  isHidden: !process.env['ANTHROPIC_API_KEY'],
  isEnabled: () => true,
  bridgeSafe: false,
  availability: ['claude-ai'],
  load: async () => {
    const m = await import('./launchVault.js');
    return { call: m.callVault };
  },
};

export default vaultCommand;
