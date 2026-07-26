export type SubagentRosterValue = 'inherit' | (string & {});

export interface SubagentRosterEntry {
  readonly model?: SubagentRosterValue;
  readonly effortLevel?: SubagentRosterValue;
  readonly contextTier?: 'inherit' | 'default' | 'long_context';
}

export type SubagentRoster = Readonly<Record<string, SubagentRosterEntry>>;

/**
 * `model` accepts a specific model id or one of the CLI's strategies: `inherit`
 * (match the session model), `complementary` (resolve a model from a different
 * family than the session model, at dispatch time), or `default`.
 */
export const DEFAULT_SUBAGENT_ROSTER: SubagentRoster = {
  // Planning should use the parent's chosen model and context, with deliberate reasoning.
  plan: { model: 'inherit', effortLevel: 'high', contextTier: 'inherit' },
  // Exploration benefits from low latency and a long context for broad repository reads.
  explore: { model: 'gemini-3.6-flash', effortLevel: 'high', contextTier: 'long_context' },
  // General work needs a balanced model with enough reasoning for varied implementation tasks.
  'general-purpose': { model: 'gpt-5.6-terra', effortLevel: 'high', contextTier: 'default' },
  // Bounded delegated tasks favor the same balanced model without paying for maximum context.
  task: { model: 'gpt-5.6-terra', effortLevel: 'medium', contextTier: 'default' },
  // Review is worth little when it shares the author's blind spots, so both review agents
  // ask the CLI for a different family than the session model rather than naming one. A
  // named model would silently become same-family whenever the session model changes.
  'code-review': { model: 'complementary', effortLevel: 'high', contextTier: 'long_context' },
  'security-review': { model: 'complementary', effortLevel: 'high', contextTier: 'long_context' },
  // Research is judged on synthesis quality rather than independence, so it names a model.
  research: { model: 'gemini-3.1-pro-preview', effortLevel: 'high', contextTier: 'long_context' },
};

export type SubagentRosterOption = SubagentRoster | false;

export function mergeSubagentRosters(
  base: SubagentRoster,
  overrides: SubagentRoster,
): SubagentRoster {
  const merged: Record<string, SubagentRosterEntry> = {};
  for (const [name, entry] of Object.entries(base)) {
    merged[name] = { ...entry };
  }
  for (const [name, entry] of Object.entries(overrides)) {
    merged[name] = { ...merged[name], ...entry };
  }
  return merged;
}
