/**
 * AuthPlaneSummary — pure presentational Ink component.
 *
 * Renders the three auth plane status table shown when the user runs /login
 * without arguments:
 *
 *   Anthropic auth status:
 *     ☑ Subscription (claude.ai)         pro plan
 *     ☐ Workspace API key                not set
 *          To enable /vault /agents-platform /memory-stores:
 *          1. Open https://console.anthropic.com/settings/keys
 *          ...
 *
 *   Third-party providers:
 *     ✓ Cerebras   (CEREBRAS_API_KEY set)
 *     ☐ Groq       (GROQ_API_KEY not set)
 *     ...
 *
 * Security: never renders raw API key values. All output uses masked previews.
 */
import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import type { AuthStatus } from './getAuthStatus.js';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SubscriptionRow({ subscription }: { subscription: AuthStatus['subscription'] }): React.ReactNode {
  const icon = subscription.active ? '☑' : '☐';
  const planLabel = subscription.active && subscription.plan ? ` ${subscription.plan} plan` : '';
  const statusText = subscription.active ? `logged in${planLabel}` : 'not logged in';

  return (
    <Box>
      <Text color={subscription.active ? 'success' : undefined}>
        {icon} Subscription (claude.ai){'  '}
      </Text>
      <Text dimColor={!subscription.active}>{statusText}</Text>
    </Box>
  );
}

function WorkspaceKeyRow({ workspaceKey }: { workspaceKey: AuthStatus['workspaceKey'] }): React.ReactNode {
  if (!workspaceKey.set) {
    return (
      <Box>
        <Text>{'☐ Workspace API key                '}</Text>
        <Text dimColor>not set</Text>
      </Box>
    );
  }

  if (!workspaceKey.prefixValid) {
    return (
      <Box>
        <Text color="warning">{'⚠ Workspace API key                '}</Text>
        <Text>{workspaceKey.keyPreview}</Text>
        <Text color="warning">{'  (sk-ant-api03-* required)'}</Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text color="success">{'☑ Workspace API key                '}</Text>
      <Text>{workspaceKey.keyPreview}</Text>
    </Box>
  );
}

function WorkspaceKeyInstructions({
  subscription,
  workspaceKey,
}: {
  subscription: AuthStatus['subscription'];
  workspaceKey: AuthStatus['workspaceKey'];
}): React.ReactNode {
  // Show setup guide when workspace key is missing and subscription is active (user is logged in)
  if (!workspaceKey.set && subscription.active) {
    return (
      <Box flexDirection="column" marginLeft={5} marginTop={0}>
        <Text dimColor>To enable /vault /agents-platform /memory-stores:</Text>
        <Text dimColor>{'1. Open https://console.anthropic.com/settings/keys'}</Text>
        <Text dimColor>{'2. Create a key (sk-ant-api03-*)'}</Text>
        <Text dimColor>{'3. Set ANTHROPIC_API_KEY=<paste>'}</Text>
        <Text dimColor>{'4. Restart Claude Code'}</Text>
      </Box>
    );
  }
  return null;
}

function ThirdPartyRow({ provider }: { provider: AuthStatus['thirdParty'][number] }): React.ReactNode {
  const icon = provider.apiKeySet ? '✓' : '☐';
  const keyLabel = provider.apiKeySet ? `(${provider.apiKeyEnv} set)` : `(${provider.apiKeyEnv} not set)`;
  const activeLabel = provider.isActive ? '  (active)' : '';

  return (
    <Box>
      <Text color={provider.apiKeySet ? 'success' : undefined}>
        {icon} {provider.name.padEnd(10)}
      </Text>
      <Text dimColor={!provider.apiKeySet}>{keyLabel}</Text>
      {provider.isActive && <Text color="ansi:cyan">{activeLabel}</Text>}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

export interface AuthPlaneSummaryProps {
  status: AuthStatus;
}

export function AuthPlaneSummary({ status }: AuthPlaneSummaryProps): React.ReactNode {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Section: Anthropic auth status */}
      <Box marginBottom={0}>
        <Text bold>Anthropic auth status:</Text>
      </Box>

      <Box marginLeft={2} flexDirection="column">
        <SubscriptionRow subscription={status.subscription} />
        <WorkspaceKeyRow workspaceKey={status.workspaceKey} />
        <WorkspaceKeyInstructions subscription={status.subscription} workspaceKey={status.workspaceKey} />
      </Box>

      {/* Section: Third-party providers */}
      <Box marginTop={1} marginBottom={0}>
        <Text bold>Third-party providers:</Text>
      </Box>

      <Box marginLeft={2} flexDirection="column">
        {status.thirdParty.map(p => (
          <ThirdPartyRow key={p.id} provider={p} />
        ))}
      </Box>
    </Box>
  );
}
