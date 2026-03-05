/**
 * File-based StorageEngine — JSONL event logs, atomic projection writes,
 * per-node output files, flat artifact files.
 *
 * Directory structure:
 *   {rootDir}/{execId}/events.jsonl
 *   {rootDir}/{execId}/projection.json
 *   {rootDir}/{execId}/artifacts/{nodeId}/{name}
 *   {rootDir}/{execId}/output/{nodeId}.log
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  StorageEngine,
  ExecutionProjection,
  OutputPage,
} from '../src/types';
import type { ExecutionEvent } from '../src/events';

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

function safePath(base: string, ...segments: string[]): string {
  const joined = path.resolve(base, ...segments);
  const normalizedBase = path.resolve(base);
  if (!joined.startsWith(normalizedBase + path.sep) && joined !== normalizedBase) {
    throw new Error(`Path traversal attempt: ${segments.join('/')} escapes ${base}`);
  }
  return joined;
}

// ---------------------------------------------------------------------------
// FileStorage
// ---------------------------------------------------------------------------

export class FileStorage implements StorageEngine {
  constructor(private readonly rootDir: string) {}

  private execDir(execId: string): string {
    return safePath(this.rootDir, execId);
  }

  appendEvent(execId: string, event: ExecutionEvent): void {
    const dir = this.execDir(execId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'events.jsonl');
    fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf-8');
  }

  readEvents(execId: string): ExecutionEvent[] {
    const file = path.join(this.execDir(execId), 'events.jsonl');
    if (!fs.existsSync(file)) return [];
    const content = fs.readFileSync(file, 'utf-8');
    const events: ExecutionEvent[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as ExecutionEvent);
      } catch {
        // Skip malformed lines (crash safety — truncated writes)
      }
    }
    return events;
  }

  writeProjection(execId: string, projection: ExecutionProjection): void {
    const dir = this.execDir(execId);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'projection.json');
    const tmp = path.join(dir, `projection.json.tmp.${process.pid}`);
    fs.writeFileSync(tmp, JSON.stringify(projection, null, 2), 'utf-8');
    fs.renameSync(tmp, target);
  }

  readProjection(execId: string): ExecutionProjection | null {
    const file = path.join(this.execDir(execId), 'projection.json');
    if (!fs.existsSync(file)) return null;
    try {
      const content = fs.readFileSync(file, 'utf-8');
      return JSON.parse(content) as ExecutionProjection;
    } catch {
      return null;
    }
  }

  writeArtifact(execId: string, nodeId: string, name: string, content: string): void {
    const dir = safePath(this.execDir(execId), 'artifacts', nodeId);
    fs.mkdirSync(dir, { recursive: true });
    const file = safePath(dir, name);
    fs.writeFileSync(file, content, 'utf-8');
  }

  readArtifact(execId: string, nodeId: string, name: string): string | null {
    const file = safePath(this.execDir(execId), 'artifacts', nodeId, name);
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf-8');
  }

  appendOutput(execId: string, nodeId: string, line: string): void {
    const dir = safePath(this.execDir(execId), 'output');
    fs.mkdirSync(dir, { recursive: true });
    const file = safePath(dir, `${nodeId}.log`);
    fs.appendFileSync(file, line + '\n', 'utf-8');
  }

  readOutput(execId: string, nodeId: string, offset?: number, limit?: number): OutputPage {
    const file = safePath(this.execDir(execId), 'output', `${nodeId}.log`);
    if (!fs.existsSync(file)) {
      return { lines: [], offset: offset ?? 0, total: 0, hasMore: false };
    }
    const content = fs.readFileSync(file, 'utf-8');
    // Split and drop trailing empty line from final newline
    const all = content.split('\n');
    if (all.length > 0 && all[all.length - 1] === '') {
      all.pop();
    }
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

  closeOutput(_execId: string, _nodeId: string): void {
    // No-op for file storage — we use appendFileSync, no streams to close
  }

  delete(execId: string): boolean {
    const dir = this.execDir(execId);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  listExecutionIds(): string[] {
    if (!fs.existsSync(this.rootDir)) return [];
    return fs
      .readdirSync(this.rootDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }
}
