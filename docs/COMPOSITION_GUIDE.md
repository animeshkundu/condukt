# Composition Guide

How to define a flow, pick a runtime, execute it, and display results. This guide uses the CI/CD counter-test example (`examples/counter-test/cicd.ts`) as a running reference.

## Overview

Building a flow has five steps:

1. **Define nodes** -- create the computation units using factory functions
2. **Compose a graph** -- wire nodes together with edges and routing actions
3. **Pick a runtime** -- choose how agent nodes execute (mock for tests, subprocess for production)
4. **Run the flow** -- launch via the bridge, which handles lifecycle and state
5. **Display results** -- render the projection with the UI components

## Step 1: Define Nodes

Nodes are the computation units. The framework provides four factories:

```typescript
import { deterministic, gate } from 'condukt';
import type { NodeInput, NodeOutput } from 'condukt';
```

### Deterministic nodes

For pure computations that do not need an LLM. Receives `NodeInput`, returns `NodeOutput`.

```typescript
const lint = deterministic(
  'Lint',
  async (input: NodeInput): Promise<NodeOutput> => {
    const hasErrors = (input.params as { lintErrors?: boolean }).lintErrors ?? false;
    return {
      action: hasErrors ? 'fail' : 'default',
      artifact: hasErrors ? 'Lint errors found' : 'Lint passed',
    };
  },
);
```

The `action` field is the routing key -- it determines which outgoing edge to follow.

```typescript
const test = deterministic(
  'Test',
  async (input: NodeInput): Promise<NodeOutput> => {
    const passing = (input.params as { testsPassing?: boolean }).testsPassing ?? true;
    return {
      action: passing ? 'default' : 'fail',
      artifact: passing ? 'All tests passed' : 'Test failures detected',
      metadata: { testCount: 42, duration: 1234 },
    };
  },
);

const build = deterministic(
  'Build',
  async (_input: NodeInput): Promise<NodeOutput> => {
    return {
      action: 'default',
      artifact: 'Build succeeded: dist/app.js (1.2MB)',
      metadata: { buildSize: 1200000 },
    };
  },
);

const deploy = deterministic(
  'Deploy',
  async (input: NodeInput): Promise<NodeOutput> => {
    const env = (input.params as { environment?: string }).environment ?? 'staging';
    return {
      action: 'default',
      artifact: `Deployed to ${env}`,
      metadata: { environment: env, deployedAt: Date.now() },
    };
  },
);
```

### Gate nodes

For points where the flow should pause and wait for external input (human approval, quality review, etc.).

```typescript
const approval = gate('Production Deployment Approval');
```

Gate nodes block until `resolveGate()` (or `bridge.approveGate()`) is called externally with a resolution string like `'approved'` or `'rejected'`.

### Agent nodes

For LLM-powered steps. Not used in this example, but here is the pattern:

```typescript
import { agent } from 'condukt';

const investigate = agent({
  objective: 'Investigate the root cause',
  tools: [{ id: 'bash', displayName: 'Bash' }],
  output: 'investigation.md',
  model: 'claude-opus-4.6',
  promptBuilder: (input) => {
    return `Investigate: ${input.params.ask}\nWrite findings to investigation.md`;
  },
  actionParser: (content) => content.includes('CONFIRMED') ? 'confirmed' : 'inconclusive',
});
```

### Verify nodes

For wrapping a producer with iterative quality checks:

```typescript
import { verify, property } from 'condukt';

const verifiedInvestigation = verify(investigate, {
  checks: [
    property('has-evidence', (c) => c.includes('Evidence:'), 'Missing evidence section'),
    property('has-conclusion', (c) => c.includes('Conclusion:'), 'Missing conclusion'),
  ],
  maxIterations: 3,
});
```

## Step 2: Compose a Graph

A `FlowGraph` has three parts: `nodes`, `edges`, and `start`.

```typescript
import type { FlowGraph } from 'condukt';

export const cicdFlow: FlowGraph = {
  // Node registry: id -> { fn, displayName, nodeType, output?, reads? }
  nodes: {
    lint:     { fn: lint,     displayName: 'Lint',                nodeType: 'deterministic', output: 'lint.txt' },
    test:     { fn: test,     displayName: 'Test',                nodeType: 'deterministic', output: 'test.txt' },
    build:    { fn: build,    displayName: 'Build',               nodeType: 'deterministic', output: 'build.txt', reads: ['lint.txt', 'test.txt'] },
    approval: { fn: approval, displayName: 'Production Approval', nodeType: 'gate' },
    deploy:   { fn: deploy,   displayName: 'Deploy',              nodeType: 'deterministic', output: 'deploy.txt', reads: ['build.txt'] },
  },

  // Edge routing: sourceNodeId -> { action: targetNodeId }
  // Use 'end' to terminate a path. Use 'default' as the fallback action.
  edges: {
    lint:     { default: 'build', fail: 'end' },
    test:     { default: 'build', fail: 'end' },
    build:    { default: 'approval' },
    approval: { approved: 'deploy', rejected: 'end' },
  },

  // Root nodes -- dispatched first
  start: ['lint', 'test'],
};
```

### Graph structure rules

- Every node ID in `start` must exist in `nodes`.
- Every edge source and target must exist in `nodes` (or be `'end'`).
- Output filenames must be unique across all nodes.
- `reads` declares which artifact files a node needs as input. The scheduler resolves these to absolute paths via `NodeInput.artifactPaths`.

### Execution order

The scheduler dispatches nodes in parallel batches following the DAG structure:

```
Batch 1: lint + test (parallel -- both are start nodes)
    |         |
    v         v
Batch 2: build (fan-in -- waits for both lint AND test)
    |
    v
Batch 3: approval (gate -- blocks until resolved)
    |
    v
Batch 4: deploy (only if approved)
```

If `lint` returns `action: 'fail'`, the `fail` edge routes to `'end'`, and `build` never receives that prerequisite. The `test -> build` edge still fires, but `build` will only dispatch once ALL fired edges targeting it have their sources completed.

### Conditional routing

The `action` string returned by a node determines which outgoing edge to follow:

```typescript
// In the node function:
return { action: 'fail', artifact: 'Lint errors found' };

// In the edge map:
lint: { default: 'build', fail: 'end' },
//     ^-- action 'default'   ^-- action 'fail'
```

If no matching edge is found for the returned action, the scheduler falls back to the `'default'` edge. If neither matches, the node is terminal (no successors).

## Step 2b: Fan-Out Routing

An edge target can be an array to dispatch multiple nodes from a single action:

```typescript
const flow: FlowGraph = {
  nodes: {
    check:   { fn: check,   displayName: 'Check',   nodeType: 'deterministic' },
    fixA:    { fn: fixA,    displayName: 'Fix A',   nodeType: 'agent', output: 'fix_a.md' },
    fixB:    { fn: fixB,    displayName: 'Fix B',   nodeType: 'agent', output: 'fix_b.md' },
    merge:   { fn: merge,   displayName: 'Merge',   nodeType: 'deterministic', reads: ['fix_a.md', 'fix_b.md'] },
  },
  edges: {
    check: { default: ['fixA', 'fixB'] },   // fan-out: both dispatch in parallel
    fixA:  { default: 'merge' },
    fixB:  { default: 'merge' },              // fan-in: merge waits for both
  },
  start: ['check'],
};
```

Fan-out is sugar for "dispatch all targets from the same action." Fan-in semantics are unchanged: `merge` waits for ALL fired sources (both `fixA` and `fixB`) to complete.

If all fan-out targets fail, the downstream node is marked `skipped` (it can never fire).

## Step 2c: Convergence Loops

For patterns where nodes should re-run until a convergence condition is met, use loop-back edges with `loopFallback`:

```typescript
const flow: FlowGraph = {
  nodes: {
    agentA:     { fn: agentA,     displayName: 'Agent A',     nodeType: 'agent', output: 'a.md' },
    agentB:     { fn: agentB,     displayName: 'Agent B',     nodeType: 'agent', output: 'b.md' },
    reviewer:   { fn: reviewer,   displayName: 'Reviewer',    nodeType: 'agent', output: 'review.md',
                  reads: ['a.md', 'b.md'] },
    resolved:   { fn: resolved,   displayName: 'Resolved',    nodeType: 'deterministic' },
    fallback:   { fn: fallback,   displayName: 'Fallback',    nodeType: 'agent' },
  },
  edges: {
    agentA:   { default: 'reviewer' },
    agentB:   { default: 'reviewer' },     // fan-in: reviewer waits for both
    reviewer: {
      converged: 'resolved',
      diverged: ['agentA', 'agentB'],       // loop-back: both re-run with differences
    },
  },
  start: ['agentA', 'agentB'],

  // Required: every cycle-creating edge must have a loopFallback entry
  loopFallback: {
    'reviewer:diverged': {
      source: 'reviewer',
      action: 'diverged',
      fallbackTarget: 'fallback',      // where to go when max iterations exceeded
      maxIterations: 3,                 // per-loop limit (defaults to graph.maxIterations ?? 3)
    },
  },
};
```

### How it works

1. `agentA` and `agentB` run in parallel (both in `start`)
2. `reviewer` waits for both (fan-in), compares their outputs
3. If `reviewer` returns `{ action: 'converged' }` → proceeds to `resolved`
4. If `reviewer` returns `{ action: 'diverged' }` → **loop-back**:
   - `agentA` and `agentB` are reset to `pending`
   - Each receives a `RetryContext` with their prior artifact and iteration number
   - `reviewer` is also reset (it needs to re-run after both agents complete)
   - Both agents re-dispatch in parallel
5. After 3 iterations of divergence → routes to `fallback` instead

### Accessing loop context in nodes

Looped nodes receive a `RetryContext` in their `NodeInput`:

```typescript
const agentA = agent({
  // ...
  promptBuilder: (input) => {
    if (input.retryContext) {
      return `Previous attempt (iteration ${input.retryContext.feedback}):\n` +
             `${input.retryContext.priorOutput}\n\n` +
             `The reviewer found differences. Investigate further.`;
    }
    return `Investigate from scratch...`;
  },
});
```

### Validation rules

`validateGraph()` enforces:
- Every cycle-creating edge must have a matching `loopFallback` entry (keyed by `${source}:${action}`)
- Every `fallbackTarget` must exist in `graph.nodes` (or be `'end'`)
- Self-loops (`A: { default: 'A' }`) also require a `loopFallback` entry

Graphs without cycles pass validation with zero overhead.

## Step 3: Pick a Runtime

The runtime determines how `agent()` nodes execute. Deterministic and gate nodes do not use the runtime.

### For tests: MockRuntime

```typescript
import { MockRuntime } from 'condukt/runtimes/mock';

const runtime = new MockRuntime({
  investigate: {
    text: ['Analyzing...', 'Found root cause.'],
    artifact: '# Investigation\n\nEvidence: ...\nConclusion: ...',
  },
});
```

### For production: SubprocessBackend + adapter

```typescript
import { SubprocessBackend, adaptCopilotBackend } from 'condukt/runtimes/copilot';

const backend = new SubprocessBackend({
  extraPathDirs: ['.tools/bin'],
  mcpConfigPath: '.copilot/mcp.json',
});
const runtime = adaptCopilotBackend(backend);
```

### For deterministic-only flows

If your flow has no agent nodes, you can use any runtime (including MockRuntime with empty configs). The runtime is only called when `agent()` nodes execute.

```typescript
import { MockRuntime } from 'condukt/runtimes/mock';
const runtime = new MockRuntime({});  // No agent configs needed
```

## Step 4: Run the Flow

### Option A: Use the Bridge (recommended)

The bridge handles the full lifecycle: state management, concurrency control, abort/resume/retry.

```typescript
import { createBridge } from 'condukt/bridge';
import { StateRuntime, MemoryStorage } from 'condukt/state';

// 1. Create storage and state runtime
const storage = new MemoryStorage();  // or new FileStorage('/path/to/data')
const stateRuntime = new StateRuntime(storage, (event) => {
  // Optional: notify SSE subscribers, log events, etc.
  console.log(`Event: ${event.type}`);
});

// 2. Create the bridge
const bridge = createBridge(runtime, stateRuntime);

// 3. Launch an execution
const executionId = await bridge.launch({
  executionId: 'cicd-run-001',
  graph: cicdFlow,
  dir: '/tmp/cicd-run-001',
  params: { testsPassing: true, environment: 'staging' },
});

// 4. Monitor progress
const projection = bridge.getExecution(executionId);
console.log(`Status: ${projection?.status}`);
console.log(`Active nodes: ${projection?.graph.activeNodes}`);
```

### Interacting with a running flow

```typescript
// Stop a running execution
await bridge.stop(executionId);

// Approve a gate
await bridge.approveGate(executionId, 'approval', 'approved', 'LGTM');

// Reject a gate (routes to 'rejected' edge -> 'end')
await bridge.approveGate(executionId, 'approval', 'rejected', 'Not ready for prod');

// Skip a pending or failed node
await bridge.skipNode(executionId, 'deploy');

// Retry a failed node (with optional override instruction)
await bridge.retryNode(executionId, 'build', cicdFlow, 'Try with --verbose flag');

// Resume a crashed/stopped execution
const result = await bridge.resume(executionId, cicdFlow);
console.log(`Resuming from: ${result?.resumingFrom}`);
```

### Option B: Use run() directly (low-level)

For cases where you want full control and do not need the bridge's lifecycle management:

```typescript
import { run } from 'condukt';

const controller = new AbortController();
const events: ExecutionEvent[] = [];

const result = await run(cicdFlow, {
  executionId: 'cicd-run-002',
  dir: '/tmp/cicd-run-002',
  params: { testsPassing: true },
  runtime,
  emitState: async (event) => { events.push(event); },
  emitOutput: (event) => { console.log(event.content); },
  signal: controller.signal,
});

console.log(`Completed: ${result.completed}, Duration: ${result.durationMs}ms`);
```

## Step 5: Display Results

The UI components render an `ExecutionProjection` as an interactive flow graph.

### Basic setup

```tsx
import { FlowGraph, FlowStatusBar, NodeDetailPanel } from 'condukt/ui';
import { useFlowExecution } from 'condukt/ui';
import { useState } from 'react';

function FlowDashboard({ executionId }: { executionId: string }) {
  const { projection, loading, sseStatus } = useFlowExecution({ executionId });
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  if (loading || !projection) return <div>Loading...</div>;

  const handleAction = async (action: string, nodeId: string) => {
    // Call your API routes to trigger bridge operations
    if (action === 'approve') await fetch(`/api/executions/${executionId}/gate`, {
      method: 'POST', body: JSON.stringify({ nodeId, resolution: 'approved' }),
    });
    // ... handle retry, skip, reject similarly
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ display: 'flex', flex: 1 }}>
        <FlowGraph
          projection={projection}
          selectedNodeId={selectedNode}
          onNodeSelect={setSelectedNode}
        />
        {selectedNode && (
          <NodeDetailPanel
            projection={projection}
            nodeId={selectedNode}
            onClose={() => setSelectedNode(null)}
            onAction={handleAction}
          />
        )}
      </div>
      <FlowStatusBar projection={projection} />
    </div>
  );
}
```

### What the UI shows

- **FlowGraph**: Interactive DAG with nodes colored by status (green=completed, blue=running, red=failed, yellow=gated). Edges animate when taken. Auto-layout via topological sort.
- **NodeDetailPanel**: Side panel with node metadata, gate approve/reject buttons, retry/skip controls, and a live-scrolling output stream.
- **FlowStatusBar**: Bottom bar with counts per status, overall execution status, elapsed time, and total cost.

### SSE integration

The `useFlowExecution` hook expects your backend to serve two endpoints:

- `GET /api/executions/{id}` -- returns `ExecutionProjection` as JSON
- `GET /api/executions/{id}/stream` -- SSE stream of execution events

The hook fetches the initial projection, subscribes to SSE for real-time updates, and falls back to polling when SSE disconnects.

## Complete Example: CI/CD Pipeline

Putting it all together -- a minimal working example with the CI/CD pipeline:

```typescript
import { deterministic, gate } from 'condukt';
import type { FlowGraph, NodeInput, NodeOutput } from 'condukt';
import { createBridge } from 'condukt/bridge';
import { StateRuntime, MemoryStorage } from 'condukt/state';
import { MockRuntime } from 'condukt/runtimes/mock';

// 1. Define nodes
const lint = deterministic('Lint', async (input: NodeInput): Promise<NodeOutput> => {
  const hasErrors = (input.params as { lintErrors?: boolean }).lintErrors ?? false;
  return { action: hasErrors ? 'fail' : 'default', artifact: hasErrors ? 'Errors' : 'OK' };
});

const test = deterministic('Test', async (input: NodeInput): Promise<NodeOutput> => {
  const passing = (input.params as { testsPassing?: boolean }).testsPassing ?? true;
  return { action: passing ? 'default' : 'fail', artifact: passing ? 'OK' : 'Failures' };
});

const build = deterministic('Build', async (): Promise<NodeOutput> => {
  return { action: 'default', artifact: 'Build output' };
});

const approval = gate('deploy-approval');

const deploy = deterministic('Deploy', async (input: NodeInput): Promise<NodeOutput> => {
  const env = (input.params as { environment?: string }).environment ?? 'staging';
  return { action: 'default', artifact: `Deployed to ${env}` };
});

// 2. Compose graph
const cicdFlow: FlowGraph = {
  nodes: {
    lint:     { fn: lint,     displayName: 'Lint',     nodeType: 'deterministic', output: 'lint.txt' },
    test:     { fn: test,     displayName: 'Test',     nodeType: 'deterministic', output: 'test.txt' },
    build:    { fn: build,    displayName: 'Build',    nodeType: 'deterministic', output: 'build.txt' },
    approval: { fn: approval, displayName: 'Approval', nodeType: 'gate' },
    deploy:   { fn: deploy,   displayName: 'Deploy',   nodeType: 'deterministic', output: 'deploy.txt' },
  },
  edges: {
    lint:     { default: 'build', fail: 'end' },
    test:     { default: 'build', fail: 'end' },
    build:    { default: 'approval' },
    approval: { approved: 'deploy', rejected: 'end' },
  },
  start: ['lint', 'test'],
};

// 3. Pick runtime (no agents, so empty mock is fine)
const runtime = new MockRuntime({});

// 4. Create state + bridge
const storage = new MemoryStorage();
const stateRuntime = new StateRuntime(storage);
const bridge = createBridge(runtime, stateRuntime);

// 5. Launch
const id = await bridge.launch({
  executionId: 'cicd-001',
  graph: cicdFlow,
  dir: '/tmp/cicd-001',
  params: { testsPassing: true, environment: 'production' },
});

// 6. Wait for gate, then approve
// (In a real app, the UI calls this via an API route)
setTimeout(async () => {
  await bridge.approveGate(id, 'approval', 'approved', 'Ship it');
}, 1000);

// 7. Check final state
setTimeout(() => {
  const projection = bridge.getExecution(id);
  console.log(`Status: ${projection?.status}`);
  console.log(`Nodes: ${projection?.graph.nodes.map(n => `${n.displayName}:${n.status}`).join(', ')}`);
}, 2000);
```

## Tips

- **Action strings are freeform.** Use descriptive names (`'approved'`, `'fail'`, `'confirmed'`) rather than generic ones. The `'default'` action is the fallback when no matching edge exists.
- **Artifacts flow through files.** A node declares `output: 'report.md'` to produce an artifact and `reads: ['report.md']` to consume one. The scheduler resolves paths via `NodeInput.artifactPaths`.
- **Metadata is flexible.** Return `metadata: { key: value }` from any node. The reducer emits one `metadata` event per key. Arrays accumulate (CR1); scalars overwrite.
- **Verify wraps any producer.** The `verify()` combinator works with `agent()`, `deterministic()`, or even another `verify()`. From the scheduler's perspective, it is one node.
- **Gate nodes are external.** The flow pauses until `bridge.approveGate()` or `resolveGate()` is called. This enables human-in-the-loop workflows.
- **Resume preserves progress.** Crashed or stopped flows can be resumed from where they left off. The bridge rebuilds the resume state from the projection and computes the frontier.
