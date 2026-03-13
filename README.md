# condukt

Composable AI agent workflow framework. Define pipelines as directed graphs, execute them with fan-out parallelism and bounded loops, persist state through event sourcing, and visualize everything with a dark-themed React UI.

[![npm](https://img.shields.io/npm/v/condukt.svg)](https://www.npmjs.com/package/condukt)
[![tests](https://img.shields.io/badge/tests-659%20passing-brightgreen)](#testing)
[![license](https://img.shields.io/npm/l/condukt.svg)](LICENSE)

```
npm install condukt
```

## Why condukt

- **Graph-based execution** — DAG scheduler with topological ordering, fan-out/fan-in, and bounded loop-back
- **Four node types** — `agent` (LLM), `deterministic` (pure function), `gate` (human approval), `verify` (iterative validation)
- **Event-sourced state** — every execution event is persisted; projections are recomputed from the log
- **Runtime-agnostic** — plug in any LLM backend via the `AgentRuntime` interface
- **Modular imports** — 12 sub-path exports; consumers install only what they use
- **Full React UI** — interactive flow graph, node panels, tool display, status bar — all dark-themed with warm charcoal tokens

## Quick start

### Define a pipeline

```typescript
import { agent, deterministic, gate } from 'condukt';
import type { FlowGraph } from 'condukt';

const pipeline: FlowGraph = {
  nodes: [
    agent('research', { prompt: 'Research the topic...' }),
    deterministic('transform', async (input) => {
      return { summary: extract(input), confidence: 0.94 };
    }),
    gate('review', { allowedResolutions: ['approved', 'rejected'] }),
  ],
  edges: [
    { source: 'research', target: 'transform', action: 'default' },
    { source: 'transform', target: 'review', action: 'default' },
  ],
};
```

### Execute it

```typescript
import { run, validateGraph } from 'condukt';
import { StateRuntime } from 'condukt/state';
import { FileStorage } from 'condukt/state/server';
import { createBridge } from 'condukt/bridge';

validateGraph(pipeline);

const storage = new FileStorage('.flow-data');
const state = new StateRuntime(storage);
const bridge = createBridge(state, runtime);

const execution = await bridge.launch(pipeline, { scenario: 'my-workflow' });
```

### Add the UI

```tsx
import { FlowGraph } from 'condukt/ui/graph';
import { NodeDetailPanel } from 'condukt/ui/core';
import { useFlowExecution } from 'condukt/ui';
import 'condukt/ui/style.css';
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Your code                                              │
│  FlowGraph { nodes, edges }                             │
│  agent() · deterministic() · gate() · verify()          │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│  Execution         src/                                 │
│  DAG scheduler · fan-out · fan-in · bounded loop-back   │
│  Emits 16 event types as a stream                       │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│  State             state/                               │
│  Pure reducer · JSONL persistence · crash recovery      │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│  Bridge            bridge/                              │
│  launch · stop · resume · retry · skip · approve        │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│  Runtimes          runtimes/                            │
│  AgentRuntime interface → any LLM backend               │
│  Built-in: CopilotBackend · SdkBackend · MockRuntime    │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│  UI                ui/                                  │
│  FlowGraph · MiniPipeline · NodePanel · FlowStatusBar   │
│  ResponsePartRenderer · 50+ tool formatters             │
│  Warm charcoal dark theme · React 19 + React Flow       │
└─────────────────────────────────────────────────────────┘
```

## Imports

condukt is split into sub-path exports so you only pull in what you need.

| Import | What you get |
|--------|-------------|
| `condukt` | Core engine — `run`, `validateGraph`, node factories, types, events |
| `condukt/state` | `StateRuntime`, `MemoryStorage`, reducer |
| `condukt/state/server` | `FileStorage` (JSONL persistence, Node.js only) |
| `condukt/bridge` | `createBridge` → `BridgeApi` |
| `condukt/runtimes/copilot` | `SubprocessBackend`, `SdkBackend`, `adaptCopilotBackend` |
| `condukt/runtimes/mock` | `MockRuntime` for deterministic tests |
| `condukt/ui` | Full UI — hooks, components, graph (requires `react`, `@xyflow/react`) |
| `condukt/ui/core` | Design-system primitives — no xyflow dependency |
| `condukt/ui/graph` | `FlowGraph`, `FlowEdge` (requires `@xyflow/react`) |
| `condukt/ui/tool-display` | `ResponsePartRenderer`, `SubagentSection`, tool formatters |
| `condukt/theme` | Tailwind preset, `STATUS_COLORS`, design tokens |
| `condukt/utils` | Shared utilities |

## Node types

| Factory | Purpose | Example |
|---------|---------|---------|
| `agent(id, config)` | LLM call with crash recovery, setup/teardown hooks | Research, analysis, code generation |
| `deterministic(id, fn)` | Pure async function, no LLM | Parsing, validation, API calls |
| `gate(id, options)` | Pauses execution until a human resolves it | Approval workflows, review checkpoints |
| `verify(id, config)` | Iterative agent + property checks, retries until passing | Output validation, quality gates |

## Graph features

- **Fan-out** — one node fans out to multiple parallel branches
- **Fan-in** — multiple branches converge into a single node (waits for all)
- **Loop-back** — edges that point backward with `maxIterations` bounds and `loopFallback` strategy
- **Per-node timeout** — individual deadline per node
- **Abort / Resume** — stop mid-execution and pick up where you left off

## UI components

The UI layer is a complete React component library with a warm charcoal dark theme.

**Graph visualization** — `FlowGraph` renders the full interactive DAG via React Flow. `MiniPipeline` provides a compact thumbnail in three modes: graph (≤20 nodes), bar (21–50), and summary (>50).

**Node detail** — `NodeDetailPanel` is a zero-config convenience wrapper. For full control, use the compound `NodePanel.*` components: `Header`, `Info`, `ErrorBar`, `Gate`, `Controls`, `Output`.

**Tool display** — `ResponsePartRenderer` handles tool calls, thinking blocks, text, and sub-agent grouping. Ships with 50+ built-in tool formatters and a `renderToolExpanded` callback for custom rendering.

**Hooks** — `useFlowExecution` (SSE + REST), `useNodeOutput` (streaming per-node), `useAutoSelectNode`, `useNodeNavigation`.

### Tailwind preset

```js
// tailwind.config.js
const { flowFrameworkPreset } = require('condukt/theme');

module.exports = {
  presets: [flowFrameworkPreset],
  content: ['./src/**/*.{ts,tsx}', './node_modules/condukt/dist/**/*.js'],
};
```

## Testing

```bash
npm test              # 659 tests across 50 suites
npm run typecheck     # tsc --noEmit
npm run build         # TypeScript → dist/
```

## License

MIT
