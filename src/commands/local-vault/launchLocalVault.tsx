import React from 'react';
import { Box, Dialog, Text, useInput } from '@anthropic/ink';
import type { LocalJSXCommandCall } from '../../types/command.js';
import { setSecret, getSecret, deleteSecret, listKeys, maskSecret } from '../../services/localVault/store.js';
import { LocalVaultView } from './LocalVaultView.js';
import { parseLocalVaultArgs } from './parseArgs.js';
import { launchCommand } from '../_shared/launchCommand.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';

const USAGE = 'Usage: /local-vault list | set <key> <value> | get <key> [--reveal] | delete <key>';

type LocalVaultViewProps = React.ComponentProps<typeof LocalVaultView>;

type LocalVaultAction = {
  label: string;
  description: string;
  run: () => void;
};

const ACTION_LABEL_COLUMN_WIDTH = 26;

function formatKeyList(keys: string[]): string {
  if (keys.length === 0) {
    return 'No secrets stored.';
  }
  return ['Local Vault Keys', ...keys.map(key => `- ${key}`)].join('\n');
}

function LocalVaultPanel({
  onDone,
}: {
  onDone: LocalJSXCommandOnDone;
}): React.ReactNode {
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const actions = React.useMemo<LocalVaultAction[]>(
    () => [
      {
        label: 'List',
        description: 'Show stored secret keys without values',
        run: () => {
          void listKeys().then(keys => {
            onDone(formatKeyList(keys), { display: 'system' });
          });
        },
      },
      {
        label: 'Set',
        description: 'Prepare a command to store a redacted secret',
        run: () =>
          onDone(undefined, {
            display: 'skip',
            nextInput: '/local-vault set ',
          }),
      },
      {
        label: 'Get',
        description: 'Prepare a masked secret lookup',
        run: () =>
          onDone(undefined, {
            display: 'skip',
            nextInput: '/local-vault get ',
          }),
      },
      {
        label: 'Delete',
        description: 'Prepare a secret deletion command',
        run: () =>
          onDone(undefined, {
            display: 'skip',
            nextInput: '/local-vault delete ',
          }),
      },
      {
        label: 'About',
        description: 'Show local vault command syntax',
        run: () => onDone(USAGE, { display: 'system' }),
      },
    ],
    [onDone],
  );

  const selectCurrent = () => {
    const action = actions[selectedIndex];
    if (!action) return;
    action.run();
  };

  useInput((_input, key) => {
    if (key.upArrow) {
      setSelectedIndex(index => Math.max(0, index - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex(index => Math.min(actions.length - 1, index + 1));
      return;
    }
    if (key.return) {
      selectCurrent();
    }
  });

  return (
    <Dialog
      title="Local Vault"
      subtitle={`${actions.length} actions`}
      onCancel={() => onDone('Local vault panel dismissed', { display: 'system' })}
      color="background"
      hideInputGuide
    >
      <Box flexDirection="column">
        {actions.map((action, index) => (
          <Box key={action.label} flexDirection="row">
            <Text>{`${index === selectedIndex ? '›' : ' '} ${action.label}`.padEnd(ACTION_LABEL_COLUMN_WIDTH)}</Text>
            <Text dimColor>{action.description}</Text>
          </Box>
        ))}
        <Box marginTop={1}>
          <Text dimColor>↑/↓ select · Enter run · Esc close</Text>
        </Box>
      </Box>
    </Dialog>
  );
}

async function dispatchLocalVault(
  parsed: ReturnType<typeof parseLocalVaultArgs>,
  onDone: LocalJSXCommandOnDone,
): Promise<LocalVaultViewProps | null> {
  if (parsed.action === 'list') {
    const keys = await listKeys();
    onDone(formatKeyList(keys), { display: 'system' });
    return null;
  }

  if (parsed.action === 'set') {
    const { key, value } = parsed;
    await setSecret(key, value);
    // Never echo the value in onDone — security invariant
    onDone(`Secret stored: ${key} = [REDACTED]`, { display: 'system' });
    return null;
  }

  if (parsed.action === 'get') {
    const { key, reveal } = parsed;
    const value = await getSecret(key);
    if (value === null) {
      onDone(`Key not found: ${key}`, { display: 'system' });
      return null;
    }
    if (reveal) {
      // Security invariant: only --reveal shows plaintext; warn user
      onDone(
        [
          `Secret revealed for: ${key}`,
          'Warning: secret revealed in terminal.',
          `${key} = ${value}`,
        ].join('\n'),
        { display: 'system' },
      );
      return null;
    }
    // Default: mask display
    const masked = maskSecret(value);
    onDone(`Key found: ${key} = ${masked}`, { display: 'system' });
    return null;
  }

  if (parsed.action === 'delete') {
    const { key } = parsed;
    const deleted = await deleteSecret(key);
    if (!deleted) {
      onDone(`Key not found: ${key}`, { display: 'system' });
      return null;
    }
    onDone(`Deleted: ${key}`, { display: 'system' });
    return null;
  }

  // Exhaustive guard — should not be reached for valid parsed actions
  onDone(USAGE, { display: 'system' });
  return null;
}

const callLocalVaultDirect: LocalJSXCommandCall = launchCommand<
  ReturnType<typeof parseLocalVaultArgs>,
  LocalVaultViewProps
>({
  commandName: 'local-vault',
  parseArgs: (raw: string) => {
    const result = parseLocalVaultArgs(raw);
    if (result.action === 'invalid') {
      return { action: 'invalid' as const, reason: `${USAGE}\n${result.reason}` };
    }
    return result;
  },
  dispatch: dispatchLocalVault,
  View: LocalVaultView,
  errorView: (msg: string) => React.createElement(LocalVaultView, { mode: 'error', message: msg }),
});

export const callLocalVault: LocalJSXCommandCall = async (onDone, context, args) => {
  if ((args ?? '').trim() === '') {
    return <LocalVaultPanel onDone={onDone} />;
  }
  return callLocalVaultDirect(onDone, context, args);
};
