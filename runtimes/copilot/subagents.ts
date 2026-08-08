export type SubagentRosterValue = 'inherit' | (string & {});

export interface SubagentRosterEntry {
  readonly model?: SubagentRosterValue;
  readonly effortLevel?: SubagentRosterValue;
  readonly contextTier?: 'inherit' | 'default' | 'long_context';
}

export type SubagentRoster = Readonly<Record<string, SubagentRosterEntry>>;

export interface SubagentLimits {
  /**
   * Enables model-issued subagent dispatch. Defaults to true. Callers can
   * disable it through both the permission policy and the task tool filter.
   */
  readonly subagentsEnabled?: boolean;
  /**
   * Maximum nesting depth. The CLI rejects dispatches that would exceed this
   * value with `Maximum sub-agent depth of N reached`.
   */
  readonly maxDepth?: number;
  /**
   * Maximum concurrently running subagents. The CLI rejects an over-limit
   * dispatch rather than queueing it, so callers must handle failed dispatches.
   */
  readonly maxConcurrency?: number;
}

// Order within a tier is load-bearing: DEFAULT_COMPLEMENTARY_MODEL_PREFERENCE is a spread of
// these arrays, and resolveComplementaryModel takes the FIRST different-lab entry at or above
// the source tier. Append a new model at the end of its tier; inserting one earlier silently
// re-resolves the complement of every model already in the catalog.
export const MODEL_TIERS = {
  cheap: ['gpt-5.6-luna', 'gemini-3.6-flash'],
  mid: ['gemini-3.1-pro-preview', 'claude-sonnet-5', 'gpt-5.6-terra', 'grok-4.5'],
  high: ['claude-opus-5', 'gpt-5.6-sol'],
} as const;

export type ModelTier = keyof typeof MODEL_TIERS;
export type ModelLab = 'anthropic' | 'google' | 'openai' | 'xai';

export interface ModelTierDefinition {
  readonly id: string;
  readonly lab: ModelLab;
  readonly tier: ModelTier;
}

export const MODEL_TIER_CATALOG = [
  { id: MODEL_TIERS.cheap[0], lab: 'openai', tier: 'cheap' },
  { id: MODEL_TIERS.cheap[1], lab: 'google', tier: 'cheap' },
  { id: MODEL_TIERS.mid[0], lab: 'google', tier: 'mid' },
  { id: MODEL_TIERS.mid[1], lab: 'anthropic', tier: 'mid' },
  { id: MODEL_TIERS.mid[2], lab: 'openai', tier: 'mid' },
  { id: MODEL_TIERS.mid[3], lab: 'xai', tier: 'mid' },
  { id: MODEL_TIERS.high[0], lab: 'anthropic', tier: 'high' },
  { id: MODEL_TIERS.high[1], lab: 'openai', tier: 'high' },
] as const satisfies readonly ModelTierDefinition[];

export const DEFAULT_COMPLEMENTARY_MODEL_PREFERENCE = [
  ...MODEL_TIERS.cheap,
  ...MODEL_TIERS.mid,
  ...MODEL_TIERS.high,
] as const;

export interface ComplementaryModelPolicy {
  readonly models: readonly ModelTierDefinition[];
  readonly preference: readonly string[];
}

export const DEFAULT_COMPLEMENTARY_MODEL_POLICY: ComplementaryModelPolicy = {
  models: MODEL_TIER_CATALOG,
  preference: DEFAULT_COMPLEMENTARY_MODEL_PREFERENCE,
};

export interface ComplementaryModelResolution {
  readonly sourceModel: string;
  readonly resolvedModel: string;
  readonly usedCliFallback: boolean;
  readonly source?: ModelTierDefinition;
  readonly complement?: ModelTierDefinition;
}

export interface SubagentComplementaryResolution extends ComplementaryModelResolution {
  readonly subagent: string;
}

export interface ResolvedSubagentRoster {
  readonly roster: SubagentRoster;
  readonly resolutions: readonly SubagentComplementaryResolution[];
}

export interface TieredCustomAgentDefinition {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly prompt: string;
  readonly tools?: readonly string[];
  readonly model: string;
}

export interface ResolvedTieredCustomAgents {
  readonly agents: readonly TieredCustomAgentDefinition[];
  readonly reviewResolution: ComplementaryModelResolution;
}

const MODEL_TIER_RANK: Readonly<Record<ModelTier, number>> = {
  cheap: 0,
  mid: 1,
  high: 2,
};

export function resolveComplementaryModel(
  sourceModel: string,
  policy: ComplementaryModelPolicy = DEFAULT_COMPLEMENTARY_MODEL_POLICY,
): ComplementaryModelResolution {
  const modelsById = new Map<string, ModelTierDefinition>();
  for (const model of policy.models) {
    if (modelsById.has(model.id)) {
      return { sourceModel, resolvedModel: 'complementary', usedCliFallback: true };
    }
    modelsById.set(model.id, model);
  }

  const source = modelsById.get(sourceModel);
  if (source === undefined) {
    return { sourceModel, resolvedModel: 'complementary', usedCliFallback: true };
  }

  for (const modelId of policy.preference) {
    const candidate = modelsById.get(modelId);
    if (
      candidate !== undefined
      && candidate.id !== source.id
      && candidate.lab !== source.lab
      && MODEL_TIER_RANK[candidate.tier] >= MODEL_TIER_RANK[source.tier]
    ) {
      return {
        sourceModel,
        resolvedModel: candidate.id,
        usedCliFallback: false,
        source,
        complement: candidate,
      };
    }
  }

  return { sourceModel, resolvedModel: 'complementary', usedCliFallback: true, source };
}

export function resolveSubagentRosterModels(
  roster: SubagentRoster,
  sessionModel: string,
  policy: ComplementaryModelPolicy = DEFAULT_COMPLEMENTARY_MODEL_POLICY,
): ResolvedSubagentRoster {
  const resolvedRoster: Record<string, SubagentRosterEntry> = {};
  const resolutions: SubagentComplementaryResolution[] = [];

  for (const [subagent, entry] of Object.entries(roster)) {
    if (entry.model !== 'complementary') {
      resolvedRoster[subagent] = { ...entry };
      continue;
    }

    const resolution = resolveComplementaryModel(sessionModel, policy);
    resolvedRoster[subagent] = { ...entry, model: resolution.resolvedModel };
    resolutions.push({ subagent, ...resolution });
  }

  return { roster: resolvedRoster, resolutions };
}

const READ_ONLY_REPOSITORY_TOOLS = ['view', 'rg', 'glob'] as const;

export function resolveTieredCustomAgents(
  sessionModel: string,
  policy: ComplementaryModelPolicy = DEFAULT_COMPLEMENTARY_MODEL_POLICY,
): ResolvedTieredCustomAgents {
  const reviewResolution = resolveComplementaryModel(sessionModel, policy);
  return {
    agents: [
      {
        name: 'explore',
        displayName: 'Explore',
        description: 'Read-only search and gathering whose output will be discarded or immediately summarized. Use research instead when the synthesis itself must remain durable.',
        prompt: 'Search and read only. Return concise findings to the driver and do not modify the workspace.',
        tools: READ_ONLY_REPOSITORY_TOOLS,
        model: MODEL_TIERS.cheap[1],
      },
      {
        name: 'research',
        displayName: 'Research',
        description: 'Durable synthesis the driver will rely on, including prior art, external sources, and competitor analysis. Use explore instead for throwaway repository gathering.',
        prompt: 'Gather and synthesize durable evidence with source references. Do not modify the workspace.',
        tools: [...READ_ONLY_REPOSITORY_TOOLS, 'web_fetch'],
        model: MODEL_TIERS.mid[0],
      },
      {
        name: 'implement',
        displayName: 'Implement',
        description: 'Execute a scoped, bounded change with clear acceptance criteria. Return the changed files and verification performed.',
        prompt: 'Implement only the bounded assignment, match repository conventions, and verify the result.',
        model: MODEL_TIERS.mid[2],
      },
      {
        name: 'verify',
        displayName: 'Verify',
        description: 'Mechanically confirm behavior by running tests, validation, or reproduction steps. Use review instead when judgement or adjudication is required.',
        prompt: 'Verify the stated behavior independently and report reproducible evidence, failures, and commands run.',
        model: MODEL_TIERS.mid[1],
      },
      {
        name: 'review',
        displayName: 'Review',
        description: 'Independently adjudicate work already produced, using a different lab at the same tier or higher. Use verify instead for mechanical confirmation.',
        prompt: 'Review the supplied work independently. Find correctness, security, and maintainability problems without modifying the workspace.',
        tools: READ_ONLY_REPOSITORY_TOOLS,
        model: reviewResolution.resolvedModel,
      },
    ],
    reviewResolution,
  };
}

/**
 * `model` accepts a specific model id or one of the CLI's strategies: `inherit`
 * (match the session model), `complementary` (resolve a model from a different
 * family than the session model), or `default`.
 */
export const DEFAULT_SUBAGENT_ROSTER: SubagentRoster = {
  // Only high-tier models may drive nodes because the driver must own ambiguity and delegation.
  // Inheritance is safe for planning only because every node driver is guaranteed high-tier.
  plan: { model: 'inherit', effortLevel: 'high', contextTier: 'long_context' },
  // Broad reads are immediately synthesized by the high-tier driver, so latency matters most.
  explore: { model: 'gemini-3.6-flash', effortLevel: 'high', contextTier: 'long_context' },
  // Scoped delegated work needs reliable execution without paying for driver-level judgement.
  'general-purpose': { model: 'gpt-5.6-terra', effortLevel: 'high', contextTier: 'long_context' },
  // Bounded delegated tasks need execution quality rather than open-ended adjudication.
  task: { model: 'gpt-5.6-terra', effortLevel: 'medium', contextTier: 'long_context' },
  // Independent review must cross labs without weakening the tier of the question being reviewed.
  'code-review': { model: 'complementary', effortLevel: 'high', contextTier: 'long_context' },
  'security-review': { model: 'complementary', effortLevel: 'high', contextTier: 'long_context' },
  // Scoped synthesis benefits from stronger reasoning but remains bounded delegated work.
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
