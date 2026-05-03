import type { Command } from '../../types/command.js'

const agentsPlatform: Command = {
  type: 'local-jsx',
  name: 'agents-platform',
  aliases: ['agents', 'schedule-agent'],
  description: 'Manage scheduled remote agents (cron-style triggers)',
  argumentHint: 'list | create <cron> <prompt> | delete <id> | run <id>',
  // Hidden until workspace API key path is wired up.
  // /v1/agents requires workspace-scoped auth (probed 2026-05-03);
  // subscription bearer always 401. See SUBSCRIPTION-API-ENDPOINTS-REPORT.md.
  isHidden: true,
  isEnabled: () => true,
  bridgeSafe: false,
  availability: ['claude-ai'],
  load: async () => {
    const m = await import('./launchAgentsPlatform.js')
    return { call: m.callAgentsPlatform }
  },
}

export default agentsPlatform
