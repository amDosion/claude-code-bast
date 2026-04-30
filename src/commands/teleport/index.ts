import type { Command } from '../../types/command.js'

const teleport: Command = {
  type: 'local-jsx',
  name: 'teleport',
  // Official v2.1.123 advertises alias `tp` (reverse-engineered from
  // claude.exe: `name:"teleport",aliases:["tp"]`). Keeping it for parity.
  aliases: ['tp'],
  description: 'Resume a Claude Code session from claude.ai',
  argumentHint: '<session-id>',
  isHidden: false,
  isEnabled: () => true,
  bridgeSafe: false,
  getBridgeInvocationError: (_args: string) =>
    'teleport resumes the REPL and is not bridge-safe',
  load: async () => {
    const m = await import('./launchTeleport.js')
    return { call: m.callTeleport }
  },
}

export default teleport
