import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/types';
import { SdkBackend } from '../../runtimes/copilot/sdk-backend';
import {
  DEFAULT_COMPLEMENTARY_MODEL_POLICY,
  DEFAULT_SUBAGENT_ROSTER,
  MODEL_TIER_CATALOG,
  MODEL_TIERS,
  mergeSubagentRosters,
  resolveComplementaryModel,
  resolveTieredCustomAgents,
} from '../../runtimes/copilot/subagents';
import type { ModelTier } from '../../runtimes/copilot/subagents';

interface MockSdkSession {
  readonly send: ReturnType<typeof vi.fn>;
  readonly abort: ReturnType<typeof vi.fn>;
  readonly disconnect: ReturnType<typeof vi.fn>;
  readonly rpc: {
    readonly tools: { readonly updateSubagentSettings: ReturnType<typeof vi.fn> };
    readonly mode: { readonly set: ReturnType<typeof vi.fn> };
  };
  readonly on: (...args: readonly unknown[]) => void;
}

let mockSdkSession: MockSdkSession;
let mockCreateSession: (config: Record<string, unknown>) => Promise<MockSdkSession>;
let originalFunction: typeof globalThis.Function;
let callOrder: string[];

function createMockSdkSession(): MockSdkSession {
  return {
    send: vi.fn().mockImplementation(async () => { callOrder.push('send'); }),
    abort: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    rpc: {
      tools: {
        updateSubagentSettings: vi.fn().mockImplementation(async () => {
          callOrder.push('updateSubagentSettings');
          return {};
        }),
      },
      mode: { set: vi.fn().mockResolvedValue(undefined) },
    },
    on: () => undefined,
  };
}

async function sendWithRoster(
  backendRoster?: NonNullable<ConstructorParameters<typeof SdkBackend>[0]>['subagentRoster'],
  sessionRoster?: Parameters<SdkBackend['createSession']>[0]['subagentRoster'],
  logger?: Logger,
  backendLimits: {
    readonly maxDepth?: number;
    readonly maxConcurrency?: number;
  } = {},
  sessionLimits: {
    readonly maxDepth?: number;
    readonly maxConcurrency?: number;
  } = {},
  model = 'test-model',
  complementaryModelPolicy?: NonNullable<ConstructorParameters<typeof SdkBackend>[0]>['complementaryModelPolicy'],
): Promise<MockSdkSession> {
  const backend = new SdkBackend({
    ...(backendRoster !== undefined ? { subagentRoster: backendRoster } : {}),
    ...backendLimits,
    ...(logger !== undefined ? { logger } : {}),
    ...(complementaryModelPolicy !== undefined ? { complementaryModelPolicy } : {}),
  });
  const session = await backend.createSession({
    model: model,
    cwd: '.',
    addDirs: [],
    timeout: 3600,
    heartbeatTimeout: 120,
    ...(sessionRoster !== undefined ? { subagentRoster: sessionRoster } : {}),
    ...sessionLimits,
  });
  session.send('test prompt');
  await vi.waitFor(() => expect(mockSdkSession.send).toHaveBeenCalled());
  return mockSdkSession;
}

beforeEach(() => {
  callOrder = [];
  mockSdkSession = createMockSdkSession();
  mockCreateSession = vi.fn().mockImplementation(async () => {
    callOrder.push('createSession');
    return mockSdkSession;
  });
  originalFunction = globalThis.Function;

  const mockFunction = function (...args: string[]): Function {
    if (args.length === 2 && args[0] === 'specifier' && args[1] === 'return import(specifier)') {
      return () => Promise.resolve({
        RuntimeConnection: {
          forStdio: vi.fn(() => ({ kind: 'stdio' as const })),
        },
        CopilotRequestHandler: class MockCopilotRequestHandler {},
        CopilotWebSocketForwarder: class MockCopilotWebSocketForwarder {},
        CopilotClient: class MockCopilotClient {
          createSession(config: Record<string, unknown>) {
            return mockCreateSession(config);
          }
          stop() { return Promise.resolve(); }
          forceStop() { return Promise.resolve(); }
        },
        approveAll: () => ({}),
      });
    }
    return originalFunction(...args);
  };
  (globalThis as Record<string, unknown>).Function = mockFunction as unknown as typeof Function;
});

afterEach(() => {
  globalThis.Function = originalFunction;
});

describe('Copilot subagent roster', () => {
  it('applies the complete stable default roster before the first prompt', async () => {
    const mock = await sendWithRoster(DEFAULT_SUBAGENT_ROSTER);

    expect(mock.rpc.tools.updateSubagentSettings).toHaveBeenCalledOnce();
    expect(mock.rpc.tools.updateSubagentSettings).toHaveBeenCalledWith({
      subagents: { agents: DEFAULT_SUBAGENT_ROSTER },
    });
    expect(callOrder).toEqual(['createSession', 'updateSubagentSettings', 'send']);
  });

  it('merges consumer overrides per agent and per field', async () => {
    const mock = await sendWithRoster(
      {
        explore: { model: 'backend-model' },
        verifier: { model: 'gpt-5.6-sol', effortLevel: 'xhigh' },
      },
      {
        explore: { effortLevel: 'medium' },
      },
    );

    expect(mock.rpc.tools.updateSubagentSettings).toHaveBeenCalledWith({
      subagents: {
        agents: mergeSubagentRosters(DEFAULT_SUBAGENT_ROSTER, {
          explore: {
            model: 'backend-model',
            effortLevel: 'medium',
          },
          verifier: { model: 'gpt-5.6-sol', effortLevel: 'xhigh' },
        }),
      },
    });
    const params = mock.rpc.tools.updateSubagentSettings.mock.calls[0]?.[0] as {
      readonly subagents: { readonly agents: Record<string, Record<string, unknown>> };
    };
    expect(params.subagents.agents.explore).toEqual({
      model: 'backend-model',
      effortLevel: 'medium',
      contextTier: 'long_context',
    });
    expect(params.subagents.agents['code-review']).toEqual(DEFAULT_SUBAGENT_ROSTER['code-review']);
    expect(params.subagents.agents.verifier).toEqual({
      model: 'gpt-5.6-sol',
      effortLevel: 'xhigh',
    });
  });

  it('forwards maxDepth and maxConcurrency when set', async () => {
    const mock = await sendWithRoster(
      undefined,
      undefined,
      undefined,
      { maxDepth: 4, maxConcurrency: 8 },
      { maxDepth: 1, maxConcurrency: 2 },
    );

    expect(mock.rpc.tools.updateSubagentSettings).toHaveBeenCalledWith({
      subagents: { maxDepth: 1, maxConcurrency: 2 },
    });
  });

  it('omits maxDepth and maxConcurrency when not set', async () => {
    const mock = await sendWithRoster(DEFAULT_SUBAGENT_ROSTER);
    const params = mock.rpc.tools.updateSubagentSettings.mock.calls[0]?.[0] as {
      readonly subagents: Record<string, unknown>;
    };
    expect(params.subagents).not.toHaveProperty('maxDepth');
    expect(params.subagents).not.toHaveProperty('maxConcurrency');
  });

  it('sends nothing when the roster and limits are unset', async () => {
    const mock = await sendWithRoster();
    expect(mock.rpc.tools.updateSubagentSettings).not.toHaveBeenCalled();
  });

  it('sends nothing when the roster is false', async () => {
    const disabledBackend = await sendWithRoster(false);
    expect(disabledBackend.rpc.tools.updateSubagentSettings).not.toHaveBeenCalled();

    mockSdkSession = createMockSdkSession();
    await sendWithRoster({ explore: { model: 'backend-model' } }, false);
    expect(mockSdkSession.rpc.tools.updateSubagentSettings).not.toHaveBeenCalled();
  });

  it('logs and swallows an RPC rejection so the prompt is still sent', async () => {
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    mockSdkSession.rpc.tools.updateSubagentSettings.mockRejectedValueOnce(
      new Error('experimental RPC unavailable'),
    );

    const mock = await sendWithRoster(DEFAULT_SUBAGENT_ROSTER, undefined, logger);

    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to apply Copilot subagent settings; using default settings',
      { error: 'experimental RPC unavailable' },
    );
    expect(mock.send).toHaveBeenCalledWith({ prompt: 'test prompt' });
    expect(callOrder).toEqual(['createSession', 'send']);
  });

  it('keeps every default entry within the shape the Copilot CLI accepts', () => {
    for (const [name, entry] of Object.entries(DEFAULT_SUBAGENT_ROSTER)) {
      expect(Object.keys(entry).sort(), `${name} may only set CLI-known fields`)
        .toEqual(['contextTier', 'effortLevel', 'model']);
      expect(['inherit', 'default', 'long_context'], `${name} contextTier`)
        .toContain(entry.contextTier);
    }
  });

  it('assigns every default roster entry to its intended tier at long context', () => {
    const expected = {
      plan: { model: 'inherit', tier: 'high' },
      explore: { model: MODEL_TIERS.cheap[1], tier: 'cheap' },
      'general-purpose': { model: MODEL_TIERS.mid[2], tier: 'mid' },
      task: { model: MODEL_TIERS.mid[2], tier: 'mid' },
      'code-review': { model: 'complementary', tier: 'high' },
      'security-review': { model: 'complementary', tier: 'high' },
      research: { model: MODEL_TIERS.mid[0], tier: 'mid' },
    } as const;

    for (const [name, intended] of Object.entries(expected)) {
      const entry = DEFAULT_SUBAGENT_ROSTER[name];
      expect(entry?.model, `${name} model`).toBe(intended.model);
      expect(entry?.contextTier, `${name} context tier`).toBe('long_context');
      if (entry?.model !== 'inherit' && entry?.model !== 'complementary') {
        expect(MODEL_TIER_CATALOG.find(model => model.id === entry.model)?.tier, `${name} tier`)
          .toBe(intended.tier);
      }
    }
  });

  it('defines exactly five routed custom agents at their intended tiers and context policy', () => {
    const resolved = resolveTieredCustomAgents('gpt-5.6-sol');
    expect(resolved.agents.map(agent => agent.name)).toEqual([
      'explore', 'research', 'implement', 'verify', 'review',
    ]);
    expect(Object.fromEntries(resolved.agents.map(agent => [agent.name, agent.model]))).toEqual({
      explore: 'gemini-3.6-flash',
      research: 'gemini-3.1-pro-preview',
      implement: 'gpt-5.6-terra',
      verify: 'claude-sonnet-5',
      review: 'claude-opus-5',
    });
    for (const name of ['explore', 'research', 'review']) {
      expect(resolved.agents.find(agent => agent.name === name)?.tools, `${name} tools`)
        .not.toContain('apply_patch');
      expect(resolved.agents.find(agent => agent.name === name)?.tools, `${name} tools`)
        .not.toContain('powershell');
    }
  });

  // availableTools is an allowlist matched against names the runtime registered, and an entry it
  // does not recognise is dropped silently rather than rejected. `rg` was such an entry: these
  // three read-only agents could list and read files but not search inside them, with nothing to
  // indicate it. A session handed ['view','rg','glob'] reported back exactly ["view","glob"].
  //
  // Asserting the exact set rather than "contains a search tool" is the point -- a typo here is
  // invisible at runtime, so the only place it can be caught is a pin.
  it('gives the read-only agents a search tool the runtime actually registers', () => {
    const resolved = resolveTieredCustomAgents('gpt-5.6-sol');

    for (const name of ['explore', 'review']) {
      expect(resolved.agents.find(agent => agent.name === name)?.tools, `${name} tools`)
        .toEqual(['view', 'grep', 'glob']);
    }
    // research additionally reaches external sources.
    expect(resolved.agents.find(agent => agent.name === 'research')?.tools)
      .toEqual(['view', 'grep', 'glob', 'web_fetch']);
    for (const agent of resolved.agents) {
      expect(agent.tools ?? [], `${agent.name} must not name the non-existent rg tool`)
        .not.toContain('rg');
    }
  });

  it('resolves every catalogued model to a cross-lab complement without downgrading', () => {
    const tierRank: Readonly<Record<ModelTier, number>> = { cheap: 0, mid: 1, high: 2 };

    for (const source of MODEL_TIER_CATALOG) {
      const resolution = resolveComplementaryModel(source.id);
      expect(resolution.usedCliFallback, `${source.id} should resolve locally`).toBe(false);
      expect(resolution.complement?.lab, `${source.id} complement lab`).not.toBe(source.lab);
      expect(
        tierRank[resolution.complement?.tier ?? 'cheap'],
        `${source.id} complement must not downgrade`,
      ).toBeGreaterThanOrEqual(tierRank[source.tier]);
    }
  });

  // Pinned, not derived. DEFAULT_COMPLEMENTARY_MODEL_PREFERENCE is a spread of MODEL_TIERS in
  // order, and resolveComplementaryModel takes the first different-lab entry at or above the
  // source tier -- so inserting a model anywhere but the end of its tier silently re-resolves
  // the complement of models that were already correct. The catalogue-wide test above only
  // asserts each resolution is cross-lab and not a downgrade, which a perturbed order still
  // satisfies. This table is what actually fails when the order moves.
  it('keeps every complement resolution stable as the catalogue grows', () => {
    const expected: ReadonlyArray<readonly [string, string]> = [
      ['gpt-5.6-luna', 'gemini-3.6-flash'],
      ['gemini-3.6-flash', 'gpt-5.6-luna'],
      ['gemini-3.1-pro-preview', 'claude-sonnet-5'],
      ['claude-sonnet-5', 'gemini-3.1-pro-preview'],
      ['gpt-5.6-terra', 'gemini-3.1-pro-preview'],
      ['grok-4.5', 'gemini-3.1-pro-preview'],
      ['claude-opus-5', 'gpt-5.6-sol'],
      ['gpt-5.6-sol', 'claude-opus-5'],
    ];

    expect(MODEL_TIER_CATALOG.map((model) => model.id)).toEqual(expected.map(([id]) => id));
    for (const [source, complement] of expected) {
      expect(resolveComplementaryModel(source).resolvedModel, `${source} complement`)
        .toBe(complement);
    }
  });

  it('uses explicit preference order deterministically regardless of catalogue order', () => {
    const reversedPolicy = {
      models: [...MODEL_TIER_CATALOG].reverse(),
      preference: DEFAULT_COMPLEMENTARY_MODEL_POLICY.preference,
    };

    const expected = resolveComplementaryModel('gemini-3.1-pro-preview').resolvedModel;
    expect(expected).toBe('claude-sonnet-5');
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(resolveComplementaryModel('gemini-3.1-pro-preview', reversedPolicy).resolvedModel)
        .toBe(expected);
    }
  });

  it('allows callers to override complementary model preference', () => {
    const resolution = resolveComplementaryModel('gemini-3.1-pro-preview', {
      models: MODEL_TIER_CATALOG,
      preference: ['gpt-5.6-sol', 'gpt-5.6-terra'],
    });

    expect(resolution.resolvedModel).toBe('gpt-5.6-sol');
    expect(resolution.usedCliFallback).toBe(false);
  });

  it('falls back when caller policy metadata contains duplicate model ids', () => {
    const resolution = resolveComplementaryModel('duplicate', {
      models: [
        { id: 'duplicate', lab: 'openai', tier: 'mid' },
        { id: 'duplicate', lab: 'google', tier: 'high' },
        { id: 'anthropic-peer', lab: 'anthropic', tier: 'mid' },
      ],
      preference: ['duplicate', 'anthropic-peer'],
    });

    expect(resolution).toEqual({
      sourceModel: 'duplicate',
      resolvedModel: 'complementary',
      usedCliFallback: true,
    });
  });

  it('resolves known review complements before sending and logs the concrete model', async () => {
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const mock = await sendWithRoster(
      DEFAULT_SUBAGENT_ROSTER,
      undefined,
      logger,
      {},
      {},
      'gpt-5.6-sol',
    );
    const params = mock.rpc.tools.updateSubagentSettings.mock.calls[0]?.[0] as {
      readonly subagents: { readonly agents: Record<string, Record<string, unknown>> };
    };

    expect(params.subagents.agents['code-review']?.model).toBe('claude-opus-5');
    expect(params.subagents.agents['security-review']?.model).toBe('claude-opus-5');
    expect(logger.info).toHaveBeenCalledWith(
      'Resolved complementary sub-agent model',
      expect.objectContaining({
        sessionModel: 'gpt-5.6-sol',
        resolvedModel: 'claude-opus-5',
        usedCliFallback: false,
      }),
    );
  });

  it('falls back to the CLI strategy for an unmapped session model and logs it', async () => {
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const resolution = resolveComplementaryModel('future-model');
    expect(resolution).toMatchObject({
      sourceModel: 'future-model',
      resolvedModel: 'complementary',
      usedCliFallback: true,
    });

    const mock = await sendWithRoster(DEFAULT_SUBAGENT_ROSTER, undefined, logger);
    const params = mock.rpc.tools.updateSubagentSettings.mock.calls[0]?.[0] as {
      readonly subagents: { readonly agents: Record<string, Record<string, unknown>> };
    };
    expect(params.subagents.agents['code-review']?.model).toBe('complementary');
    expect(logger.warn).toHaveBeenCalledWith(
      'Falling back to CLI complementary sub-agent model resolution',
      expect.objectContaining({
        sessionModel: 'test-model',
        resolvedModel: 'complementary',
        usedCliFallback: true,
      }),
    );
  });
});
