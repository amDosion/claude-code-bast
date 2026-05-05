import type { Command } from '../../types/command.js';

const localVaultCommand: Command = {
  type: 'local-jsx',
  name: 'local-vault',
  aliases: ['lv', 'local-secret'],
  description:
    'Manage local encrypted secrets. Stored in OS keychain or encrypted file fallback — no API key required.',
  argumentHint: 'list | set <key> <value> | get <key> [--reveal] | delete <key>',
  isHidden: false,
  isEnabled: () => true,
  bridgeSafe: true,
  load: async () => {
    const m = await import('./launchLocalVault.js');
    return { call: m.callLocalVault };
  },
};

export default localVaultCommand;
