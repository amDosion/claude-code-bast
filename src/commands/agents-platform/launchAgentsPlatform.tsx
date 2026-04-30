import React from 'react';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js';
import { parseCronExpression } from '../../utils/cron.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
import { createAgent, deleteAgent, listAgents, runAgent } from './agentsApi.js';
import { AgentsPlatformView } from './AgentsPlatformView.js';
import { parseAgentsPlatformArgs } from './parseArgs.js';

export const callAgentsPlatform: LocalJSXCommandCall = async (onDone, _context, args) => {
  logEvent('tengu_agents_platform_started', {
    args: (args ?? '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  });

  const parsed = parseAgentsPlatformArgs(args ?? '');

  // ── invalid args ────────────────────────────────────────────────────────────
  if (parsed.action === 'invalid') {
    logEvent('tengu_agents_platform_failed', {
      reason: parsed.reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    onDone(`Usage: /agents-platform list | create <cron> <prompt> | delete <id> | run <id>\n${parsed.reason}`, {
      display: 'system',
    });
    return null;
  }

  // ── list ────────────────────────────────────────────────────────────────────
  if (parsed.action === 'list') {
    logEvent('tengu_agents_platform_list', {});
    try {
      const agents = await listAgents();
      onDone(agents.length === 0 ? 'No scheduled agents found.' : `${agents.length} scheduled agent(s).`, {
        display: 'system',
      });
      return React.createElement(AgentsPlatformView, { mode: 'list', agents });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent('tengu_agents_platform_failed', {
        reason: msg as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      onDone(`Failed to list agents: ${msg}`, { display: 'system' });
      return React.createElement(AgentsPlatformView, {
        mode: 'error',
        message: msg,
      });
    }
  }

  // ── create ──────────────────────────────────────────────────────────────────
  if (parsed.action === 'create') {
    const { cron, prompt } = parsed;

    // Validate cron expression client-side before hitting the network
    const cronFields = parseCronExpression(cron);
    if (!cronFields) {
      const reason = `Invalid cron expression: "${cron}". Expected 5 fields (minute hour day month weekday).`;
      logEvent('tengu_agents_platform_failed', {
        reason: reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      onDone(reason, { display: 'system' });
      return null;
    }

    logEvent('tengu_agents_platform_create', {
      cron: cron as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    try {
      const agent = await createAgent(cron, prompt);
      onDone(`Agent created: ${agent.id}`, { display: 'system' });
      return React.createElement(AgentsPlatformView, {
        mode: 'created',
        agent,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent('tengu_agents_platform_failed', {
        reason: msg as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      onDone(`Failed to create agent: ${msg}`, { display: 'system' });
      return React.createElement(AgentsPlatformView, {
        mode: 'error',
        message: msg,
      });
    }
  }

  // ── delete ──────────────────────────────────────────────────────────────────
  if (parsed.action === 'delete') {
    const { id } = parsed;
    logEvent('tengu_agents_platform_delete', {
      id: id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    try {
      await deleteAgent(id);
      onDone(`Agent ${id} deleted.`, { display: 'system' });
      return React.createElement(AgentsPlatformView, { mode: 'deleted', id });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent('tengu_agents_platform_failed', {
        reason: msg as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      onDone(`Failed to delete agent ${id}: ${msg}`, { display: 'system' });
      return React.createElement(AgentsPlatformView, {
        mode: 'error',
        message: msg,
      });
    }
  }

  // ── run ─────────────────────────────────────────────────────────────────────
  const { id } = parsed;
  logEvent('tengu_agents_platform_run', {
    id: id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  });
  try {
    const result = await runAgent(id);
    onDone(`Agent ${id} triggered. Run ID: ${result.run_id}`, {
      display: 'system',
    });
    return React.createElement(AgentsPlatformView, {
      mode: 'ran',
      id,
      runId: result.run_id,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logEvent('tengu_agents_platform_failed', {
      reason: msg as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    onDone(`Failed to run agent ${id}: ${msg}`, { display: 'system' });
    return React.createElement(AgentsPlatformView, {
      mode: 'error',
      message: msg,
    });
  }
};
