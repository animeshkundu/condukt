/**
 * StateRuntime — coordinates event flow, projection caching, and storage.
 *
 * Sits between the execution layer (which emits events) and the API layer
 * (which serves projections). Uses a StorageEngine for persistence and
 * an in-memory cache for fast reads.
 */

import type {
  StorageEngine,
  ExecutionProjection,
  OutputPage,
} from '../src/types';
import type { ExecutionEvent, OutputEvent } from '../src/events';
import { reduce, createEmptyProjection, replayEvents } from './reducer';

export class StateRuntime {
  private cache = new Map<string, ExecutionProjection>();
  // SYS-1: Per-execution async mutex — serializes events for each execution
  private locks = new Map<string, Promise<void>>();

  constructor(
    private readonly storage: StorageEngine,
    private readonly onEvent?: (event: ExecutionEvent) => void,
    private readonly onOutput?: (event: OutputEvent) => void,
  ) {}

  // -------------------------------------------------------------------------
  // Command handlers
  // -------------------------------------------------------------------------

  async handleEvent(event: ExecutionEvent): Promise<void> {
    const id = event.executionId;

    // SYS-1: Serialize events per-execution via promise chain
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.then(() => this._applyEvent(event));
    this.locks.set(id, next.catch(() => { /* swallow to keep chain alive */ }));
    await next;
  }

  private _applyEvent(event: ExecutionEvent): void {
    const id = event.executionId;

    // 1. Append to event log
    this.storage.appendEvent(id, event);

    // 2. Get or create projection
    let projection = this.cache.get(id) ?? createEmptyProjection(id);

    // 3. Reduce
    projection = reduce(projection, event);

    // 4. Write projection
    this.storage.writeProjection(id, projection);

    // 5. Update cache
    this.cache.set(id, projection);

    // 6. Notify listeners
    this.onEvent?.(event);
  }

  handleOutput(event: OutputEvent): void {
    if (event.type === 'node:output' && event.content) {
      if (event.tool) {
        // Tool-attributed output: encode with tool name for per-tool classification
        this.storage.appendOutput(event.executionId, event.nodeId,
          `\x00tool:output\x00${event.tool}\x00${event.content}`);
      } else {
        this.storage.appendOutput(event.executionId, event.nodeId, event.content);
      }
    } else if (event.type === 'node:reasoning' && event.content) {
      this.storage.appendOutput(event.executionId, event.nodeId, '\x00reasoning\x00' + event.content);
    } else if (event.type === 'node:tool') {
      this.storage.appendOutput(event.executionId, event.nodeId,
        `\x00tool:${event.phase}\x00${event.tool}\x00${event.summary}`);
    }
    this.onOutput?.(event);
  }

  writeArtifact(execId: string, nodeId: string, name: string, content: string): void {
    this.storage.writeArtifact(execId, nodeId, name, content);
  }

  // -------------------------------------------------------------------------
  // Query handlers
  // -------------------------------------------------------------------------

  getProjection(id: string): ExecutionProjection | null {
    return this.cache.get(id) ?? this.storage.readProjection(id);
  }

  listExecutions(): ExecutionProjection[] {
    return Array.from(this.cache.values());
  }

  getNodeOutput(execId: string, nodeId: string, offset?: number, limit?: number): OutputPage {
    return this.storage.readOutput(execId, nodeId, offset, limit);
  }

  getArtifact(execId: string, nodeId: string, name: string): string | null {
    return this.storage.readArtifact(execId, nodeId, name);
  }

  readEvents(execId: string): ExecutionEvent[] {
    return this.storage.readEvents(execId);
  }

  // -------------------------------------------------------------------------
  // Recovery
  // -------------------------------------------------------------------------

  rebuildProjection(execId: string): ExecutionProjection {
    const events = this.storage.readEvents(execId);
    const projection = replayEvents(execId, events);
    this.storage.writeProjection(execId, projection);
    this.cache.set(execId, projection);
    return projection;
  }

  /** R12a: Hydrate cache from storage. R12b: Mark running executions as crashed. */
  recoverOnStartup(): void {
    for (const id of this.storage.listExecutionIds()) {
      // SYS-5: Replay from event log (source of truth), not disk projection
      const events = this.storage.readEvents(id);
      let projection: ExecutionProjection;
      if (events.length > 0) {
        projection = replayEvents(id, events);
      } else {
        // Fallback to disk projection if event log is empty (legacy data)
        const diskProjection = this.storage.readProjection(id);
        if (!diskProjection) continue;
        projection = diskProjection;
      }

      if (projection.status === 'running') {
        // R12b: Append crash event and update projection
        const crashEvent: ExecutionEvent = {
          type: 'run:completed',
          executionId: id,
          status: 'crashed',
          ts: Date.now(),
        };
        this.storage.appendEvent(id, crashEvent);
        projection = reduce(projection, crashEvent);
      }

      this.storage.writeProjection(id, projection);
      this.cache.set(id, projection);
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  delete(execId: string): boolean {
    this.cache.delete(execId);
    return this.storage.delete(execId);
  }

  shutdown(): void {
    for (const id of this.cache.keys()) {
      const projection = this.cache.get(id);
      if (projection) {
        for (const node of projection.graph.nodes) {
          this.storage.closeOutput(id, node.id);
        }
      }
    }
  }
}
