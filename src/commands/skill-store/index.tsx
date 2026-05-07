import { getGlobalConfig } from '../../utils/config.js';
import type { Command } from '../../types/command.js';

const skillStoreCommand: Command = {
  type: 'local-jsx',
  name: 'skill-store',
  aliases: ['ss', 'cloud-skills'],
  description:
    'Browse and install remote skills from the Anthropic skill marketplace. Requires Claude Pro/Max/Team subscription.',
  argumentHint:
    'list | get <id> | versions <id> | version <id> <ver> | create <name> <markdown> | delete <id> | install <id>[@<version>]',
  // Visible when a workspace API key is available from env or saved settings.
  // /v1/skills 404s on the subscription plane (probed 2026-05-03).
  isHidden: !process.env['ANTHROPIC_API_KEY'] && !getGlobalConfig().workspaceApiKey,
  isEnabled: () => true,
  bridgeSafe: false,
  availability: ['claude-ai'],
  load: async () => {
    const m = await import('./launchSkillStore.js');
    return { call: m.callSkillStore };
  },
};

export default skillStoreCommand;
