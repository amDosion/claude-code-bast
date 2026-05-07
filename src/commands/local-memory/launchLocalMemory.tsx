import React from 'react';
import { Box, Dialog, Text, useInput } from '@anthropic/ink';
import type { LocalJSXCommandCall, LocalJSXCommandOnDone } from '../../types/command.js';
import {
  listStores,
  createStore,
  setEntry,
  getEntry,
  listEntries,
  archiveStore,
} from '../../services/SessionMemory/multiStore.js';
import { LocalMemoryView } from './LocalMemoryView.js';
import { parseLocalMemoryArgs } from './parseArgs.js';
import { launchCommand } from '../_shared/launchCommand.js';

const USAGE =
  'Usage: /local-memory list | create <store> | store <store> <key> <value> | fetch <store> <key> | entries <store> | archive <store>';

type LocalMemoryViewProps = React.ComponentProps<typeof LocalMemoryView>;

type LocalMemoryAction = {
  label: string;
  description: string;
  run: () => void;
};

const ACTION_LABEL_COLUMN_WIDTH = 26;

function formatStoreList(stores: string[]): string {
  if (stores.length === 0) {
    return 'No memory stores found.';
  }
  return ['Local Memory Stores', ...stores.map(store => `- ${store}`)].join('\n');
}

function formatEntryList(store: string, keys: string[]): string {
  if (keys.length === 0) {
    return `No entries in "${store}".`;
  }
  return [`Entries in "${store}"`, ...keys.map(key => `- ${key}`)].join('\n');
}

function LocalMemoryPanel({
  onDone,
}: {
  onDone: LocalJSXCommandOnDone;
}): React.ReactNode {
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const actions = React.useMemo<LocalMemoryAction[]>(
    () => [
      {
        label: 'List',
        description: 'Show local memory stores',
        run: () => onDone(formatStoreList(listStores()), { display: 'system' }),
      },
      {
        label: 'Create',
        description: 'Prepare a store creation command',
        run: () =>
          onDone(undefined, {
            display: 'skip',
            nextInput: '/local-memory create ',
          }),
      },
      {
        label: 'Store',
        description: 'Prepare an entry write command',
        run: () =>
          onDone(undefined, {
            display: 'skip',
            nextInput: '/local-memory store ',
          }),
      },
      {
        label: 'Fetch',
        description: 'Prepare an entry read command',
        run: () =>
          onDone(undefined, {
            display: 'skip',
            nextInput: '/local-memory fetch ',
          }),
      },
      {
        label: 'Entries',
        description: 'Prepare a command to list entry keys',
        run: () =>
          onDone(undefined, {
            display: 'skip',
            nextInput: '/local-memory entries ',
          }),
      },
      {
        label: 'Archive',
        description: 'Prepare a store archive command',
        run: () =>
          onDone(undefined, {
            display: 'skip',
            nextInput: '/local-memory archive ',
          }),
      },
      {
        label: 'About',
        description: 'Show local memory command syntax',
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
      title="Local Memory"
      subtitle={`${actions.length} actions`}
      onCancel={() => onDone('Local memory panel dismissed', { display: 'system' })}
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

async function dispatchLocalMemory(
  parsed: ReturnType<typeof parseLocalMemoryArgs>,
  onDone: LocalJSXCommandOnDone,
): Promise<LocalMemoryViewProps | null> {
  if (parsed.action === 'list') {
    const stores = listStores();
    onDone(formatStoreList(stores), { display: 'system' });
    return null;
  }

  if (parsed.action === 'create') {
    const { store } = parsed;
    createStore(store);
    onDone(`Store created: ${store}`, { display: 'system' });
    return null;
  }

  if (parsed.action === 'store') {
    const { store, key, value } = parsed;
    setEntry(store, key, value);
    onDone(`Stored entry "${key}" in store "${store}".`, { display: 'system' });
    return null;
  }

  if (parsed.action === 'fetch') {
    const { store, key } = parsed;
    const value = getEntry(store, key);
    if (value === null) {
      onDone(`Entry not found: ${store}/${key}`, { display: 'system' });
      return null;
    }
    onDone(`Entry fetched: ${store}/${key}\n${value}`, { display: 'system' });
    return null;
  }

  if (parsed.action === 'entries') {
    const { store } = parsed;
    const keys = listEntries(store);
    onDone(formatEntryList(store, keys), { display: 'system' });
    return null;
  }

  if (parsed.action === 'archive') {
    const { store } = parsed;
    archiveStore(store);
    onDone(`Archived store: ${store}`, { display: 'system' });
    return null;
  }

  // Exhaustive guard
  onDone(USAGE, { display: 'system' });
  return null;
}

const callLocalMemoryDirect: LocalJSXCommandCall = launchCommand<
  ReturnType<typeof parseLocalMemoryArgs>,
  LocalMemoryViewProps
>({
  commandName: 'local-memory',
  parseArgs: (raw: string) => {
    const result = parseLocalMemoryArgs(raw);
    if (result.action === 'invalid') {
      return { action: 'invalid' as const, reason: `${USAGE}\n${result.reason}` };
    }
    return result;
  },
  dispatch: dispatchLocalMemory,
  View: LocalMemoryView,
  errorView: (msg: string) => React.createElement(LocalMemoryView, { mode: 'error', message: msg }),
});

export const callLocalMemory: LocalJSXCommandCall = async (onDone, context, args) => {
  if ((args ?? '').trim() === '') {
    return <LocalMemoryPanel onDone={onDone} />;
  }
  return callLocalMemoryDirect(onDone, context, args);
};
