import type { OutputEvent } from './events';

export type OutputEventSink = (event: OutputEvent) => void;

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
  readonly type: RenderableOutputEvent['type'];
  readonly content: string;
};

/**
 * Creates a plain-text OutputEvent renderer that writes attributed lines to stdout.
 * Call flushNode at a node lifecycle boundary, or flush after the run, to write any
 * final unterminated line.
 */
export function createConsoleOutputRenderer(): ConsoleOutputRenderer {
  const buffers = new Map<string, Map<string, PendingLine>>();

  function safeWrite(value: string): void {
    try {
      process.stdout.write(value);
    } catch {
      // Output rendering must never interrupt an execution.
    }
  }

  function writeLine(nodeId: string, content: string): void {
    const safeNodeId = nodeId.replace(/[\r\n]/g, ' ');
    safeWrite(`[${safeNodeId}] ${content}\n`);
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

    if (pending.content.length > 0) {
      const content = pending.content.endsWith('\r')
        ? pending.content.slice(0, -1)
        : pending.content;
      writeLine(nodeId, content);
    }
  }

  function render(event: RenderableOutputEvent): void {
    const nodeBuffers = getNodeBuffers(event.executionId);
    const pending = nodeBuffers.get(event.nodeId);

    if (pending && pending.type !== event.type) {
      flushPendingLine(event.executionId, event.nodeId);
    }

    let content = (pending?.type === event.type ? pending.content : '') + event.content;
    let newlineIndex = content.indexOf('\n');

    while (newlineIndex >= 0) {
      let line = content.slice(0, newlineIndex);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      writeLine(event.nodeId, line);
      content = content.slice(newlineIndex + 1);
      newlineIndex = content.indexOf('\n');
    }

    const currentNodeBuffers = getNodeBuffers(event.executionId);
    if (content.length > 0) {
      currentNodeBuffers.set(event.nodeId, { type: event.type, content });
    } else {
      currentNodeBuffers.delete(event.nodeId);
      if (currentNodeBuffers.size === 0) buffers.delete(event.executionId);
    }
  }

  const emitOutput: OutputEventSink = (event) => {
    try {
      if (event.type === 'node:output' || event.type === 'node:reasoning') {
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
