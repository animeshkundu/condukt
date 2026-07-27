import type {
  NodeOutputEvent,
  NodePromptEvent,
  NodeReasoningEvent,
  NodeToolEvent,
  OutputEvent,
} from './events';

export type OutputEventSink = (event: OutputEvent) => void;
export type OutputRedactor = (value: string) => string;
export type ToolOutputMode = 'hidden' | 'preview' | 'full';

export interface ConsoleOutputOptions {
  /** Literal values known by the consumer to be secrets. */
  readonly knownSecrets?: readonly string[];
  /** Replaces the built-in redactor. Known secrets are still scrubbed afterward. */
  readonly redactor?: OutputRedactor;
  /** Render node:reasoning events. Defaults to false. */
  readonly renderReasoning?: boolean;
  /** Render complete model requests. Defaults to true. */
  readonly renderPrompts?: boolean;
  /**
   * Raw tool-result rendering. Defaults to hidden because the compact tool call
   * already carries the useful signal. Use preview or full for tool debugging.
   */
  readonly toolOutputMode?: ToolOutputMode;
  /** Maximum redacted tool-call or tool-output preview length. Defaults to 200. */
  readonly toolPreviewMaxChars?: number;
}

export interface ConsoleOutputRenderer {
  readonly emitOutput: OutputEventSink;
  readonly flushNode: (executionId: string, nodeId: string) => void;
  readonly flushExecution: (executionId: string) => void;
  readonly flush: () => void;
}

type StreamedOutputEvent = NodePromptEvent | NodeOutputEvent | NodeReasoningEvent;

type PendingLine = {
  readonly nodeId: string;
  readonly content: string;
  readonly prefix: string;
  readonly privateKey?: boolean;
};

const REDACTED = '[REDACTED]';
const DEFAULT_TOOL_PREVIEW_MAX_CHARS = 200;
const PRIVATE_KEY_BEGIN = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/u;
const PRIVATE_KEY_END = /-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/u;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/gu;
const GITHUB_TOKEN =
  /\b(?:gh[opsur]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/gu;
const AWS_ACCESS_KEY_ID = /\bAKIA[A-Z0-9]{16}\b/gu;
const QUOTED_AUTHORIZATION_HEADER =
  /\b((?:proxy-)?authorization\b["']?\s*:\s*)(["'])[^\r\n]*?\2/giu;
const AUTHORIZATION_HEADER =
  /\b((?:proxy-)?authorization\b\s*:\s*)[^\r\n}]+/giu;
const AWS_SECRET_ACCESS_KEY =
  /\b((?:aws[ _-]*)?secret[ _-]*access[ _-]*key\b["']?\s*[=:]\s*["']?)[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/giu;
const REDACTABLE_PREFIX =
  /\b(?:gh[opsur]_[A-Za-z0-9_]{0,19}|github(?:_pat_?[A-Za-z0-9_]{0,19})?|AKIA[A-Z0-9]{0,15})$/u;

/** Redacts common credential formats without guessing based on entropy. */
export function redactConsoleOutput(value: string): string {
  return value
    .replace(PRIVATE_KEY_BLOCK, REDACTED)
    .replace(GITHUB_TOKEN, REDACTED)
    .replace(AWS_ACCESS_KEY_ID, REDACTED)
    .replace(QUOTED_AUTHORIZATION_HEADER, `$1$2${REDACTED}$2`)
    .replace(AUTHORIZATION_HEADER, `$1${REDACTED}`)
    .replace(AWS_SECRET_ACCESS_KEY, `$1${REDACTED}`);
}

function redactKnownSecrets(value: string, secrets: readonly string[]): string {
  return [...new Set(secrets.filter((secret) => secret.length > 0))]
    .sort((left, right) => right.length - left.length)
    .reduce((redacted, secret) => redacted.replaceAll(secret, REDACTED), value);
}

function safeEmissionBoundary(
  value: string,
  knownSecrets: readonly string[],
  detectCredentialPrefixes: boolean,
): number {
  const boundary = value.lastIndexOf('\n') + 1;
  if (boundary <= 0) return 0;

  const emitted = value.slice(0, boundary);
  const separatorLength = emitted.endsWith('\r\n') ? 2 : 1;
  const suffix = emitted.slice(0, -separatorLength);
  const lastLineStart = suffix.lastIndexOf('\n') + 1;
  const lastLine = suffix.slice(lastLineStart);
  if (detectCredentialPrefixes && REDACTABLE_PREFIX.test(lastLine)) return lastLineStart;

  let safeBoundary = boundary;
  for (const secret of knownSecrets) {
    if (secret.length === 0) continue;
    const maxPrefixLength = Math.min(secret.length - 1, suffix.length);
    for (let length = maxPrefixLength; length > 0; length -= 1) {
      if (!suffix.endsWith(secret.slice(0, length))) continue;
      const prefixStart = suffix.length - length;
      safeBoundary = Math.min(safeBoundary, suffix.lastIndexOf('\n', prefixStart - 1) + 1);
      break;
    }
  }

  return safeBoundary;
}

function safeStringify(value: Readonly<Record<string, unknown>> | undefined): string {
  if (!value) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function compact(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function streamKey(...parts: readonly string[]): string {
  return JSON.stringify(parts);
}

function label(value: string): string {
  return value.replace(/[\r\n]+/gu, ' ');
}

function previewLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TOOL_PREVIEW_MAX_CHARS;
  return Math.max(1, Math.trunc(value));
}

/**
 * Creates a plain-text OutputEvent renderer for readable request/response logs.
 * Model prose is line-buffered and complete, tool calls are compact, raw tool
 * results are hidden by default, and all text is redacted before truncation.
 */
export function createConsoleOutputRenderer(
  options: ConsoleOutputOptions = {},
): ConsoleOutputRenderer {
  const buffers = new Map<string, Map<string, PendingLine>>();
  const subagents = new Map<string, Map<string, string>>();
  const activeTurns = new Map<string, Set<string>>();
  const useBuiltInRedactor = options.redactor === undefined;
  const redact = options.redactor ?? redactConsoleOutput;
  const knownSecrets = options.knownSecrets ?? [];
  const toolOutputMode = options.toolOutputMode ?? 'hidden';
  const maxToolPreviewChars = previewLimit(options.toolPreviewMaxChars);

  // Keep all writes on one guarded path so rendering failures stay isolated.
  function writeStdout(value: string): void {
    try {
      process.stdout.write(value);
    } catch {
      // Output rendering must never interrupt an execution.
    }
  }

  function redactText(value: string): string | undefined {
    try {
      return redactKnownSecrets(redact(value), knownSecrets);
    } catch {
      return undefined;
    }
  }

  function writeLine(prefix: string, content: string): void {
    const redacted = redactText(`${prefix}${content}`);
    if (redacted === undefined) return;
    const normalized = redacted.endsWith('\r') ? redacted.slice(0, -1) : redacted;
    writeStdout(`${normalized}\n`);
  }

  function writeCompactLine(prefix: string, content: string): void {
    const redacted = redactText(`${prefix}${content}`);
    if (redacted === undefined) return;
    const indentation = prefix.match(/^\s+/u)?.[0] ?? '';
    const compacted = compact(redacted);
    const maximum = compact(prefix).length + maxToolPreviewChars;
    const preview = compacted.length > maximum
      ? `${compacted.slice(0, Math.max(0, maximum - 1))}…`
      : compacted;
    writeStdout(`${indentation}${preview}\n`);
  }

  function getNodeBuffers(executionId: string): Map<string, PendingLine> {
    let nodeBuffers = buffers.get(executionId);
    if (!nodeBuffers) {
      nodeBuffers = new Map<string, PendingLine>();
      buffers.set(executionId, nodeBuffers);
    }
    return nodeBuffers;
  }

  function nestedLabel(
    executionId: string,
    nodeId: string,
    parentToolCallId: string | undefined,
  ): string | undefined {
    if (!parentToolCallId) return undefined;
    return subagents.get(executionId)?.get(streamKey(nodeId, parentToolCallId))
      ?? `subagent:${label(parentToolCallId)}`;
  }

  function linePrefix(
    executionId: string,
    nodeId: string,
    parentToolCallId?: string,
  ): string {
    const agentName = nestedLabel(executionId, nodeId, parentToolCallId);
    if (agentName) return `[${label(nodeId)}/${label(agentName)}] `;
    if (activeTurns.get(executionId)?.has(nodeId)) return '   ';
    return `[${label(nodeId)}] `;
  }

  function outputStreamKey(nodeId: string, parentToolCallId?: string): string {
    return streamKey('output', nodeId, parentToolCallId ?? '');
  }

  function flushPendingLine(executionId: string, streamKey: string): void {
    const nodeBuffers = buffers.get(executionId);
    const pending = nodeBuffers?.get(streamKey);
    if (!nodeBuffers || !pending) return;

    nodeBuffers.delete(streamKey);
    if (nodeBuffers.size === 0) buffers.delete(executionId);

    if (pending.privateKey) {
      writeLine(pending.prefix, REDACTED);
      return;
    }

    let content = redactKnownSecrets(pending.content, knownSecrets);
    if (useBuiltInRedactor) content = redactConsoleOutput(content);
    let newlineIndex = content.indexOf('\n');
    while (newlineIndex >= 0) {
      writeLine(pending.prefix, content.slice(0, newlineIndex));
      content = content.slice(newlineIndex + 1);
      newlineIndex = content.indexOf('\n');
    }
    if (content.length > 0) writeLine(pending.prefix, content);
  }

  function renderStream(
    event: StreamedOutputEvent,
    streamKey: string,
    prefix: string,
  ): void {
    const nodeBuffers = getNodeBuffers(event.executionId);
    const pending = nodeBuffers.get(streamKey);
    let content = (pending?.content ?? '') + event.content;
    let privateKey = pending?.privateKey === true;
    const boundary = safeEmissionBoundary(content, knownSecrets, useBuiltInRedactor);
    let emitted = redactKnownSecrets(content.slice(0, boundary), knownSecrets);
    content = content.slice(boundary);
    let newlineIndex = emitted.indexOf('\n');

    while (newlineIndex >= 0) {
      const line = emitted.slice(0, newlineIndex);
      emitted = emitted.slice(newlineIndex + 1);

      if (useBuiltInRedactor && privateKey) {
        if (PRIVATE_KEY_END.test(line)) {
          writeLine(prefix, REDACTED);
          privateKey = false;
        }
      } else if (
        useBuiltInRedactor
        && PRIVATE_KEY_BEGIN.test(line)
        && !PRIVATE_KEY_END.test(line)
      ) {
        privateKey = true;
      } else {
        writeLine(prefix, line);
      }

      newlineIndex = emitted.indexOf('\n');
    }

    const currentNodeBuffers = getNodeBuffers(event.executionId);
    if (content.length > 0 || privateKey) {
      currentNodeBuffers.set(streamKey, {
        nodeId: event.nodeId,
        content,
        prefix,
        privateKey,
      });
    } else {
      currentNodeBuffers.delete(streamKey);
      if (currentNodeBuffers.size === 0) buffers.delete(event.executionId);
    }
  }

  function flushOutputStream(
    executionId: string,
    nodeId: string,
    parentToolCallId?: string,
  ): void {
    flushPendingLine(executionId, outputStreamKey(nodeId, parentToolCallId));
  }

  function renderPrompt(event: NodePromptEvent): void {
    flushNode(event.executionId, event.nodeId);
    writeLine('', `\n── ${label(event.nodeId)} · ${label(event.role)} · ${label(event.model)} ──`);
    if (options.renderPrompts !== false) {
      writeLine('', '   REQUEST');
      const requestKey = streamKey('prompt', event.nodeId, String(event.ts));
      renderStream(event, requestKey, '   ');
      flushPendingLine(event.executionId, requestKey);
    }
    writeLine('', '   RESPONSE');

    let nodes = activeTurns.get(event.executionId);
    if (!nodes) {
      nodes = new Set<string>();
      activeTurns.set(event.executionId, nodes);
    }
    nodes.add(event.nodeId);
  }

  function renderTool(event: NodeToolEvent): void {
    if (event.phase === 'complete') return;
    flushOutputStream(event.executionId, event.nodeId, event.parentToolCallId);
    const source = event.summary.trim().length > 0 ? event.summary : safeStringify(event.args);
    const prefix = `${linePrefix(
      event.executionId,
      event.nodeId,
      event.parentToolCallId,
    )}→ ${label(event.tool)}${source.trim().length > 0 ? ' ' : ''}`;
    writeCompactLine(prefix, source);
  }

  function renderToolOutput(event: NodeOutputEvent): void {
    if (!event.tool || toolOutputMode === 'hidden') return;
    flushOutputStream(event.executionId, event.nodeId, event.parentToolCallId);
    const prefix = `${linePrefix(
      event.executionId,
      event.nodeId,
      event.parentToolCallId,
    )}← ${label(event.tool)}${event.content.length > 0 ? ' ' : ''}`;

    if (toolOutputMode === 'preview') {
      writeCompactLine(prefix, event.content);
      return;
    }

    const key = streamKey(
      'tool-output',
      event.nodeId,
      event.parentToolCallId ?? '',
      event.tool,
    );
    renderStream(event, key, prefix);
  }

  function rememberSubagent(event: Extract<OutputEvent, { readonly type: 'node:subagent' }>): void {
    if (!event.toolCallId) return;
    let executionSubagents = subagents.get(event.executionId);
    if (!executionSubagents) {
      executionSubagents = new Map<string, string>();
      subagents.set(event.executionId, executionSubagents);
    }
    executionSubagents.set(streamKey(event.nodeId, event.toolCallId), event.agentName);
  }

  const emitOutput: OutputEventSink = (event) => {
    try {
      switch (event.type) {
        case 'node:prompt':
          renderPrompt(event);
          break;
        case 'node:subagent':
          rememberSubagent(event);
          break;
        case 'node:tool':
          renderTool(event);
          break;
        case 'node:output':
          if (event.tool) {
            renderToolOutput(event);
          } else {
            const streamKey = outputStreamKey(event.nodeId, event.parentToolCallId);
            renderStream(
              event,
              streamKey,
              linePrefix(event.executionId, event.nodeId, event.parentToolCallId),
            );
          }
          break;
        case 'node:reasoning':
          if (options.renderReasoning === true) {
            const streamKey = outputStreamKey(event.nodeId);
            renderStream(event, streamKey, linePrefix(event.executionId, event.nodeId));
          }
          break;
        default:
          break;
      }
    } catch {
      // Output rendering must never interrupt an execution.
    }
  };

  const flushNode = (executionId: string, nodeId: string): void => {
    try {
      const nodeBuffers = buffers.get(executionId);
      if (!nodeBuffers) return;
      for (const [streamKey, pending] of [...nodeBuffers.entries()]) {
        if (pending.nodeId === nodeId) flushPendingLine(executionId, streamKey);
      }
    } catch {
      // Output rendering must never interrupt an execution.
    }
  };

  const flushExecution = (executionId: string): void => {
    try {
      const nodeBuffers = buffers.get(executionId);
      if (nodeBuffers) {
        for (const streamKey of [...nodeBuffers.keys()]) {
          flushPendingLine(executionId, streamKey);
        }
      }
    } catch {
      // Output rendering must never interrupt an execution.
      buffers.delete(executionId);
    } finally {
      subagents.delete(executionId);
      activeTurns.delete(executionId);
    }
  };

  const flush = (): void => {
    try {
      const executionIds = new Set([
        ...buffers.keys(),
        ...subagents.keys(),
        ...activeTurns.keys(),
      ]);
      for (const executionId of executionIds) flushExecution(executionId);
    } catch {
      // Output rendering must never interrupt an execution.
      buffers.clear();
      subagents.clear();
      activeTurns.clear();
    }
  };

  return { emitOutput, flushNode, flushExecution, flush };
}
