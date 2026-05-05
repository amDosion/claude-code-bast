import type { Command } from '../../types/command.js';

const providersCommand: Command = {
  type: 'local-jsx',
  name: 'providers',
  aliases: ['provider-registry'],
  description: 'List and switch OpenAI-compatible inference providers (cerebras, groq, qwen, deepseek, custom).',
  argumentHint: '[list | show | use <id> | add]',
  isHidden: false,
  isEnabled: () => true,
  bridgeSafe: false,
  load: async () => {
    const m = await import('./launchProvider.js');
    return { call: m.callProviders };
  },
};

export default providersCommand;
