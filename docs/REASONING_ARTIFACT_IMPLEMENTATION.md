# Reasoning Visibility & Artifact Tab: Implementation Guide

> This is the implementation specification for agent teams. Each section is a self-contained brief.

## Repository: `Q:\Software\investigation\condukt\`

---

## Phase 1: Core Transport (WS-1) — DONE

### TASK 1A: StateRuntime `onOutput` Callback

**Modify** `state/state-runtime.ts`:

Constructor change (line 22-25):
```typescript
// Before:
constructor(
  private readonly storage: StorageEngine,
  private readonly onEvent?: (event: ExecutionEvent) => void,
) {}

// After:
constructor(
  private readonly storage: StorageEngine,
  private readonly onEvent?: (event: ExecutionEvent) => void,
  private readonly onOutput?: (event: OutputEvent) => void,
) {}
```

handleOutput change (line 63-67):
```typescript
// Before:
handleOutput(event: OutputEvent): void {
  if (event.type === 'node:output') {
    this.storage.appendOutput(event.executionId, event.nodeId, event.content);
  }
}

// After:
handleOutput(event: OutputEvent): void {
  if (event.type === 'node:output' || event.type === 'node:reasoning') {
    const prefix = event.type === 'node:reasoning' ? '\x00reasoning\x00' : '';
    this.storage.appendOutput(event.executionId, event.nodeId, prefix + event.content);
  }
  this.onOutput?.(event);
}
```

**Acceptance**: `npm test -- state-runtime` passes, `npm run typecheck` passes.

---

### TASK 1B: SSE Replay Reconstruction

**Modify** `bridge/sse.ts` — `createNodeSSEStream()` replay function (lines 126-142):

```typescript
// Before:
for (const line of page.lines) {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify({
    type: 'node:output', executionId, nodeId, content: line, ts: 0,
  })}\n\n`));
}

// After:
const REASONING_PREFIX = '\x00reasoning\x00';
for (const line of page.lines) {
  const isReasoning = line.startsWith(REASONING_PREFIX);
  const content = isReasoning ? line.slice(REASONING_PREFIX.length) : line;
  const type = isReasoning ? 'node:reasoning' : 'node:output';
  controller.enqueue(encoder.encode(`data: ${JSON.stringify({
    type, executionId, nodeId, content, ts: 0,
  })}\n\n`));
}
```

**Acceptance**: `npm test -- sse` passes.

---

## Phase 1: UI Components (WS-2) — DONE

### TASK 2A: useNodeOutput Reasoning

**Modify** `ui/hooks/useNodeOutput.ts` (line 59):

```typescript
// Before:
if (data.type === 'node:output' && data.content) {
  setLines((prev) => [...prev, data.content]);

// After:
if ((data.type === 'node:output' || data.type === 'node:reasoning') && data.content) {
  const line = data.type === 'node:reasoning'
    ? `\x1b[2m[thinking] ${data.content}\x1b[0m`
    : data.content;
  setLines((prev) => [...prev, line]);
```

### TASK 2B: useNodeArtifact Hook

**Create** `ui/hooks/useNodeArtifact.ts` — React hook for artifact fetching. Supports `urlBuilder` for non-standard routes. Returns `{ content, loading, error, refetch }`. See DESIGN.md §5.

### TASK 2C: MarkdownContent Component

**Create** `ui/components/MarkdownContent.tsx` — Regex-based markdown renderer with HTML escaping. Handles `##` headings, fenced code blocks, blockquotes, tables, paragraphs. See DESIGN.md §6.

### TASK 2D: NodePanel.Artifact

**Create** `ui/components/node-panel/Artifact.tsx` — Compound component with loading/empty/content states. Wire into `NodePanel` via `node-panel/index.tsx`. See DESIGN.md §7.

---

## Phase 1: Tests (WS-3) — DONE

### TASK 3A: MockRuntime Reasoning

**Modify** `runtimes/mock/mock-runtime.ts`:
- Add `reasoning?: string[]` to `MockNodeConfig`
- Emit reasoning events before text in `MockAgentSession.send()`

### TASK 3B: State Runtime Tests

**Modify** `__tests__/state-runtime.test.ts` — Add 4 tests:
1. `onOutput` fires for `node:output`
2. `onOutput` fires for `node:reasoning`
3. `onOutput` fires for `node:tool`
4. Reasoning persists with prefix, readable on output

### TASK 3C: MockRuntime Reasoning Tests

**Create** `__tests__/mock-runtime-reasoning.test.ts` — 3 tests:
1. Reasoning emits before text (ordering)
2. Reasoning without text
3. Backward compat (no reasoning configured)

### TASK 3D: ANSI Dim Tests

**Create** `__tests__/ui/ansi-dim.test.ts` — 4 tests:
1. SGR 2 renders with opacity
2. `[thinking]` prefix with dim
3. Dim + color combo
4. SGR 22 undims

### TASK 3E: MarkdownContent XSS Tests

**Create** `__tests__/ui/markdown-content.test.tsx` — 7 tests:
1. Section headings
2. Code blocks
3. Blockquotes
4. `<script>` tag escaped (XSS)
5. `<img onerror>` escaped (XSS)
6. Custom className
7. Empty content

**Total new tests**: 26 (all passing)

---

## Phase 2: Barrel Exports + Build (WS-4) — Lead

### TASK 4A: Barrel Exports

**Modify** `ui/core/index.ts` — add after hook exports:
```typescript
export { useNodeArtifact } from '../hooks/useNodeArtifact';
export { MarkdownContent } from '../components/MarkdownContent';
export type { MarkdownContentProps } from '../components/MarkdownContent';
```

**Modify** `ui/index.ts` — add after hook exports:
```typescript
export { useNodeArtifact } from './hooks/useNodeArtifact';
export { MarkdownContent } from './components/MarkdownContent';
export type { MarkdownContentProps } from './components/MarkdownContent';
```

### TASK 4B: Version Bump

**Modify** `package.json` line 3:
```json
"version": "0.3.2",
```

### TASK 4C: Build + Pack

```bash
cd Q:\Software\investigation\condukt
npm run build
npm test
npm pack
```

### TASK 4D: Install in taco-helper

```bash
cd Q:\Software\investigation\taco-helper
npm install ../condukt/condukt-0.3.2.tgz
```

---

## Repository: `Q:\Software\investigation\taco-helper\`

---

## Phase 3: Backend Wiring (WS-5)

### TASK 5A: FlowEventBus Widening

**Modify** `src/app/api/_shared/flow-state.ts`:

Widen the listener type and add `emitOutput`:
```typescript
// Before (line 32):
type FlowEventListener = (event: ExecutionEvent) => void;

// After:
import type { OutputEvent } from 'condukt';
type FlowEventListener = (event: ExecutionEvent | OutputEvent) => void;
```

Add `emitOutput` method to `FlowEventBus` class (after `emit`):
```typescript
emitOutput(event: OutputEvent): void {
  for (const fn of this.listeners) {
    try { fn(event); } catch { /* swallow listener errors */ }
  }
}
```

### TASK 5B: Wire `onOutput` Callback

**Modify** `src/app/api/_shared/flow-state.ts` — `getFlowStateRuntime()` (lines 57-65):

```typescript
// Before:
const rt = new StateRuntime(storage, (event) => getFlowEventBus().emit(event));

// After:
const rt = new StateRuntime(
  storage,
  (event) => getFlowEventBus().emit(event),
  (event) => getFlowEventBus().emitOutput(event),
);
```

### TASK 5C: Artifact REST Endpoint

**Create** `src/app/api/executions/[id]/nodes/[nodeId]/artifact/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { getFlowStateRuntime } from '../../../../../../_shared/flow-state';

interface RouteParams {
  params: Promise<{ id: string; nodeId: string }>;
}

export async function GET(request: Request, { params }: RouteParams): Promise<Response> {
  const { id, nodeId } = await params;
  const url = new URL(request.url);
  const filename = url.searchParams.get('filename') ?? 'output.md';

  const content = getFlowStateRuntime().getArtifact(id, nodeId, filename);
  if (content === null) {
    return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
  }
  return NextResponse.json({ content, filename });
}
```

---

## Phase 3: Frontend Integration (WS-6)

### TASK 6A: Reasoning SSE Handling

**Modify** `src/app/flow/[id]/page.tsx`:

1. Add `node:reasoning` to the skip list in execution SSE (line 89):
```typescript
// Before:
if (event.type === 'node:output' || event.type === 'node:tool') return;

// After:
if (event.type === 'node:output' || event.type === 'node:tool' || event.type === 'node:reasoning') return;
```

2. Handle reasoning in node output SSE (line 383):
```typescript
// Before:
if (d.type === 'node:output' && d.content) {

// After:
if ((d.type === 'node:output' || d.type === 'node:reasoning') && d.content) {
  const text = d.type === 'node:reasoning'
    ? `\x1b[2m[thinking] ${d.content}\x1b[0m`
    : d.content;
```

Then use `text` instead of `d.content` in `pendingRef.current.push(text)`.

### TASK 6B: Artifact Tab

Add artifact tab state and rendering in `OutputPanel`:

1. Change tab state type:
```typescript
const [outputTab, setOutputTab] = useState<'all' | 'errors' | 'artifact'>('all');
```

2. Add artifact fetch state:
```typescript
const [artifactContent, setArtifactContent] = useState<string | null>(null);
const [artifactLoading, setArtifactLoading] = useState(false);
```

3. Fetch artifact when node completes:
```typescript
useEffect(() => {
  if (node.status !== 'completed' || !node.output) return;
  setArtifactLoading(true);
  fetch(`/api/executions/${execId}/nodes/${node.id}/artifact?filename=${encodeURIComponent(node.output)}`)
    .then(r => r.ok ? r.json() : null)
    .then(d => setArtifactContent(d?.content ?? null))
    .catch(() => setArtifactContent(null))
    .finally(() => setArtifactLoading(false));
}, [execId, node.id, node.status, node.output]);
```

4. Smart auto-switch: only switch to artifact tab when node completes AND autoScroll is true:
```typescript
useEffect(() => {
  if (node.status === 'completed' && node.output && autoScroll) {
    setOutputTab('artifact');
  }
}, [node.status, node.output, autoScroll]);
```

5. Add "Artifact" tab button (after Errors tab):
```tsx
{node.output && (
  <button onClick={() => setOutputTab('artifact')} className={cn('px-4 py-2 text-[12px] ...')}>
    Artifact{artifactContent && outputTab !== 'artifact' ? ' \u2022' : ''}
  </button>
)}
```

6. Render artifact content when tab selected (import MarkdownContent from condukt/ui/core):
```tsx
{outputTab === 'artifact' ? (
  artifactLoading ? <div>Loading...</div> :
  artifactContent ? <MarkdownContent content={artifactContent} /> :
  <div>No artifact</div>
) : (
  /* existing List rendering */
)}
```

### TASK 6C: Remove IcmRcaPanel

1. Delete `src/components/rca-display.tsx`
2. Remove import of `RcaDisplay` from `page.tsx` (line 16)
3. Remove import of `IcmRcaResult` from `page.tsx` (line 17)
4. Remove the `graphName === 'icm'` special case (lines 241-242)
5. Remove the `IcmRcaPanel` function (lines 541-567)
6. Remove the ternary at line 241 — all nodes go through `OutputPanel`

The `OutputPanel` with the new artifact tab handles all pipelines uniformly.

---

## Verification Checklist

### condukt
- [ ] `npm run build` passes
- [ ] `npm test` passes (458+ existing + 26 new)
- [ ] `npm run typecheck` passes
- [ ] `npm pack` produces tarball

### taco-helper
- [ ] `npm install ../condukt/condukt-0.3.2.tgz` succeeds
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (368+ pass)
- [ ] No references to `rca-display` or `IcmRcaPanel` remain
- [ ] No `graphName === 'icm'` special case in page.tsx
