import React from 'react';
import type { LocalJSXCommandCall } from '../../types/command.js';
import {
  addCredential,
  archiveCredential,
  archiveVault,
  createVault,
  getVault,
  listCredentials,
  listVaults,
} from './vaultsApi.js';
import { VaultView } from './VaultView.js';
import { parseVaultArgs } from './parseArgs.js';

const USAGE =
  'Usage: /vault list | create <name> | get <id> | archive <id> | add-credential <vault_id> <key> <value> | archive-credential <vault_id> <cred_id>';

export const callVault: LocalJSXCommandCall = async (onDone, _context, args) => {
  const parsed = parseVaultArgs(args ?? '');

  // ── invalid args ──────────────────────────────────────────────────────────
  if (parsed.action === 'invalid') {
    onDone(`${USAGE}\n${parsed.reason}`, { display: 'system' });
    return null;
  }

  // ── list vaults ───────────────────────────────────────────────────────────
  if (parsed.action === 'list') {
    try {
      const vaults = await listVaults();
      onDone(vaults.length === 0 ? 'No vaults found.' : `${vaults.length} vault(s).`, { display: 'system' });
      return React.createElement(VaultView, { mode: 'list', vaults });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onDone(`Failed to list vaults: ${msg}`, { display: 'system' });
      return React.createElement(VaultView, { mode: 'error', message: msg });
    }
  }

  // ── create vault ──────────────────────────────────────────────────────────
  if (parsed.action === 'create') {
    const { name } = parsed;
    try {
      const vault = await createVault(name);
      onDone(`Vault created: ${vault.vault_id}`, { display: 'system' });
      return React.createElement(VaultView, { mode: 'created', vault });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onDone(`Failed to create vault: ${msg}`, { display: 'system' });
      return React.createElement(VaultView, { mode: 'error', message: msg });
    }
  }

  // ── get vault ─────────────────────────────────────────────────────────────
  if (parsed.action === 'get') {
    const { id } = parsed;
    try {
      const vault = await getVault(id);
      onDone(`Vault fetched.`, { display: 'system' });
      return React.createElement(VaultView, { mode: 'detail', vault });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onDone(`Failed to get vault: ${msg}`, { display: 'system' });
      return React.createElement(VaultView, { mode: 'error', message: msg });
    }
  }

  // ── archive vault ─────────────────────────────────────────────────────────
  if (parsed.action === 'archive') {
    const { id } = parsed;
    try {
      const vault = await archiveVault(id);
      onDone(`Vault archived.`, { display: 'system' });
      return React.createElement(VaultView, { mode: 'archived', vault });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onDone(`Failed to archive vault: ${msg}`, { display: 'system' });
      return React.createElement(VaultView, { mode: 'error', message: msg });
    }
  }

  // ── add credential ────────────────────────────────────────────────────────
  if (parsed.action === 'add-credential') {
    const { vaultId, key, secret } = parsed;
    try {
      const cred = await addCredential(vaultId, key, secret);
      // SECURITY: credential value is NOT echoed in onDone message
      onDone(`Credential added: ${cred.credential_id}`, { display: 'system' });
      return React.createElement(VaultView, {
        mode: 'credential-added',
        vaultId,
        credentialId: cred.credential_id,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // SECURITY: key name (not value) is OK to include
      onDone(`Failed to add credential ${key}: ${msg}`, { display: 'system' });
      return React.createElement(VaultView, { mode: 'error', message: msg });
    }
  }

  // ── archive credential ────────────────────────────────────────────────────
  if (parsed.action === 'archive-credential') {
    const { vaultId, credentialId } = parsed;
    try {
      await archiveCredential(vaultId, credentialId);
      onDone(`Credential ${credentialId} archived.`, { display: 'system' });
      return React.createElement(VaultView, {
        mode: 'credential-archived',
        vaultId,
        credentialId,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onDone(`Failed to archive credential: ${msg}`, { display: 'system' });
      return React.createElement(VaultView, { mode: 'error', message: msg });
    }
  }

  // ── list credentials (via list action on vault with credentials subpath) ──
  // This case handles when user provides a vault id to list credentials
  // Reached if we somehow didn't match above — guard against unreachable
  try {
    const vaults = await listVaults();
    onDone(vaults.length === 0 ? 'No vaults found.' : `${vaults.length} vault(s).`, { display: 'system' });
    return React.createElement(VaultView, { mode: 'list', vaults });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    onDone(`Failed to list vaults: ${msg}`, { display: 'system' });
    return React.createElement(VaultView, { mode: 'error', message: msg });
  }
};

export const callVaultListCredentials = async (
  onDone: (msg: string, opts: { display: string }) => void,
  vaultId: string,
): Promise<React.ReactNode> => {
  try {
    const credentials = await listCredentials(vaultId);
    onDone(
      credentials.length === 0
        ? `No credentials in vault ${vaultId}.`
        : `${credentials.length} credential(s) in vault ${vaultId}.`,
      { display: 'system' },
    );
    return React.createElement(VaultView, {
      mode: 'credential-list',
      vaultId,
      credentials,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    onDone(`Failed to list credentials: ${msg}`, { display: 'system' });
    return React.createElement(VaultView, { mode: 'error', message: msg });
  }
};
