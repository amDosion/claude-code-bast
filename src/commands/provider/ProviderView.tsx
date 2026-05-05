import React from 'react';
import { Box, Text } from '@anthropic/ink';
import type { Theme } from '@anthropic/ink';
import type { ProviderConfig } from '../../services/providerRegistry/types.js';

type Props =
  | { mode: 'list'; providers: ProviderConfig[]; activeId: string | null }
  | { mode: 'show'; provider: ProviderConfig | null; activeId: string | null }
  | { mode: 'used'; provider: ProviderConfig; shellBlock: string; warnings: string[] }
  | { mode: 'added'; provider: ProviderConfig }
  | { mode: 'error'; message: string };

function hasApiKey(provider: ProviderConfig): boolean {
  return Boolean(process.env[provider.apiKeyEnv]);
}

function ProviderRow({ provider, isActive }: { provider: ProviderConfig; isActive: boolean }): React.ReactNode {
  const keySet = hasApiKey(provider);
  const activeLabel = isActive ? ' [active]' : '';
  const keyLabel = keySet ? 'key set' : 'no key';
  return (
    <Box>
      <Text bold={isActive}>{isActive ? '> ' : '  '}</Text>
      <Text bold={isActive} color={(isActive ? 'success' : undefined) as keyof Theme | undefined}>
        {provider.id}
      </Text>
      <Text dimColor>{activeLabel} </Text>
      <Text dimColor>({provider.defaultModel}) </Text>
      <Text color={(keySet ? 'success' : 'warning') as keyof Theme}>[{keyLabel}]</Text>
    </Box>
  );
}

export function ProviderView(props: Props): React.ReactNode {
  if (props.mode === 'list') {
    const { providers, activeId } = props;
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold>OpenAI-compat Providers ({providers.length})</Text>
        </Box>
        {providers.map(p => (
          <ProviderRow key={p.id} provider={p} isActive={p.id === activeId} />
        ))}
        <Box marginTop={1}>
          <Text dimColor>Use /providers use &lt;id&gt; to switch providers (restart required)</Text>
        </Box>
      </Box>
    );
  }

  if (props.mode === 'show') {
    const { provider, activeId } = props;
    if (!provider) {
      return (
        <Box>
          <Text dimColor>No active OpenAI-compat provider. Use /providers use &lt;id&gt; to activate one.</Text>
        </Box>
      );
    }
    const keySet = hasApiKey(provider);
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold>Active Provider: </Text>
          <Text color={'success' as keyof Theme}>{provider.id}</Text>
          {activeId === null && <Text dimColor> (env-configured)</Text>}
        </Box>
        <Text>Base URL: {provider.baseUrl}</Text>
        <Text>Default model: {provider.defaultModel}</Text>
        <Text>Compat rule: {provider.compatRule}</Text>
        <Text>API key env: {provider.apiKeyEnv}</Text>
        <Text>
          API key: <Text color={(keySet ? 'success' : 'warning') as keyof Theme}>{keySet ? 'set' : 'not set'}</Text>
        </Text>
      </Box>
    );
  }

  if (props.mode === 'used') {
    const { provider, shellBlock, warnings } = props;
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold>Switch to provider: </Text>
          <Text color={'success' as keyof Theme}>{provider.id}</Text>
        </Box>
        <Text dimColor>Add these lines to your shell profile (~/.bashrc, ~/.zshrc):</Text>
        <Box marginTop={1} marginBottom={1} flexDirection="column">
          {shellBlock.split('\n').map((line, i) => (
            <Text key={i} color={'info' as keyof Theme}>
              {line}
            </Text>
          ))}
        </Box>
        <Text dimColor>Then restart Claude Code for the change to take effect.</Text>
        {warnings.length > 0 && (
          <Box marginTop={1} flexDirection="column">
            {warnings.map((w, i) => (
              <Text key={i} color={'warning' as keyof Theme}>
                Warning: {w}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    );
  }

  if (props.mode === 'added') {
    const { provider } = props;
    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>Provider added: </Text>
          <Text color={'success' as keyof Theme}>{provider.id}</Text>
        </Box>
        <Text dimColor>Use /providers use {provider.id} to activate it (restart required).</Text>
      </Box>
    );
  }

  // error
  return (
    <Box>
      <Text color={'error' as keyof Theme}>Error: {props.message}</Text>
    </Box>
  );
}
