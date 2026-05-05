import React from 'react';
import type { LocalJSXCommandCall } from '../../types/command.js';
import { setSecret, getSecret, deleteSecret, listKeys, maskSecret } from '../../services/localVault/store.js';
import { LocalVaultView } from './LocalVaultView.js';
import { parseLocalVaultArgs } from './parseArgs.js';

const USAGE = 'Usage: /local-vault list | set <key> <value> | get <key> [--reveal] | delete <key>';

export const callLocalVault: LocalJSXCommandCall = async (onDone, _context, args) => {
  const parsed = parseLocalVaultArgs(args ?? '');

  // ── invalid args ──────────────────────────────────────────────────────────
  if (parsed.action === 'invalid') {
    onDone(`${USAGE}\n${parsed.reason}`, { display: 'system' });
    return null;
  }

  // ── list ──────────────────────────────────────────────────────────────────
  if (parsed.action === 'list') {
    try {
      const keys = await listKeys();
      onDone(keys.length === 0 ? 'No secrets stored.' : `${keys.length} secret(s) stored.`, { display: 'system' });
      return React.createElement(LocalVaultView, { mode: 'list', keys });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onDone(`Failed to list secrets: ${msg}`, { display: 'system' });
      return React.createElement(LocalVaultView, { mode: 'error', message: msg });
    }
  }

  // ── set ───────────────────────────────────────────────────────────────────
  if (parsed.action === 'set') {
    const { key, value } = parsed;
    try {
      await setSecret(key, value);
      // Never echo the value in onDone — security invariant
      onDone(`Secret stored: ${key} = [REDACTED]`, { display: 'system' });
      return React.createElement(LocalVaultView, { mode: 'set-ok', key });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onDone(`Failed to store secret: ${msg}`, { display: 'system' });
      return React.createElement(LocalVaultView, { mode: 'error', message: msg });
    }
  }

  // ── get ───────────────────────────────────────────────────────────────────
  if (parsed.action === 'get') {
    const { key, reveal } = parsed;
    try {
      const value = await getSecret(key);
      if (value === null) {
        onDone(`Key not found: ${key}`, { display: 'system' });
        return React.createElement(LocalVaultView, { mode: 'not-found', key });
      }

      if (reveal) {
        // Security invariant: only --reveal shows plaintext; warn user
        onDone(`Secret revealed for: ${key}`, { display: 'system' });
        return React.createElement(LocalVaultView, { mode: 'get-revealed', key, value });
      }

      // Default: mask display
      const masked = maskSecret(value);
      onDone(`Key found: ${key} = ${masked}`, { display: 'system' });
      return React.createElement(LocalVaultView, { mode: 'get-masked', key, masked });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onDone(`Failed to get secret: ${msg}`, { display: 'system' });
      return React.createElement(LocalVaultView, { mode: 'error', message: msg });
    }
  }

  // ── delete ────────────────────────────────────────────────────────────────
  if (parsed.action === 'delete') {
    const { key } = parsed;
    try {
      const deleted = await deleteSecret(key);
      if (!deleted) {
        onDone(`Key not found: ${key}`, { display: 'system' });
        return React.createElement(LocalVaultView, { mode: 'not-found', key });
      }
      onDone(`Deleted: ${key}`, { display: 'system' });
      return React.createElement(LocalVaultView, { mode: 'deleted', key });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onDone(`Failed to delete secret: ${msg}`, { display: 'system' });
      return React.createElement(LocalVaultView, { mode: 'error', message: msg });
    }
  }

  // Exhaustive guard
  onDone(USAGE, { display: 'system' });
  return null;
};
