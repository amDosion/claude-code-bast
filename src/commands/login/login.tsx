import { feature } from 'bun:bundle';
import * as React from 'react';
import { resetCostState } from '../../bootstrap/state.js';
import { clearTrustedDeviceToken, enrollTrustedDevice } from '../../bridge/trustedDevice.js';
import type { LocalJSXCommandContext } from '../../commands.js';
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js';
import { ConsoleOAuthFlow } from '../../components/ConsoleOAuthFlow.js';
import { Box, Dialog } from '@anthropic/ink';
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js';
import { Text } from '@anthropic/ink';
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js';
import { refreshPolicyLimits } from '../../services/policyLimits/index.js';
import { refreshRemoteManagedSettings } from '../../services/remoteManagedSettings/index.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { stripSignatureBlocks } from '../../utils/messages.js';
import {
  checkAndDisableAutoModeIfNeeded,
  resetAutoModeGateCheck,
} from '../../utils/permissions/bypassPermissionsKillswitch.js';
import { resetUserCache } from '../../utils/user.js';
import { AuthPlaneSummary } from './AuthPlaneSummary.js';
import { getAuthStatus } from './getAuthStatus.js';

export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext): Promise<React.ReactNode> {
  // Snapshot auth state once at call time (pure, no network)
  const authStatus = getAuthStatus();

  return (
    <Login
      authStatus={authStatus}
      onDone={async success => {
        context.onChangeAPIKey();
        // Signature-bearing blocks (thinking, connector_text) are bound to the API key —
        // strip them so the new key doesn't reject stale signatures.
        context.setMessages(stripSignatureBlocks);
        if (success) {
          // Post-login refresh logic. Keep in sync with onboarding in src/interactiveHelpers.tsx
          // Reset cost state when switching accounts
          resetCostState();
          // Refresh remotely managed settings after login (non-blocking)
          void refreshRemoteManagedSettings();
          // Refresh policy limits after login (non-blocking)
          void refreshPolicyLimits();
          // Clear user data cache BEFORE GrowthBook refresh so it picks up fresh credentials
          resetUserCache();
          // Refresh GrowthBook after login to get updated feature flags (e.g., for claude.ai MCPs)
          refreshGrowthBookAfterAuthChange();
          // Clear any stale trusted device token from a previous account before
          // re-enrolling — prevents sending the old token on bridge calls while
          // the async enrollTrustedDevice() is in-flight.
          clearTrustedDeviceToken();
          // Enroll as a trusted device for Remote Control (10-min fresh-session window)
          void enrollTrustedDevice();
          // Reset killswitch gate checks and re-run with new org
          resetAutoModeGateCheck();
          const appState = context.getAppState();
          void checkAndDisableAutoModeIfNeeded(appState.toolPermissionContext, context.setAppState, appState.fastMode);
          // Increment authVersion to trigger re-fetching of auth-dependent data in hooks (e.g., MCP servers)
          context.setAppState(prev => ({
            ...prev,
            authVersion: prev.authVersion + 1,
          }));
        }
        onDone(success ? 'Login successful' : 'Login interrupted');
      }}
    />
  );
}

export function Login(props: {
  onDone: (success: boolean, mainLoopModel: string) => void;
  startingMessage?: string;
  /** Pre-computed auth status snapshot — passed from call() to avoid re-computing */
  authStatus?: import('./getAuthStatus.js').AuthStatus;
}): React.ReactNode {
  const mainLoopModel = useMainLoopModel();

  return (
    <Dialog
      title="Login"
      onCancel={() => props.onDone(false, mainLoopModel)}
      color="permission"
      inputGuide={exitState =>
        exitState.pending ? (
          <Text>Press {exitState.keyName} again to exit</Text>
        ) : (
          <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" />
        )
      }
    >
      <Box flexDirection="column">
        {props.authStatus !== undefined && (
          <Box marginBottom={1}>
            <AuthPlaneSummary status={props.authStatus} />
          </Box>
        )}
        <ConsoleOAuthFlow onDone={() => props.onDone(true, mainLoopModel)} startingMessage={props.startingMessage} />
      </Box>
    </Dialog>
  );
}
