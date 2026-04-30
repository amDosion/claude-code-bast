import type { Command } from '../../types/command.js'

const scheduleCommand: Command = {
  type: 'local-jsx',
  name: 'schedule',
  aliases: ['cron', 'triggers'],
  description:
    'Manage scheduled remote agent triggers (cloud cron). Requires Claude Pro/Max/Team subscription.',
  argumentHint:
    'list | get <id> | create <cron> <prompt> | update <id> <field> <value> | delete <id> | run <id> | enable <id> | disable <id>',
  isHidden: false,
  isEnabled: () => true,
  bridgeSafe: false,
  availability: ['claude-ai'],
  load: async () => {
    const m = await import('./launchSchedule.js')
    return { call: m.callSchedule }
  },
}

export default scheduleCommand
