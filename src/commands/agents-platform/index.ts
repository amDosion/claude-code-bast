import { getGlobalConfig } from '../../utils/config.js'
import type { Command } from '../../types/command.js'

const agentsPlatform: Command = {
  type: 'local-jsx',
  name: 'agents-platform',
  aliases: ['agents', 'schedule-agent'],
  description: 'Manage scheduled remote agents (cron-style triggers)',
  argumentHint: 'list | create <cron> <prompt> | delete <id> | run <id>',
  // Visible when a workspace API key is available from env or saved settings.
  // /v1/agents requires workspace-scoped auth (probed 2026-05-03);
  // subscription bearer always 401. See SUBSCRIPTION-API-ENDPOINTS-REPORT.md.
  isHidden:
    !process.env['ANTHROPIC_API_KEY'] && !getGlobalConfig().workspaceApiKey,
  isEnabled: () => true,
  bridgeSafe: false,
  availability: ['claude-ai'],
  load: async () => {
    const m = await import('./launchAgentsPlatform.js')
    return { call: m.callAgentsPlatform }
  },
}

export default agentsPlatform
