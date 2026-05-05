import React from 'react';
import type { LocalJSXCommandCall } from '../../types/command.js';
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

const USAGE =
  'Usage: /local-memory list | create <store> | store <store> <key> <value> | fetch <store> <key> | entries <store> | archive <store>';

export const callLocalMemory: LocalJSXCommandCall = async (onDone, _context, args) => {
  const parsed = parseLocalMemoryArgs(args ?? '');

  // ── invalid args ──────────────────────────────────────────────────────────
  if (parsed.action === 'invalid') {
    onDone(`${USAGE}\n${parsed.reason}`, { display: 'system' });
    return null;
  }

  // ── list stores ───────────────────────────────────────────────────────────
  if (parsed.action === 'list') {
    try {
      const stores = listStores();
      onDone(stores.length === 0 ? 'No memory stores found.' : `${stores.length} store(s).`, { display: 'system' });
      return React.createElement(LocalMemoryView, { mode: 'list', stores });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onDone(`Failed to list stores: ${msg}`, { display: 'system' });
      return React.createElement(LocalMemoryView, { mode: 'error', message: msg });
    }
  }

  // ── create store ──────────────────────────────────────────────────────────
  if (parsed.action === 'create') {
    const { store } = parsed;
    try {
      createStore(store);
      onDone(`Store created: ${store}`, { display: 'system' });
      return React.createElement(LocalMemoryView, { mode: 'created', store });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onDone(`Failed to create store: ${msg}`, { display: 'system' });
      return React.createElement(LocalMemoryView, { mode: 'error', message: msg });
    }
  }

  // ── store entry ───────────────────────────────────────────────────────────
  if (parsed.action === 'store') {
    const { store, key, value } = parsed;
    try {
      setEntry(store, key, value);
      onDone(`Stored entry "${key}" in store "${store}".`, { display: 'system' });
      return React.createElement(LocalMemoryView, { mode: 'stored', store, key });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onDone(`Failed to store entry: ${msg}`, { display: 'system' });
      return React.createElement(LocalMemoryView, { mode: 'error', message: msg });
    }
  }

  // ── fetch entry ───────────────────────────────────────────────────────────
  if (parsed.action === 'fetch') {
    const { store, key } = parsed;
    try {
      const value = getEntry(store, key);
      if (value === null) {
        onDone(`Entry not found: ${store}/${key}`, { display: 'system' });
        return React.createElement(LocalMemoryView, { mode: 'not-found', store, key });
      }
      onDone(`Entry fetched: ${store}/${key}`, { display: 'system' });
      return React.createElement(LocalMemoryView, { mode: 'fetched', store, key, value });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onDone(`Failed to fetch entry: ${msg}`, { display: 'system' });
      return React.createElement(LocalMemoryView, { mode: 'error', message: msg });
    }
  }

  // ── list entries ──────────────────────────────────────────────────────────
  if (parsed.action === 'entries') {
    const { store } = parsed;
    try {
      const keys = listEntries(store);
      onDone(`${keys.length} entry/entries in store "${store}".`, { display: 'system' });
      return React.createElement(LocalMemoryView, { mode: 'entries', store, keys });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onDone(`Failed to list entries: ${msg}`, { display: 'system' });
      return React.createElement(LocalMemoryView, { mode: 'error', message: msg });
    }
  }

  // ── archive store ─────────────────────────────────────────────────────────
  if (parsed.action === 'archive') {
    const { store } = parsed;
    try {
      archiveStore(store);
      onDone(`Archived store: ${store}`, { display: 'system' });
      return React.createElement(LocalMemoryView, { mode: 'archived', store });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onDone(`Failed to archive store: ${msg}`, { display: 'system' });
      return React.createElement(LocalMemoryView, { mode: 'error', message: msg });
    }
  }

  // Exhaustive guard
  onDone(USAGE, { display: 'system' });
  return null;
};
