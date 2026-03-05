/**
 * In-memory StorageEngine implementation — zero I/O, for tests.
 */

import type {
  StorageEngine,
  ExecutionProjection,
  OutputPage,
} from '../src/types';
import type { ExecutionEvent } from '../src/events';

export class MemoryStorage implements StorageEngine {
  private events = new Map<string, ExecutionEvent[]>();
  private projections = new Map<string, ExecutionProjection>();
  private artifacts = new Map<string, string>();
  private outputs = new Map<string, string[]>();
  private closedOutputs = new Set<string>();

  appendEvent(execId: string, event: ExecutionEvent): void {
    const arr = this.events.get(execId) ?? [];
    arr.push(event);
    this.events.set(execId, arr);
  }

  readEvents(execId: string): ExecutionEvent[] {
    return [...(this.events.get(execId) ?? [])];
  }

  writeProjection(execId: string, projection: ExecutionProjection): void {
    this.projections.set(execId, projection);
  }

  readProjection(execId: string): ExecutionProjection | null {
    return this.projections.get(execId) ?? null;
  }

  writeArtifact(execId: string, nodeId: string, name: string, content: string): void {
    this.artifacts.set(`${execId}:${nodeId}:${name}`, content);
  }

  readArtifact(execId: string, nodeId: string, name: string): string | null {
    return this.artifacts.get(`${execId}:${nodeId}:${name}`) ?? null;
  }

  appendOutput(execId: string, nodeId: string, line: string): void {
    const key = `${execId}:${nodeId}`;
    const arr = this.outputs.get(key) ?? [];
    arr.push(line);
    this.outputs.set(key, arr);
  }

  readOutput(execId: string, nodeId: string, offset?: number, limit?: number): OutputPage {
    const key = `${execId}:${nodeId}`;
    const all = this.outputs.get(key) ?? [];
    const start = offset ?? 0;
    const end = limit != null ? start + limit : all.length;
    const lines = all.slice(start, end);
    return {
      lines,
      offset: start,
      total: all.length,
      hasMore: end < all.length,
    };
  }

  closeOutput(execId: string, nodeId: string): void {
    this.closedOutputs.add(`${execId}:${nodeId}`);
  }

  delete(execId: string): boolean {
    let deleted = false;
    if (this.events.delete(execId)) deleted = true;
    if (this.projections.delete(execId)) deleted = true;
    // Clean up artifacts and outputs with matching prefix
    for (const key of this.artifacts.keys()) {
      if (key.startsWith(`${execId}:`)) {
        this.artifacts.delete(key);
        deleted = true;
      }
    }
    for (const key of this.outputs.keys()) {
      if (key.startsWith(`${execId}:`)) {
        this.outputs.delete(key);
        deleted = true;
      }
    }
    for (const key of this.closedOutputs) {
      if (key.startsWith(`${execId}:`)) {
        this.closedOutputs.delete(key);
      }
    }
    return deleted;
  }

  listExecutionIds(): string[] {
    // Union of all keys that have events or projections
    const ids = new Set<string>([
      ...this.events.keys(),
      ...this.projections.keys(),
    ]);
    return [...ids];
  }
}
