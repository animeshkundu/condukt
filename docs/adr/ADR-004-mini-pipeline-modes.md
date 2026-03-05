# ADR-004: MiniPipeline Three Rendering Modes

## Status: Accepted

## Context

The MiniPipeline component shows pipeline progress at a glance (for list views, cards, sidebars). Pipelines vary from 3 nodes (simple CI/CD) to 200+ nodes (ML feature pipelines).

Key requirement: MiniPipeline must render the TOPOLOGY (parallel branches, fan-in), not flatten the DAG into a linear dot sequence.

### Investigation bias found

Initial design: 12-node threshold for dots vs bar mode. This accommodates the 9-node investigation pipeline with slight headroom. ML feature pipelines commonly have 15-30 nodes; data pipelines exceed 50.

## Decision

Three modes with `auto` default:

| Mode | Node Count | Rendering |
|------|-----------|-----------|
| `graph` | ≤20 | Compact SVG mini-DAG: 6px status dots, thin edges, shows parallel branches and fan-in |
| `bar` | 21-50 | Stacked proportional bar with status-colored segments |
| `summary` | >50 | Text: "42 completed, 3 running, 1 failed, 154 pending" |
| `auto` | - | Selects based on node count |

```typescript
interface MiniPipelineProps {
  projection: ExecutionProjection;
  mode?: 'graph' | 'bar' | 'summary' | 'auto';
  height?: number;
}
```

The `graph` mode reuses the topological sort logic from `FlowGraph.tsx` but renders at thumbnail scale (no interactivity, no labels).

## Consequences

- 3-node CI/CD pipeline: clean mini-graph showing linear flow
- 9-node investigation: mini-graph showing parallel start + fan-in
- 30-node ML pipeline: proportional bar showing progress
- 200-node data pipeline: summary text
- All pipeline sizes are first-class citizens
