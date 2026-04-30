import type { Command } from '../../types/command.js';

const vaultCommand: Command = {
  type: 'local-jsx',
  name: 'vault',
  aliases: ['vaults'],
  description:
    'Manage remote secret vaults and credentials for cloud agents. Requires Claude Pro/Max/Team subscription.',
  argumentHint:
    'list | create <name> | get <id> | archive <id> | add-credential <vault_id> <key> <value> | archive-credential <vault_id> <cred_id>',
  isHidden: false,
  isEnabled: () => true,
  bridgeSafe: false,
  availability: ['claude-ai'],
  load: async () => {
    const m = await import('./launchVault.js');
    return { call: m.callVault };
  },
};

export default vaultCommand;
