/**
 * Agent node factory — wraps an AgentRuntime session as a NodeFn.
 *
 * Lifecycle: delete stale artifact → setup → build prompt → create session →
 * wire events → send prompt → await idle/error → read artifact → teardown.
 *
 * Implements GT-3 dual-condition crash recovery: if a session errors out but
 * both a completion indicator was seen in output AND the artifact file exists
 * on disk with real content, treat the run as successful.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AgentConfig,
  AgentSession,
  ExecutionContext,
  NodeFn,
  NodeInput,
  NodeOutput,
  PromptOutput,
} from './types';
import { FlowAbortedError } from './types';

// ---------------------------------------------------------------------------
// GT-3 dual-condition crash recovery helper
// ---------------------------------------------------------------------------

const DEFAULT_COMPLETION_INDICATORS: readonly string[] = [
  'Done.',
  'completed',
  'CONFIRMED',
  'finished',
];

/**
 * Checks both conditions required to treat a crashed session as successful:
 * 1. At least one completion indicator string appears in the output lines
 * 2. The artifact file exists on disk with non-trivial content (> 10 chars)
 *
 * Both conditions must hold. Either alone produces false positives (GT-3).
 */
export function wasCompletedBeforeCrash(
  dir: string,
  outputFile: string,
  outputLines: readonly string[],
  indicators?: readonly string[],
): boolean {
  const indicatorList = indicators ?? DEFAULT_COMPLETION_INDICATORS;

  // Condition 1: any indicator found in any output line
  const hasIndicator = outputLines.some((line) =>
    indicatorList.some((ind) => line.includes(ind)),
  );

  // Condition 2: artifact exists with real content
  let hasArtifact = false;
  try {
    const artifactPath = path.join(dir, outputFile);
    if (fs.existsSync(artifactPath)) {
      const content = fs.readFileSync(artifactPath, 'utf-8');
      hasArtifact = content.trim().length > 10;
    }
  } catch {
    // File doesn't exist or can't be read
    hasArtifact = false;
  }

  return hasIndicator && hasArtifact;
}

// ---------------------------------------------------------------------------
// Prompt formatting
// ---------------------------------------------------------------------------

function formatPrompt(promptOutput: PromptOutput): string {
  if (typeof promptOutput === 'string') {
    return promptOutput;
  }
  // Structured prompt: combine system + user with clear delimiters
  return `${promptOutput.system}\n\n${promptOutput.user}`;
}

// ---------------------------------------------------------------------------
// Agent factory
// ---------------------------------------------------------------------------

/**
 * Creates a NodeFn that manages a full agent session lifecycle.
 *
 * The returned function:
 * 1. Deletes any stale artifact from a prior run
 * 2. Calls config.setup(input) if provided (R5, R10)
 * 3. Builds the prompt via config.promptBuilder(input)
 * 4. Creates a session via ctx.runtime.createSession()
 * 5. Wires session events to ctx.emitOutput for streaming
 * 6. Sends the prompt and awaits completion (idle) or error
 * 7. On error: attempts GT-3 crash recovery
 * 8. On success: reads artifact, parses action
 * 9. Calls config.teardown(input) in finally block
 */
export function agent(config: AgentConfig): NodeFn {
  return async (input: NodeInput, ctx: ExecutionContext): Promise<NodeOutput> => {
    // Abort check: bail early if already aborted
    if (ctx.signal.aborted) {
      throw new FlowAbortedError('Aborted before agent start');
    }

    // Step 1: Delete stale artifact
    if (config.output) {
      const artifactPath = path.join(input.dir, config.output);
      try {
        if (fs.existsSync(artifactPath)) {
          fs.unlinkSync(artifactPath);
        }
      } catch {
        // Ignore — may not exist
      }
    }

    // Step 2: Call setup hook (R5: runs before EVERY agent execution, R10: receives full NodeInput)
    if (config.setup) {
      await config.setup(input);
    }

    let session: AgentSession | null = null;
    const outputLines: string[] = [];

    try {
      // Step 3: Build prompt
      const promptOutput = config.promptBuilder(input);
      const promptStr = formatPrompt(promptOutput);

      // Step 4: Create session (COMP-3: cwdResolver overrides cwd for repo access)
      const sessionCwd = config.cwdResolver ? config.cwdResolver(input) : input.dir;
      session = await ctx.runtime.createSession({
        model: config.model ?? 'claude-opus-4.6',
        thinkingBudget: config.thinkingBudget,
        cwd: sessionCwd,
        addDirs: config.isolation ? [] : [input.dir],
        timeout: config.timeout ?? 3600,
        heartbeatTimeout: config.heartbeatTimeout ?? 120,
      });

      // Abort check after session creation
      if (ctx.signal.aborted) {
        await session.abort();
        throw new FlowAbortedError('Aborted after session creation');
      }

      // Step 5: Wire session events to emitOutput
      session.on('text', (text: string) => {
        outputLines.push(text);
        ctx.emitOutput({
          type: 'node:output',
          executionId: ctx.executionId,
          nodeId: ctx.nodeId,
          content: text,
          ts: Date.now(),
        });
      });

      session.on('tool_start', (tool: string, toolInput: string) => {
        ctx.emitOutput({
          type: 'node:tool',
          executionId: ctx.executionId,
          nodeId: ctx.nodeId,
          tool,
          phase: 'start',
          summary: toolInput.substring(0, 200),
          ts: Date.now(),
        });
      });

      session.on('tool_complete', (tool: string, output: string) => {
        ctx.emitOutput({
          type: 'node:tool',
          executionId: ctx.executionId,
          nodeId: ctx.nodeId,
          tool,
          phase: 'complete',
          summary: output.substring(0, 200),
          ts: Date.now(),
        });
      });

      // Step 6: Send prompt
      session.send(promptStr);

      // Step 7: Wait for completion — wrap in a Promise that resolves on idle, rejects on error
      const result = await new Promise<'idle'>((resolve, reject) => {
        // Listen for abort signal during session execution
        const onAbort = () => {
          session!.abort().then(
            () => reject(new FlowAbortedError('Aborted during session execution')),
            () => reject(new FlowAbortedError('Aborted during session execution')),
          );
        };
        ctx.signal.addEventListener('abort', onAbort, { once: true });

        session!.on('idle', () => {
          ctx.signal.removeEventListener('abort', onAbort);
          resolve('idle');
        });

        session!.on('error', (err: Error) => {
          ctx.signal.removeEventListener('abort', onAbort);
          reject(err);
        });
      }).catch((err: Error) => {
        // AI-4: Don't attempt GT-3 recovery on aborted sessions
        if (ctx.signal.aborted) {
          throw err;
        }
        // Step 8: GT-3 dual-condition crash recovery
        if (
          config.output &&
          wasCompletedBeforeCrash(
            input.dir,
            config.output,
            outputLines,
            config.completionIndicators,
          )
        ) {
          // Treat as success — artifact was written before crash
          return 'recovered' as const;
        }
        throw err;
      });

      // Step 9: Handle success (idle or recovered)
      let content: string | undefined;
      if (config.output) {
        const artifactPath = path.join(input.dir, config.output);
        try {
          content = fs.readFileSync(artifactPath, 'utf-8');
        } catch {
          // Artifact not written — that's fine for nodes that don't always produce output
          content = undefined;
        }
      }

      const action = config.actionParser && content
        ? config.actionParser(content)
        : 'default';

      return { action, artifact: content };
    } finally {
      // AI-1: Close session on all paths (abort is idempotent)
      if (session) {
        try {
          await session.abort();
        } catch {
          // Session may already be closed — ignore
        }
      }
      // Step 10: Teardown (always runs, R10: receives full NodeInput)
      if (config.teardown) {
        try {
          await config.teardown(input);
        } catch {
          // Teardown errors should not mask the primary error
        }
      }
    }
  };
}
