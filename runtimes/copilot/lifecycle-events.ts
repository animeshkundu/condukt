/**
 * Classification for the GitHub Copilot SDK session event surface.
 *
 * Every received SDK event is liveness evidence and refreshes SdkBackend's
 * heartbeat before this classification is consulted. Classification remains
 * responsible only for event semantics and unknown-event diagnostics. Keep the
 * informational shim for SubprocessBackend's JSONL warning suppression.
 */

export type SdkEventClass =
  | 'terminal-success'
  | 'terminal-failure'
  | 'pending-request'
  | 'streaming-liveness'
  | 'informational';

const TERMINAL_SUCCESS = new Set(['session.idle', 'session.task_complete']);
const TERMINAL_FAILURE = new Set(['session.error', 'model.call_failure', 'abort']);
const PENDING_REQUEST = new Set([
  'sampling.requested',
  'auto_mode_switch.requested',
  'session_limits_exhausted.requested',
  'mcp.headers_refresh_required',
]);

const STREAMING_LIVENESS = new Set([
  'model.call_start',
  'assistant.reasoning', 'assistant.reasoning_delta',
  'assistant.message', 'assistant.message_start', 'assistant.message_delta',
  'assistant.server_tool_progress', 'assistant.streaming_delta', 'assistant.tool_call_delta',
  'assistant.turn_start', 'assistant.turn_retry', 'assistant.turn_end', 'assistant.intent',
  'assistant.idle', 'assistant.usage',
  'tool.user_requested', 'tool.execution_start',
  'tool.execution_partial_result', 'tool.execution_progress',
  'tool.execution_complete',
  'subagent.started', 'subagent.completed', 'subagent.failed',
  'session.compaction_start', 'session.compaction_complete',
]);

const INFORMATIONAL = new Set([
  'session.start', 'session.resume', 'session.shutdown',
  'session.info', 'session.warning', 'session.title_changed',
  'session.auto_mode_resolved', 'session.managed_settings_enforced',
  'session.managed_settings_resolved', 'session.memory_changed',
  'session.context_changed', 'session.context_cleared', 'session.usage_info', 'session.usage_checkpoint',
  'session.model_change', 'session.mode_changed', 'session.plan_changed',
  'session.fusion_route_started', 'session.fusion_route_failed', 'session.fusion_resolved',
  'session.fusion_handoff', 'session.fusion_commit_started', 'session.fusion_completed',
  'agent.interrupted', 'assistant.fusion_phase_started', 'assistant.fusion_phase_completed',
  'assistant.fusion_phase_failed', 'prompt_cache_break', 'model.call_finished',
  'sandbox.decision', 'subagent.configured', 'ui.ephemeral_query',
  'factory.run_started', 'factory.run_settled',
  'session.todos_changed', 'session.permissions_changed',
  'session.session_limits_changed', 'session.remote_steerable_changed',
  'session.schedule_created', 'session.schedule_cancelled', 'session.schedule_rearmed',
  'session.autopilot_objective_changed', 'session.truncation',
  'session.snapshot_rewind', 'session.workspace_file_changed', 'session.handoff',
  'session.background_tasks_changed', 'factory.run_updated', 'session.skills_loaded',
  'session.custom_agents_updated', 'session.extensions_loaded',
  'session.mcp_server_status_changed', 'session.mcp_servers_loaded',
  'mcp.tools.list_changed', 'mcp.resources.list_changed', 'mcp.prompts.list_changed',
  'session.tools_updated', 'tool_search.activated',
  'session.binary_asset', 'session.custom_notification',
  'session.extensions.attachments_pushed',
  'user.message', 'pending_messages.modified', 'system.message',
  'system.notification', 'skill.invoked',
  'subagent.selected', 'subagent.deselected',
  'permission.requested', 'permission.completed',
  'user_input.requested', 'user_input.completed',
  'elicitation.requested', 'elicitation.completed',
  'external_tool.requested', 'external_tool.completed',
  'command.queued', 'command.execute', 'command.completed', 'commands.changed',
  'exit_plan_mode.requested', 'exit_plan_mode.completed',
  'mcp.oauth_required', 'mcp.oauth_completed',
  'mcp.headers_refresh_completed', 'sampling.completed',
  'auto_mode_switch.completed', 'session_limits_exhausted.completed',
  'capabilities.changed',
  'hook.start', 'hook.progress', 'hook.end',
  'session.canvas.opened', 'session.canvas.registry_changed',
  'session.canvas.closed', 'session.canvas.unavailable',
  'session.canvas.recorded', 'session.canvas.removed',
  'mcp_app.tool_call_complete',
]);

export const KNOWN_SDK_EVENT_TYPES = new Set([
  ...TERMINAL_SUCCESS,
  ...TERMINAL_FAILURE,
  ...PENDING_REQUEST,
  ...STREAMING_LIVENESS,
  ...INFORMATIONAL,
]);

export function classifySdkEvent(type: string): SdkEventClass | undefined {
  if (TERMINAL_SUCCESS.has(type)) return 'terminal-success';
  if (TERMINAL_FAILURE.has(type)) return 'terminal-failure';
  if (PENDING_REQUEST.has(type)) return 'pending-request';
  if (STREAMING_LIVENESS.has(type)) return 'streaming-liveness';
  if (INFORMATIONAL.has(type)) return 'informational';
  return undefined;
}

/** Legacy shim used by SubprocessBackend's separate JSONL vocabulary. */
export const LIFECYCLE_EVENT_TYPES = INFORMATIONAL;
