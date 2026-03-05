import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileStorage } from '../state/storage';
import { MemoryStorage } from '../state/storage-memory';
import { createEmptyProjection } from '../state/reducer';
import type { ExecutionEvent } from '../src/events';
import type { ExecutionProjection, StorageEngine } from '../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sampleEvent(executionId = 'exec-1'): ExecutionEvent {
  return {
    type: 'run:started',
    executionId,
    flowId: 'test-flow',
    params: { x: 1 },
    graph: {
      nodes: [{ id: 'A', displayName: 'Node A', nodeType: 'agent' }],
      edges: [{ source: 'A', action: 'default', target: 'end' }],
    },
    ts: 1000,
  };
}

function sampleProjection(id = 'exec-1'): ExecutionProjection {
  return {
    ...createEmptyProjection(id, 'test-flow'),
    status: 'running',
    startedAt: 1000,
  };
}

// ---------------------------------------------------------------------------
// FileStorage tests
// ---------------------------------------------------------------------------

describe('FileStorage', () => {
  let tmpDir: string;
  let storage: FileStorage;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-storage-'));
    storage = new FileStorage(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('append + read events (JSONL round-trip)', () => {
    const ev1 = sampleEvent();
    const ev2: ExecutionEvent = {
      type: 'node:started',
      executionId: 'exec-1',
      nodeId: 'A',
      ts: 2000,
    };
    storage.appendEvent('exec-1', ev1);
    storage.appendEvent('exec-1', ev2);

    const events = storage.readEvents('exec-1');
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('run:started');
    expect(events[1].type).toBe('node:started');
  });

  it('write + read projection (atomic)', () => {
    const proj = sampleProjection();
    storage.writeProjection('exec-1', proj);

    const read = storage.readProjection('exec-1');
    expect(read).not.toBeNull();
    expect(read!.id).toBe('exec-1');
    expect(read!.status).toBe('running');

    // Verify no tmp file remains
    const dir = path.join(tmpDir, 'exec-1');
    const files = fs.readdirSync(dir);
    expect(files.filter((f) => f.includes('.tmp.'))).toHaveLength(0);
  });

  it('write + read artifact', () => {
    storage.writeArtifact('exec-1', 'A', 'report.md', '# Report\nAll good.');
    const content = storage.readArtifact('exec-1', 'A', 'report.md');
    expect(content).toBe('# Report\nAll good.');

    // Non-existent artifact returns null
    expect(storage.readArtifact('exec-1', 'A', 'missing.md')).toBeNull();
  });

  it('output append + read with pagination', () => {
    for (let i = 0; i < 10; i++) {
      storage.appendOutput('exec-1', 'A', `line-${i}`);
    }

    // Full read
    const all = storage.readOutput('exec-1', 'A');
    expect(all.lines).toHaveLength(10);
    expect(all.total).toBe(10);
    expect(all.hasMore).toBe(false);
    expect(all.offset).toBe(0);

    // Paginated read
    const page1 = storage.readOutput('exec-1', 'A', 0, 3);
    expect(page1.lines).toEqual(['line-0', 'line-1', 'line-2']);
    expect(page1.hasMore).toBe(true);
    expect(page1.total).toBe(10);

    const page2 = storage.readOutput('exec-1', 'A', 3, 3);
    expect(page2.lines).toEqual(['line-3', 'line-4', 'line-5']);
    expect(page2.hasMore).toBe(true);

    const lastPage = storage.readOutput('exec-1', 'A', 9, 5);
    expect(lastPage.lines).toEqual(['line-9']);
    expect(lastPage.hasMore).toBe(false);
  });

  it('safePath prevents directory traversal', () => {
    expect(() => {
      storage.writeArtifact('exec-1', '..', '../../etc/passwd', 'bad');
    }).toThrow(/traversal/i);
  });

  it('delete removes all data', () => {
    storage.appendEvent('exec-1', sampleEvent());
    storage.writeProjection('exec-1', sampleProjection());
    storage.writeArtifact('exec-1', 'A', 'out.md', 'content');

    const deleted = storage.delete('exec-1');
    expect(deleted).toBe(true);
    expect(storage.readEvents('exec-1')).toEqual([]);
    expect(storage.readProjection('exec-1')).toBeNull();

    // Delete non-existent returns false
    expect(storage.delete('exec-999')).toBe(false);
  });

  it('listExecutionIds', () => {
    storage.appendEvent('exec-1', sampleEvent('exec-1'));
    storage.appendEvent('exec-2', sampleEvent('exec-2'));

    const ids = storage.listExecutionIds();
    expect(ids.sort()).toEqual(['exec-1', 'exec-2']);
  });

  it('truncated JSONL line is skipped (crash safety)', () => {
    // Write a valid event, then append a truncated line
    storage.appendEvent('exec-1', sampleEvent());
    const jsonlPath = path.join(tmpDir, 'exec-1', 'events.jsonl');
    fs.appendFileSync(jsonlPath, '{"type":"node:star\n', 'utf-8'); // truncated

    const events = storage.readEvents('exec-1');
    expect(events).toHaveLength(1); // Only the valid event
    expect(events[0].type).toBe('run:started');
  });
});

// ---------------------------------------------------------------------------
// MemoryStorage tests
// ---------------------------------------------------------------------------

describe('MemoryStorage', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('basic CRUD operations', () => {
    // Events
    storage.appendEvent('exec-1', sampleEvent());
    expect(storage.readEvents('exec-1')).toHaveLength(1);

    // Projection
    storage.writeProjection('exec-1', sampleProjection());
    expect(storage.readProjection('exec-1')!.status).toBe('running');

    // Artifact
    storage.writeArtifact('exec-1', 'A', 'out.md', 'content');
    expect(storage.readArtifact('exec-1', 'A', 'out.md')).toBe('content');

    // Output
    storage.appendOutput('exec-1', 'A', 'line 1');
    storage.appendOutput('exec-1', 'A', 'line 2');
    const output = storage.readOutput('exec-1', 'A', 0, 1);
    expect(output.lines).toEqual(['line 1']);
    expect(output.hasMore).toBe(true);
    expect(output.total).toBe(2);

    // Delete
    expect(storage.delete('exec-1')).toBe(true);
    expect(storage.readEvents('exec-1')).toEqual([]);
    expect(storage.readProjection('exec-1')).toBeNull();

    // List
    expect(storage.listExecutionIds()).toEqual([]);
  });

  it('isolation between executions', () => {
    storage.appendEvent('exec-1', sampleEvent('exec-1'));
    storage.appendEvent('exec-2', sampleEvent('exec-2'));
    storage.writeArtifact('exec-1', 'A', 'out.md', 'content-1');
    storage.writeArtifact('exec-2', 'A', 'out.md', 'content-2');

    expect(storage.readEvents('exec-1')).toHaveLength(1);
    expect(storage.readEvents('exec-2')).toHaveLength(1);
    expect(storage.readArtifact('exec-1', 'A', 'out.md')).toBe('content-1');
    expect(storage.readArtifact('exec-2', 'A', 'out.md')).toBe('content-2');

    // Deleting exec-1 doesn't affect exec-2
    storage.delete('exec-1');
    expect(storage.readEvents('exec-1')).toEqual([]);
    expect(storage.readEvents('exec-2')).toHaveLength(1);
    expect(storage.readArtifact('exec-2', 'A', 'out.md')).toBe('content-2');
  });

  it('empty reads return defaults', () => {
    expect(storage.readEvents('nonexistent')).toEqual([]);
    expect(storage.readProjection('nonexistent')).toBeNull();
    expect(storage.readArtifact('nonexistent', 'A', 'x')).toBeNull();
    const output = storage.readOutput('nonexistent', 'A');
    expect(output).toEqual({ lines: [], offset: 0, total: 0, hasMore: false });
  });
});
