import {
  createSdkMcpServer,
  query,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  ModelUsage,
  Options,
  SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SessionConfig, ToolUsageData } from '../../src/types';
import { mapConfig } from './config-mapper';

export interface OneShotResult {
  readonly text: string;
  /** Camel-case per-model usage records, ready for `ToolUsageData.usages`. */
  readonly usages: ReadonlyArray<Record<string, unknown>>;
  readonly model: string;
}

/**
 * A single, isolated query: advisor, stand-in voter, or handoff summary.
 *
 * Isolation is deliberate and mirrors the Copilot one-shot session: no
 * built-in tools, no MCP servers, no host settings discovery (`settingSources:
 * []`), and `dontAsk` so nothing can prompt. `env` carries the protocol
 * bridge's `ANTHROPIC_BASE_URL`/credentials; without it the CLI would call
 * `api.anthropic.com` directly.
 */
export async function runOneShot(opts: {
  readonly model: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly system?: string;
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Cancels the call. Advisor and stand-in one-shots outlive the node's turn
   * unless the session forwards its cancellation here; a stopped run must not
   * keep billing an upstream until it finishes on its own.
   */
  readonly signal?: AbortSignal;
}): Promise<OneShotResult> {
  if (opts.signal?.aborted === true) {
    return { text: '', usages: [], model: opts.model };
  }
  const abortController = new AbortController();
  if (opts.signal !== undefined) {
    opts.signal.addEventListener('abort', () => abortController.abort(), { once: true });
  }
  const config: SessionConfig = {
    model: opts.model,
    cwd: opts.cwd,
    addDirs: [],
    timeout: 0,
    heartbeatTimeout: 0,
    ...(opts.system !== undefined ? { systemMessage: opts.system } : {}),
  };
  const mapped = mapConfig(config, {
    oneShot: true,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  });
  const options: Options = {
    ...mapped.options,
    permissionMode: 'dontAsk',
    allowDangerouslySkipPermissions: false,
    abortController,
  } as Options;

  let text = '';
  let usages: Record<string, unknown>[] = [];
  const q = query({ prompt: opts.prompt, options });
  try {
    for await (const msg of q) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text') text += block.text;
        }
      } else if (msg.type === 'result') {
        // A one-shot session is fresh, so its cumulative snapshot is this
        // call's usage.
        usages = usageRecords(msg.modelUsage, msg.duration_ms);
        if (msg.subtype === 'success' && text.length === 0 && msg.result.length > 0) {
          text = msg.result;
        }
      }
    }
  } finally {
    try { q.close(); } catch { /* already closed */ }
  }
  return { text, usages, model: opts.model };
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function usageRecords(
  modelUsage: Readonly<Record<string, Partial<ModelUsage>>> | undefined,
  durationMs: number | undefined,
): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const [model, usage] of Object.entries(modelUsage ?? {})) {
    const cacheReadTokens = count(usage.cacheReadInputTokens);
    const cacheWriteTokens = count(usage.cacheCreationInputTokens);
    const inputTokens = count(usage.inputTokens) + cacheReadTokens + cacheWriteTokens;
    const outputTokens = count(usage.outputTokens);
    if (inputTokens === 0 && outputTokens === 0) continue;
    records.push({
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      model,
      ...(durationMs !== undefined ? { duration: durationMs } : {}),
    });
  }
  return records;
}

export interface AdvisorStandInServerOpts {
  readonly config: SessionConfig;
  readonly cwd: string;
  /** Bridge environment forwarded to every one-shot call. */
  readonly env?: Readonly<Record<string, string>>;
  /** Session cancellation, forwarded so a stopped run stops billing. */
  readonly signal?: AbortSignal;
  readonly onToolUsage: (data: ToolUsageData) => void;
}

const CONSULT_SCHEMA = { question: z.string(), transcript: z.string().optional() };
type ConsultToolDefinition = SdkMcpToolDefinition<typeof CONSULT_SCHEMA>;

/** Name the session registers the internal advisor/stand-in server under. */
export const CONDUKT_MCP_SERVER_NAME = 'condukt';

/**
 * Qualified names of the internal tools. Under `dontAsk` only tools listed in
 * `allowedTools` may run, and this server is added after `mapConfig`, so the
 * session must add these itself or the model is denied its own advisor.
 */
export const INTERNAL_MCP_TOOL_NAMES: readonly string[] = [
  `mcp__${CONDUKT_MCP_SERVER_NAME}__advisor`,
  `mcp__${CONDUKT_MCP_SERVER_NAME}__stand_in`,
];

export function buildAdvisorStandInServer(opts: AdvisorStandInServerOpts) {
  const advisorModel = opts.config.advisor?.model;
  const standInCfg = opts.config.standIn;

  const tools: ConsultToolDefinition[] = [];
  const env = {
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  };

  if (advisorModel) {
    tools.push(
      tool(
        'advisor',
        opts.config.advisor?.description ?? 'Consult a stronger reviewer model.',
        CONSULT_SCHEMA,
        async (args: { question: string; transcript?: string }) => {
          const prompt = [
            opts.config.advisor?.system ?? '',
            'Question: ' + args.question,
            args.transcript ? 'Transcript:\n' + args.transcript : '',
          ].filter(Boolean).join('\n\n');
          const res = await runOneShot({ model: advisorModel, prompt, cwd: opts.cwd, ...env });
          opts.onToolUsage({
            tool: 'advisor',
            model: res.model,
            usages: res.usages,
            sectionSizes: {
              focusChars: (opts.config.advisor?.system ?? '').length,
              contextChars: 0,
              transcriptChars: (args.transcript ?? '').length,
              promptChars: prompt.length,
            },
          });
          return { content: [{ type: 'text', text: res.text }] };
        },
      ),
    );
  }

  if (standInCfg) {
    // StandInConfig shape: `members` (explicit models) and/or `memberCount`.
    // Claude cannot auto-select from the copilot model catalogue, so a bare
    // memberCount (without members) disables stand_in here.
    const hasMembers = Array.isArray(standInCfg.members) && standInCfg.members.length > 0;
    const hasBoth = hasMembers && standInCfg.memberCount !== undefined;
    if (hasBoth) {
      // eslint-disable-next-line no-console
      console.warn('[condukt] standIn: configure members or memberCount, not both; disabling stand_in');
    } else if (hasMembers) {
      const models = [...(standInCfg.members ?? [])];
      const memberCount = standInCfg.memberCount ?? models.length;
      if (models.length > 0) {
        tools.push(
          tool(
            'stand_in',
            standInCfg.description ?? 'Consult multiple reviewer models for a cross-lab verdict.',
            CONSULT_SCHEMA,
            async (args: { question: string; transcript?: string }) => {
              const prompt = ['Question: ' + args.question, args.transcript ? 'Transcript:\n' + args.transcript : ''].filter(Boolean).join('\n\n');
              const voters = models.slice(0, memberCount);
              const results = await Promise.all(
                voters.map((m) => runOneShot({ model: m, prompt, cwd: opts.cwd, ...env })),
              );
              const ballots = results.map((r) => r.text).join('\n---\n');
              opts.onToolUsage({
                tool: 'stand_in',
                model: voters.join(','),
                usages: results.flatMap((r) => r.usages),
                sectionSizes: {
                  focusChars: 0,
                  contextChars: 0,
                  transcriptChars: (args.transcript ?? '').length,
                  promptChars: prompt.length,
                },
              });
              return { content: [{ type: 'text', text: ballots }] };
            },
          ),
        );
      }
    }
  }

  if (tools.length === 0) return null;
  // `SdkMcpToolDefinition`'s handler parameter is contravariant, so the
  // erased `SdkMcpToolDefinition<any>[]` element type rejects a concretely
  // typed definition even though the runtime shapes are identical. Assert at
  // this one boundary; every handler below is schema-checked by `tool()`.
  return createSdkMcpServer({
    name: CONDUKT_MCP_SERVER_NAME,
    version: '1.0.0',
    tools: tools as unknown as SdkMcpToolDefinition[],
  });
}
