import type { Command } from '../../types/command.js';

const localMemoryCommand: Command = {
  type: 'local-jsx',
  name: 'local-memory',
  aliases: ['lm'],
  description:
    'Manage local memory stores for notes and context. Stored in ~/.claude/local-memory/ — no API key required.',
  argumentHint:
    'list | create <store> | store <store> <key> <value> | fetch <store> <key> | entries <store> | archive <store>',
  isHidden: false,
  isEnabled: () => true,
  bridgeSafe: true,
  load: async () => {
    const m = await import('./launchLocalMemory.js');
    return { call: m.callLocalMemory };
  },
};

export default localMemoryCommand;
