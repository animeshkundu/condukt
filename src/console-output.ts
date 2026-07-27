import type { OutputEvent } from './events';

export type OutputEventSink = (event: OutputEvent) => void;
export type OutputRedactor = (value: string) => string;

export interface ConsoleOutputOptions {
  /** Literal values known by the consumer to be secrets. */
  readonly knownSecrets?: readonly string[];
  /** Replaces the built-in redactor. Known secrets are still scrubbed afterward. */
  readonly redactor?: OutputRedactor;
  /** Render node:reasoning events. Defaults to false. */
  readonly renderReasoning?: boolean;
}

export interface ConsoleOutputRenderer {
  readonly emitOutput: OutputEventSink;
  readonly flushNode: (executionId: string, nodeId: string) => void;
  readonly flushExecution: (executionId: string) => void;
  readonly flush: () => void;
}

type RenderableOutputEvent = Extract<
  OutputEvent,
  { readonly type: 'node:output' | 'node:reasoning' }
>;

type PendingLine = {
  readonly content: string;
  readonly privateKey?: boolean;
};

const REDACTED = '[REDACTED]';
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

/**
 * Creates a plain-text OutputEvent renderer that writes attributed lines to stdout.
 * Call flushNode at a node lifecycle boundary, or flush after the run, to write any
 * final unterminated line.
 */
export function createConsoleOutputRenderer(
  options: ConsoleOutputOptions = {},
): ConsoleOutputRenderer {
  const buffers = new Map<string, Map<string, PendingLine>>();
  const useBuiltInRedactor = options.redactor === undefined;
  const redact = options.redactor ?? redactConsoleOutput;
  const knownSecrets = options.knownSecrets ?? [];

  function safeWrite(value: string): void {
    try {
      process.stdout.write(value);
    } catch {
      // Output rendering must never interrupt an execution.
    }
  }

  function writeLine(nodeId: string, content: string): void {
    try {
      const safeNodeId = nodeId.replace(/[\r\n]/g, ' ');
      const attributed = `[${safeNodeId}] ${content}`;
      // Redact every byte destined for stdout before any subsequent slicing.
      const redacted = redactKnownSecrets(redact(attributed), knownSecrets);
      const normalized = redacted.endsWith('\r') ? redacted.slice(0, -1) : redacted;
      safeWrite(`${normalized}\n`);
    } catch {
      // Output rendering must never interrupt an execution.
    }
  }

  function getNodeBuffers(executionId: string): Map<string, PendingLine> {
    let nodeBuffers = buffers.get(executionId);
    if (!nodeBuffers) {
      nodeBuffers = new Map<string, PendingLine>();
      buffers.set(executionId, nodeBuffers);
    }
    return nodeBuffers;
  }

  function flushPendingLine(executionId: string, nodeId: string): void {
    const nodeBuffers = buffers.get(executionId);
    const pending = nodeBuffers?.get(nodeId);
    if (!nodeBuffers || !pending) return;

    nodeBuffers.delete(nodeId);
    if (nodeBuffers.size === 0) buffers.delete(executionId);

    if (pending.privateKey) {
      writeLine(nodeId, REDACTED);
      return;
    }

    let content = redactKnownSecrets(pending.content, knownSecrets);
    if (useBuiltInRedactor) content = redactConsoleOutput(content);
    let newlineIndex = content.indexOf('\n');
    while (newlineIndex >= 0) {
      writeLine(nodeId, content.slice(0, newlineIndex));
      content = content.slice(newlineIndex + 1);
      newlineIndex = content.indexOf('\n');
    }
    if (content.length > 0) writeLine(nodeId, content);
  }

  function render(event: RenderableOutputEvent): void {
    const nodeBuffers = getNodeBuffers(event.executionId);
    const pending = nodeBuffers.get(event.nodeId);
    let content = (pending?.content ?? '') + event.content;
    let privateKey = pending?.privateKey === true;
    const boundary = safeEmissionBoundary(content, knownSecrets, useBuiltInRedactor);
    let emitted = redactKnownSecrets(content.slice(0, boundary), knownSecrets);
    content = content.slice(boundary);
    let newlineIndex = emitted.indexOf('\n');

    while (newlineIndex >= 0) {
      let line = emitted.slice(0, newlineIndex);
      emitted = emitted.slice(newlineIndex + 1);

      if (useBuiltInRedactor && privateKey) {
        if (PRIVATE_KEY_END.test(line)) {
          writeLine(event.nodeId, REDACTED);
          privateKey = false;
        }
      } else if (
        useBuiltInRedactor
        && PRIVATE_KEY_BEGIN.test(line)
        && !PRIVATE_KEY_END.test(line)
      ) {
        privateKey = true;
      } else {
        writeLine(event.nodeId, line);
      }

      newlineIndex = emitted.indexOf('\n');
    }

    const currentNodeBuffers = getNodeBuffers(event.executionId);
    if (content.length > 0 || privateKey) {
      currentNodeBuffers.set(event.nodeId, { content, privateKey });
    } else {
      currentNodeBuffers.delete(event.nodeId);
      if (currentNodeBuffers.size === 0) buffers.delete(event.executionId);
    }
  }

  const emitOutput: OutputEventSink = (event) => {
    try {
      if (
        event.type === 'node:output'
        || (event.type === 'node:reasoning' && options.renderReasoning === true)
      ) {
        render(event);
      }
    } catch {
      // Output rendering must never interrupt an execution.
    }
  };

  const flushNode = (executionId: string, nodeId: string): void => {
    try {
      flushPendingLine(executionId, nodeId);
    } catch {
      // Output rendering must never interrupt an execution.
    }
  };

  const flushExecution = (executionId: string): void => {
    try {
      const nodeBuffers = buffers.get(executionId);
      if (!nodeBuffers) return;

      for (const nodeId of [...nodeBuffers.keys()]) {
        flushPendingLine(executionId, nodeId);
      }
    } catch {
      // Output rendering must never interrupt an execution.
      buffers.delete(executionId);
    }
  };

  const flush = (): void => {
    try {
      for (const executionId of [...buffers.keys()]) {
        flushExecution(executionId);
      }
    } catch {
      // Output rendering must never interrupt an execution.
      buffers.clear();
    }
  };

  return { emitOutput, flushNode, flushExecution, flush };
}
