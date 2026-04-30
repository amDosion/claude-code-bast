import type { Command } from '../../types/command.js';

const skillStoreCommand: Command = {
  type: 'local-jsx',
  name: 'skill-store',
  aliases: ['ss', 'cloud-skills'],
  description:
    'Browse and install remote skills from the Anthropic skill marketplace. Requires Claude Pro/Max/Team subscription.',
  argumentHint:
    'list | get <id> | versions <id> | version <id> <ver> | create <name> <markdown> | delete <id> | install <id>[@<version>]',
  isHidden: false,
  isEnabled: () => true,
  bridgeSafe: false,
  availability: ['claude-ai'],
  load: async () => {
    const m = await import('./launchSkillStore.js');
    return { call: m.callSkillStore };
  },
};

export default skillStoreCommand;
