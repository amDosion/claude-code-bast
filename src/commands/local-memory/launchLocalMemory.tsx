import React from 'react';
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

async function dispatchLocalMemory(
  parsed: ReturnType<typeof parseLocalMemoryArgs>,
  onDone: LocalJSXCommandOnDone,
): Promise<LocalMemoryViewProps | null> {
  if (parsed.action === 'list') {
    const stores = listStores();
    onDone(stores.length === 0 ? 'No memory stores found.' : `${stores.length} store(s).`, { display: 'system' });
    return { mode: 'list', stores };
  }

  if (parsed.action === 'create') {
    const { store } = parsed;
    createStore(store);
    onDone(`Store created: ${store}`, { display: 'system' });
    return { mode: 'created', store };
  }

  if (parsed.action === 'store') {
    const { store, key, value } = parsed;
    setEntry(store, key, value);
    onDone(`Stored entry "${key}" in store "${store}".`, { display: 'system' });
    return { mode: 'stored', store, key };
  }

  if (parsed.action === 'fetch') {
    const { store, key } = parsed;
    const value = getEntry(store, key);
    if (value === null) {
      onDone(`Entry not found: ${store}/${key}`, { display: 'system' });
      return { mode: 'not-found', store, key };
    }
    onDone(`Entry fetched: ${store}/${key}`, { display: 'system' });
    return { mode: 'fetched', store, key, value };
  }

  if (parsed.action === 'entries') {
    const { store } = parsed;
    const keys = listEntries(store);
    onDone(`${keys.length} entry/entries in store "${store}".`, { display: 'system' });
    return { mode: 'entries', store, keys };
  }

  if (parsed.action === 'archive') {
    const { store } = parsed;
    archiveStore(store);
    onDone(`Archived store: ${store}`, { display: 'system' });
    return { mode: 'archived', store };
  }

  // Exhaustive guard
  onDone(USAGE, { display: 'system' });
  return null;
}

export const callLocalMemory: LocalJSXCommandCall = launchCommand<
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
