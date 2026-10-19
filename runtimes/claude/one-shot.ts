import { query } from '@anthropic-ai/claude-agent-sdk';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SessionConfig, ToolUsageData } from '../../src/types';

export interface OneShotResult {
  readonly text: string;
  readonly usage: Record<string, unknown> | null;
  readonly model: string;
}

export async function runOneShot(opts: {
  readonly model: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly system?: string;
}): Promise<OneShotResult> {
  let text = '';
  let usage: Record<string, unknown> | null = null;
  const q = query({
    prompt: opts.prompt,
    options: {
      model: opts.model,
      cwd: opts.cwd,
      systemPrompt: opts.system,
      permissionMode: 'dontAsk',
      allowDangerouslySkipPermissions: false,
    },
  });
  for await (const msg of q) {
    const m = msg as any;
    if (m.type === 'assistant') {
      const content = m.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'text' && typeof b.text === 'string') text += b.text;
        }
      }
      if (m.message?.usage) usage = { ...m.message.usage };
    } else if (m.type === 'result') {
      if (m.usage) usage = { ...m.usage, cost_usd: m.total_cost_usd };
      if (typeof m.result === 'string' && m.result.length > 0) text = text || m.result;
    }
  }
  try { q.close(); } catch { /* ignore */ }
  return { text, usage, model: opts.model };
}

export interface AdvisorStandInServerOpts {
  readonly config: SessionConfig;
  readonly cwd: string;
  readonly onToolUsage: (data: ToolUsageData) => void;
}

export function buildAdvisorStandInServer(opts: AdvisorStandInServerOpts) {
  const advisorModel = opts.config.advisor?.model;
  const standInCfg = opts.config.standIn;

  const tools: any[] = [];

  if (advisorModel) {
    tools.push(
      tool(
        'advisor',
        opts.config.advisor?.description ?? 'Consult a stronger reviewer model.',
        { question: z.string(), transcript: z.string().optional() },
        async (args: { question: string; transcript?: string }) => {
          const prompt = [
            opts.config.advisor?.system ?? '',
            'Question: ' + args.question,
            args.transcript ? 'Transcript:\n' + args.transcript : '',
          ].filter(Boolean).join('\n\n');
          const res = await runOneShot({ model: advisorModel, prompt, cwd: opts.cwd });
          const usages = res.usage ? [res.usage] : [];
          opts.onToolUsage({
            tool: 'advisor',
            model: res.model,
            usages,
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
    const hasMembers = Array.isArray(standInCfg.members) && (standInCfg.members as readonly string[]).length > 0;
    const hasBoth = hasMembers && standInCfg.memberCount !== undefined;
    if (hasBoth) {
      // eslint-disable-next-line no-console
      console.warn('[condukt] standIn: configure members or memberCount, not both; disabling stand_in');
    } else if (hasMembers) {
      const models = [...(standInCfg.members as readonly string[])];
      const memberCount = standInCfg.memberCount ?? models.length;
      if (models.length > 0) {
        tools.push(
          tool(
            'stand_in',
            standInCfg.description ?? 'Consult multiple reviewer models for a cross-lab verdict.',
            { question: z.string(), transcript: z.string().optional() },
            async (args: { question: string; transcript?: string }) => {
              const prompt = ['Question: ' + args.question, args.transcript ? 'Transcript:\n' + args.transcript : ''].filter(Boolean).join('\n\n');
              const voters = models.slice(0, memberCount);
              const results = await Promise.all(voters.map((m) => runOneShot({ model: m, prompt, cwd: opts.cwd })));
              const ballots = results.map((r) => r.text).join('\n---\n');
              opts.onToolUsage({
                tool: 'stand_in',
                model: voters.join(','),
                usages: results.map((r) => r.usage).filter(Boolean) as any,
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
  return createSdkMcpServer({ name: 'condukt', version: '1.0.0', tools });
}