import React from 'react';
import type { LocalJSXCommandCall } from '../../types/command.js';
import { loadProviders, loadProvidersWithDiagnostic } from '../../services/providerRegistry/loader.js';
import { switchProvider, buildShellExportBlock } from '../../services/providerRegistry/switcher.js';
import { ProviderView } from './ProviderView.js';
import { parseProviderArgs } from './parseArgs.js';
import type { ProviderConfig } from '../../services/providerRegistry/types.js';

const USAGE = 'Usage: /providers [list | show | use <id> | add]';

/**
 * Detect the currently active OpenAI-compat provider from env vars.
 *
 * Returns the provider id if CLAUDE_CODE_USE_OPENAI=1 and OPENAI_BASE_URL
 * matches a known provider's baseUrl. Returns null if not in OpenAI-compat mode.
 */
function detectActiveProvider(providers: ProviderConfig[]): string | null {
  if (process.env['CLAUDE_CODE_USE_OPENAI'] !== '1') return null;
  const baseUrl = process.env['OPENAI_BASE_URL'];
  if (!baseUrl) return null;
  const found = providers.find(p => p.baseUrl === baseUrl);
  return found?.id ?? null;
}

export const callProviders: LocalJSXCommandCall = async (onDone, _context, args) => {
  const parsed = parseProviderArgs(args ?? '');

  // ── invalid args ─────────────────────────────────────────────────────────
  if (parsed.action === 'invalid') {
    onDone(`${parsed.reason}`, { display: 'system' });
    return null;
  }

  // ── list ──────────────────────────────────────────────────────────────────
  if (parsed.action === 'list') {
    // A1 fix: use diagnostic loader so config errors surface in the view
    const { providers, error: configError } = loadProvidersWithDiagnostic();
    const activeId = detectActiveProvider(providers);
    if (configError) {
      // Surface the config error to the user in the system channel
      onDone(`Warning: ${configError}`, { display: 'system' });
      return React.createElement(ProviderView, { mode: 'error', message: configError });
    }
    onDone(`${providers.length} provider(s) registered. Active: ${activeId ?? 'none (Anthropic direct)'}`, {
      display: 'system',
    });
    return React.createElement(ProviderView, { mode: 'list', providers, activeId });
  }

  // ── show ──────────────────────────────────────────────────────────────────
  if (parsed.action === 'show') {
    const providers = loadProviders();
    const activeId = detectActiveProvider(providers);
    const activeProvider = activeId ? (providers.find(p => p.id === activeId) ?? null) : null;

    if (!activeProvider) {
      onDone('No active OpenAI-compat provider.', { display: 'system' });
    } else {
      onDone(`Active provider: ${activeProvider.id}`, { display: 'system' });
    }
    return React.createElement(ProviderView, {
      mode: 'show',
      provider: activeProvider,
      activeId,
    });
  }

  // ── use <id> ──────────────────────────────────────────────────────────────
  if (parsed.action === 'use') {
    const { id } = parsed;
    const providers = loadProviders();

    let result: Awaited<ReturnType<typeof switchProvider>>;
    try {
      result = switchProvider(id, providers);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onDone(`Failed to switch provider: ${msg}`, { display: 'system' });
      return React.createElement(ProviderView, { mode: 'error', message: msg });
    }

    const shellBlock = buildShellExportBlock(result);
    onDone(`To use ${id}: add the shell exports to your profile and restart Claude Code.`, { display: 'system' });
    return React.createElement(ProviderView, {
      mode: 'used',
      provider: result.provider,
      shellBlock,
      warnings: result.warnings,
    });
  }

  // ── add ───────────────────────────────────────────────────────────────────
  if (parsed.action === 'add') {
    // Interactive add is not supported via local-jsx call (no mid-call prompt).
    // Guide the user to edit providers.json directly.
    const configPath = `~/.claude/providers.json`;
    const example = JSON.stringify(
      [
        {
          id: 'my-provider',
          kind: 'openai-compat',
          baseUrl: 'https://my.api.com/v1',
          apiKeyEnv: 'MY_API_KEY',
          defaultModel: 'my-model',
          compatRule: 'permissive',
        },
      ],
      null,
      2,
    );
    const msg =
      `To add a custom provider, edit ${configPath} and add an entry:\n\n${example}\n\n` +
      `Valid compatRule values: cerebras, groq, deepseek, strict-openai, permissive\n` +
      `Then run /providers list to confirm it was loaded.`;
    onDone(msg, { display: 'system' });
    return null;
  }

  // unreachable
  onDone(USAGE, { display: 'system' });
  return null;
};
