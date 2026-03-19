/**
 * Shared lifecycle event types — events from the copilot CLI that carry
 * no actionable content and should be silently consumed by all backends.
 *
 * Both SdkBackend and SubprocessBackend import from this module to avoid
 * duplicating the list.
 */

export const LIFECYCLE_EVENT_TYPES = new Set([
  // Session lifecycle
  'session.start', 'session.resume', 'session.shutdown',
  'session.info', 'session.warning', 'session.title_changed',
  'session.context_changed', 'session.usage_info', 'session.model_change',
  'session.compaction_start', 'session.compaction_complete',
  'session.mode_changed', 'session.plan_changed',
  'session.truncation', 'session.snapshot_rewind',
  'session.workspace_file_changed', 'session.handoff',
  'session.background_tasks_changed',

  // Turn lifecycle
  'user.message', 'assistant.turn_start', 'assistant.turn_end',
  'assistant.streaming_delta',  // ephemeral progress (totalResponseSizeBytes)

  // Messaging / system
  'pending_messages.modified', 'system.message', 'abort', 'result',

  // Skill / subagent selection
  'skill.invoked',
  'subagent.selected', 'subagent.deselected',

  // User input / elicitation
  'user_input.requested', 'user_input.completed',
  'elicitation.requested', 'elicitation.completed',

  // External tool coordination
  'external_tool.requested', 'external_tool.completed',

  // Command queue
  'command.queued', 'command.completed',

  // Plan mode
  'exit_plan_mode.requested', 'exit_plan_mode.completed',

  // Tool UI
  'tool.user_requested', 'tool.execution_progress',

  // Permission (completion is silent; request is handled separately)
  'permission.completed',
]);
