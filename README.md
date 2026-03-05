# condukt

Composable AI agent workflow framework for building, executing, and monitoring multi-step pipelines.

[![npm version](https://img.shields.io/npm/v/condukt.svg)](https://www.npmjs.com/package/condukt)

## Overview

condukt provides the building blocks for orchestrating AI agent pipelines — a DAG scheduler, event-sourced state management, runtime adapters, and a complete dark-themed UI component library.

```
npm install condukt
```

## Architecture

```
condukt
├── Core Engine
│   ├── DAG Scheduler (topological execution with parallel branches)
│   ├── Node types: agent, deterministic, gate, verify
│   └── Event-sourced state (reducer pattern)
│
├── State Management
│   ├── StateRuntime (projection from events)
│   ├── FileStorage (JSON persistence with crash recovery)
│   └── MemoryStorage (testing)
│
├── Bridge API
│   ├── launch, stop, resume
│   ├── retry, skip, approve
│   └── Real-time event streaming
│
├── Runtimes
│   ├── CopilotAdapter (subprocess CLI integration)
│   └── MockRuntime (testing & development)
│
└── UI Components (React 19 + Tailwind CSS)
    ├── Graph: FlowGraph, NodeCard, FlowEdge
    ├── Panel: NodePanel (Header, Info, Error, Gate, Controls, Output)
    ├── Core: Badge, Button, Stat, Skeleton, Toast, ConfirmDialog,
    │         SectionLabel, NodeListItem, PageHeader, ExecutionCard
    ├── Visualization: MiniPipeline, FlowStatusBar
    ├── Hooks: useFlowExecution, useNodeOutput, useAutoSelectNode,
    │          useNodeNavigation
    └── Theme: Tailwind preset with warm charcoal design tokens
```

## Quick Start

### Define a pipeline

```typescript
import { agent, deterministic, gate } from 'condukt';
import type { FlowGraph } from 'condukt';

const pipeline: FlowGraph = {
  nodes: [
    agent('investigate', { model: 'claude-opus-4.6', prompt: 'Investigate the issue...' }),
    agent('verify', { model: 'gpt-5.3-codex', prompt: 'Verify the findings...' }),
    deterministic('quality-check', async (input) => {
      // Run deterministic validation
      return { verdict: 'CONFIRMED', confidence: 0.92 };
    }),
    gate('approval', { allowedResolutions: ['approved', 'rejected'] }),
  ],
  edges: [
    { source: 'investigate', target: 'verify', action: 'default' },
    { source: 'verify', target: 'quality-check', action: 'default' },
    { source: 'quality-check', target: 'approval', action: 'default' },
  ],
};
```

### Execute it

```typescript
import { run, validateGraph } from 'condukt';
import { StateRuntime, FileStorage } from 'condukt/state';
import { createBridge } from 'condukt/bridge';
import { adaptCopilotBackend } from 'condukt/runtimes/copilot';

// Validate the graph
validateGraph(pipeline);

// Set up state
const storage = new FileStorage('.flow-data');
const runtime = new StateRuntime(storage);

// Create bridge and launch
const bridge = createBridge(runtime, adaptCopilotBackend(backend));
const execution = await bridge.launch(pipeline, { scenario: 'my-investigation' });
```

### Add the UI

```tsx
import { FlowGraph } from 'condukt/ui/graph';
import { NodePanel, Badge, Button } from 'condukt/ui/core';
import { useFlowExecution, useNodeOutput } from 'condukt/ui/core';
```

## Sub-path Exports

| Import | Contents |
|--------|----------|
| `condukt` | Core engine: `run`, `validateGraph`, node builders, types |
| `condukt/state` | `StateRuntime`, `FileStorage`, `MemoryStorage`, reducer |
| `condukt/bridge` | `createBridge`, `BridgeApi` |
| `condukt/runtimes/copilot` | `CopilotAdapter`, `SubprocessBackend` |
| `condukt/runtimes/mock` | `MockRuntime` for testing |
| `condukt/ui` | All UI (requires `@xyflow/react`) |
| `condukt/ui/core` | UI without xyflow dependency (safe for Next.js) |
| `condukt/ui/graph` | FlowGraph, NodeCard, FlowEdge (requires `@xyflow/react`) |
| `condukt/theme` | Tailwind preset with design tokens |

## Design System

The UI ships with a warm charcoal dark theme inspired by Claude.ai:

- **Palette**: `#1a1815` base, `#201d18` raised, `#2b2a27` surface
- **Accent**: `#D97757` (terracotta)
- **Typography**: 5-tier scale (28/16/15/12/11px), Inter font stack
- **Spacing**: Consistent 12px/24px padding grid
- **Border radius**: 16px containers, 12px interactive elements
- **Status colors**: Green (completed), blue (running), red (failed), amber (gated), purple (crashed)

### Tailwind Preset

```javascript
// tailwind.config.js
const { flowFrameworkPreset } = require('condukt/theme');

module.exports = {
  presets: [flowFrameworkPreset],
  content: ['./src/**/*.{ts,tsx}', './node_modules/condukt/dist/**/*.js'],
};
```

## Key Design Decisions

| ADR | Decision |
|-----|----------|
| ADR-001 | Plain text default output, ANSI opt-in |
| ADR-002 | Data-driven gate buttons (N resolutions from gateData) |
| ADR-003 | Compound components for NodePanel |
| ADR-004 | MiniPipeline: graph (<=20) / bar (21-50) / summary (>50) |
| ADR-005 | Server-side GraphRegistry (FlowGraph not serializable) |

## Testing

```bash
npm test        # 290 tests across 23 suites
npm run build   # TypeScript CJS output to dist/
```

## License

MIT
