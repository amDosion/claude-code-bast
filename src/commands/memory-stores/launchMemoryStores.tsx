import React from 'react';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
import {
  archiveStore,
  createMemory,
  createStore,
  deleteMemory,
  getMemory,
  getStore,
  listMemories,
  listStores,
  listVersions,
  redactVersion,
  updateMemory,
} from './memoryStoresApi.js';
import { MemoryStoresView } from './MemoryStoresView.js';
import { parseMemoryStoresArgs } from './parseArgs.js';

export const callMemoryStores: LocalJSXCommandCall = async (onDone, _context, args) => {
  logEvent('tengu_memory_stores_started', {
    args: (args ?? '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  });

  const parsed = parseMemoryStoresArgs(args ?? '');

  // ── invalid args ──────────────────────────────────────────────────────────
  if (parsed.action === 'invalid') {
    logEvent('tengu_memory_stores_failed', {
      reason: parsed.reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    onDone(
      `Usage: /memory-stores list | get <id> | create <name> | archive <id> | memories <store_id> | create-memory <store_id> <content> | get-memory <store_id> <memory_id> | update-memory <store_id> <memory_id> <content> | delete-memory <store_id> <memory_id> | versions <store_id> | redact <store_id> <version_id>\n${parsed.reason}`,
      { display: 'system' },
    );
    return null;
  }

  // ── list stores ───────────────────────────────────────────────────────────
  if (parsed.action === 'list') {
    logEvent('tengu_memory_stores_list', {});
    try {
      const stores = await listStores();
      onDone(stores.length === 0 ? 'No memory stores found.' : `${stores.length} memory store(s).`, {
        display: 'system',
      });
      return React.createElement(MemoryStoresView, { mode: 'list', stores });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent('tengu_memory_stores_failed', {
        reason: msg as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      onDone(`Failed to list memory stores: ${msg}`, { display: 'system' });
      return React.createElement(MemoryStoresView, { mode: 'error', message: msg });
    }
  }

  // ── get store ─────────────────────────────────────────────────────────────
  if (parsed.action === 'get') {
    const { id } = parsed;
    logEvent('tengu_memory_stores_get', {
      id: id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    try {
      const store = await getStore(id);
      onDone(`Memory store ${id} fetched.`, { display: 'system' });
      return React.createElement(MemoryStoresView, { mode: 'detail', store });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent('tengu_memory_stores_failed', {
        reason: msg as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      onDone(`Failed to get memory store ${id}: ${msg}`, { display: 'system' });
      return React.createElement(MemoryStoresView, { mode: 'error', message: msg });
    }
  }

  // ── create store ──────────────────────────────────────────────────────────
  if (parsed.action === 'create') {
    const { name } = parsed;
    logEvent('tengu_memory_stores_create', {
      name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    try {
      const store = await createStore(name);
      onDone(`Memory store created: ${store.memory_store_id}`, { display: 'system' });
      return React.createElement(MemoryStoresView, { mode: 'created', store });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent('tengu_memory_stores_failed', {
        reason: msg as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      onDone(`Failed to create memory store: ${msg}`, { display: 'system' });
      return React.createElement(MemoryStoresView, { mode: 'error', message: msg });
    }
  }

  // ── archive store ─────────────────────────────────────────────────────────
  if (parsed.action === 'archive') {
    const { id } = parsed;
    logEvent('tengu_memory_stores_archive', {
      id: id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    try {
      const store = await archiveStore(id);
      onDone(`Memory store ${id} archived.`, { display: 'system' });
      return React.createElement(MemoryStoresView, { mode: 'archived', store });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent('tengu_memory_stores_failed', {
        reason: msg as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      onDone(`Failed to archive memory store ${id}: ${msg}`, { display: 'system' });
      return React.createElement(MemoryStoresView, { mode: 'error', message: msg });
    }
  }

  // ── list memories ─────────────────────────────────────────────────────────
  if (parsed.action === 'memories') {
    const { storeId } = parsed;
    logEvent('tengu_memory_stores_list_memories', {
      storeId: storeId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    try {
      const memories = await listMemories(storeId);
      onDone(
        memories.length === 0
          ? `No memories in store ${storeId}.`
          : `${memories.length} memory(ies) in store ${storeId}.`,
        { display: 'system' },
      );
      return React.createElement(MemoryStoresView, {
        mode: 'memory-list',
        storeId,
        memories,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent('tengu_memory_stores_failed', {
        reason: msg as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      onDone(`Failed to list memories in store ${storeId}: ${msg}`, { display: 'system' });
      return React.createElement(MemoryStoresView, { mode: 'error', message: msg });
    }
  }

  // ── create memory ─────────────────────────────────────────────────────────
  if (parsed.action === 'create-memory') {
    const { storeId, content } = parsed;
    logEvent('tengu_memory_stores_create_memory', {
      storeId: storeId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    try {
      const memory = await createMemory(storeId, content);
      onDone(`Memory created: ${memory.memory_id}`, { display: 'system' });
      return React.createElement(MemoryStoresView, { mode: 'memory-created', memory });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent('tengu_memory_stores_failed', {
        reason: msg as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      onDone(`Failed to create memory in store ${storeId}: ${msg}`, { display: 'system' });
      return React.createElement(MemoryStoresView, { mode: 'error', message: msg });
    }
  }

  // ── get memory ────────────────────────────────────────────────────────────
  if (parsed.action === 'get-memory') {
    const { storeId, memoryId } = parsed;
    logEvent('tengu_memory_stores_get_memory', {
      storeId: storeId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    try {
      const memory = await getMemory(storeId, memoryId);
      onDone(`Memory ${memoryId} fetched.`, { display: 'system' });
      return React.createElement(MemoryStoresView, { mode: 'memory-detail', memory });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent('tengu_memory_stores_failed', {
        reason: msg as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      onDone(`Failed to get memory ${memoryId}: ${msg}`, { display: 'system' });
      return React.createElement(MemoryStoresView, { mode: 'error', message: msg });
    }
  }

  // ── update memory ─────────────────────────────────────────────────────────
  if (parsed.action === 'update-memory') {
    const { storeId, memoryId, content } = parsed;
    logEvent('tengu_memory_stores_update_memory', {
      storeId: storeId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    try {
      const memory = await updateMemory(storeId, memoryId, content);
      onDone(`Memory ${memoryId} updated.`, { display: 'system' });
      return React.createElement(MemoryStoresView, { mode: 'memory-updated', memory });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent('tengu_memory_stores_failed', {
        reason: msg as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      onDone(`Failed to update memory ${memoryId}: ${msg}`, { display: 'system' });
      return React.createElement(MemoryStoresView, { mode: 'error', message: msg });
    }
  }

  // ── delete memory ─────────────────────────────────────────────────────────
  if (parsed.action === 'delete-memory') {
    const { storeId, memoryId } = parsed;
    logEvent('tengu_memory_stores_delete_memory', {
      storeId: storeId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    try {
      await deleteMemory(storeId, memoryId);
      onDone(`Memory ${memoryId} deleted.`, { display: 'system' });
      return React.createElement(MemoryStoresView, {
        mode: 'memory-deleted',
        storeId,
        memoryId,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent('tengu_memory_stores_failed', {
        reason: msg as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      onDone(`Failed to delete memory ${memoryId}: ${msg}`, { display: 'system' });
      return React.createElement(MemoryStoresView, { mode: 'error', message: msg });
    }
  }

  // ── list versions ─────────────────────────────────────────────────────────
  if (parsed.action === 'versions') {
    const { storeId } = parsed;
    logEvent('tengu_memory_stores_versions', {
      storeId: storeId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    try {
      const versions = await listVersions(storeId);
      onDone(
        versions.length === 0
          ? `No memory versions found for store ${storeId}.`
          : `${versions.length} version(s) in store ${storeId}.`,
        { display: 'system' },
      );
      return React.createElement(MemoryStoresView, {
        mode: 'versions',
        storeId,
        versions,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent('tengu_memory_stores_failed', {
        reason: msg as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      onDone(`Failed to list versions for store ${storeId}: ${msg}`, { display: 'system' });
      return React.createElement(MemoryStoresView, { mode: 'error', message: msg });
    }
  }

  // ── redact version ────────────────────────────────────────────────────────
  // parsed.action === 'redact'
  const { storeId, versionId } = parsed;
  logEvent('tengu_memory_stores_redact', {
    storeId: storeId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  });
  try {
    const version = await redactVersion(storeId, versionId);
    onDone(`Version ${versionId} redacted.`, { display: 'system' });
    return React.createElement(MemoryStoresView, { mode: 'redacted', version });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logEvent('tengu_memory_stores_failed', {
      reason: msg as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    onDone(`Failed to redact version ${versionId}: ${msg}`, { display: 'system' });
    return React.createElement(MemoryStoresView, { mode: 'error', message: msg });
  }
};
