import React from 'react';
import type { LocalJSXCommandCall } from '../../types/command.js';
import { setSecret, getSecret, deleteSecret, listKeys, maskSecret } from '../../services/localVault/store.js';
import { LocalVaultView } from './LocalVaultView.js';
import { parseLocalVaultArgs } from './parseArgs.js';
import { launchCommand } from '../_shared/launchCommand.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';

const USAGE = 'Usage: /local-vault list | set <key> <value> | get <key> [--reveal] | delete <key>';

type LocalVaultViewProps = React.ComponentProps<typeof LocalVaultView>;

async function dispatchLocalVault(
  parsed: ReturnType<typeof parseLocalVaultArgs>,
  onDone: LocalJSXCommandOnDone,
): Promise<LocalVaultViewProps | null> {
  if (parsed.action === 'list') {
    const keys = await listKeys();
    onDone(keys.length === 0 ? 'No secrets stored.' : `${keys.length} secret(s) stored.`, { display: 'system' });
    return { mode: 'list', keys };
  }

  if (parsed.action === 'set') {
    const { key, value } = parsed;
    await setSecret(key, value);
    // Never echo the value in onDone — security invariant
    onDone(`Secret stored: ${key} = [REDACTED]`, { display: 'system' });
    return { mode: 'set-ok', key };
  }

  if (parsed.action === 'get') {
    const { key, reveal } = parsed;
    const value = await getSecret(key);
    if (value === null) {
      onDone(`Key not found: ${key}`, { display: 'system' });
      return { mode: 'not-found', key };
    }
    if (reveal) {
      // Security invariant: only --reveal shows plaintext; warn user
      onDone(`Secret revealed for: ${key}`, { display: 'system' });
      return { mode: 'get-revealed', key, value };
    }
    // Default: mask display
    const masked = maskSecret(value);
    onDone(`Key found: ${key} = ${masked}`, { display: 'system' });
    return { mode: 'get-masked', key, masked };
  }

  if (parsed.action === 'delete') {
    const { key } = parsed;
    const deleted = await deleteSecret(key);
    if (!deleted) {
      onDone(`Key not found: ${key}`, { display: 'system' });
      return { mode: 'not-found', key };
    }
    onDone(`Deleted: ${key}`, { display: 'system' });
    return { mode: 'deleted', key };
  }

  // Exhaustive guard — should not be reached for valid parsed actions
  onDone(USAGE, { display: 'system' });
  return null;
}

export const callLocalVault: LocalJSXCommandCall = launchCommand<
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
