import type { Command } from '../../types/command.js'

const memoryStoresCommand: Command = {
  type: 'local-jsx',
  name: 'memory-stores',
  aliases: ['mem', 'mstore'],
  description:
    'Manage remote memory stores (cross-device memory persistence). Requires Claude Pro/Max/Team subscription.',
  argumentHint:
    'list | get <id> | create <name> | archive <id> | memories <store_id> | create-memory <store_id> <content> | get-memory <store_id> <memory_id> | update-memory <store_id> <memory_id> <content> | delete-memory <store_id> <memory_id> | versions <store_id> | redact <store_id> <version_id>',
  // Hidden until workspace API key path is wired up. Server explicitly says
  // "memory stores require a workspace-scoped API key or session"
  // (probed 2026-05-03). See SUBSCRIPTION-API-ENDPOINTS-REPORT.md.
  isHidden: true,
  isEnabled: () => true,
  bridgeSafe: false,
  availability: ['claude-ai'],
  load: async () => {
    const m = await import('./launchMemoryStores.js')
    return { call: m.callMemoryStores }
  },
}

export default memoryStoresCommand
