import * as React from 'react';
import { Settings } from '../../components/Settings/Settings.js';
import { Stats } from '../../components/Stats.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
import { isClaudeAISubscriber } from '../../utils/auth.js';

/**
 * /usage — unified command replacing /cost and /stats (v2.1.118 upstream alignment).
 *
 * Routing:
 *   - claude.ai subscriber → Settings panel → Usage tab (plan limits + overages)
 *   - API / non-subscriber  → Stats panel (session cost, token counts, activity)
 *
 * Both /cost and /stats are registered as aliases of this command so that
 * existing muscle-memory still works.
 */
export const call: LocalJSXCommandCall = async (onDone, context) => {
  if (isClaudeAISubscriber()) {
    return <Settings onClose={onDone} context={context} defaultTab="Usage" />;
  }
  return <Stats onClose={onDone} />;
};
