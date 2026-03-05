# ADR-005: Server-Side Graph Registry

## Status: Accepted

## Context

`FlowGraph` contains `NodeFn` function references which are not JSON-serializable. The retry API (`POST /api/executions/{id}/nodes/{nodeId}/action { action: 'retry' }`) needs the graph to re-run the node, but cannot receive it from the client.

## Decision

The framework provides a `GraphRegistry` interface. The composition registers graphs server-side. API routes look up graphs by `flowId`.

```typescript
interface GraphRegistry {
  register(flowId: string, graph: FlowGraph): void;
  get(flowId: string): FlowGraph | null;
  list(): string[];
}
```

- `POST /api/executions` accepts `flowId` (string), not `graph` (object)
- The registry resolves `flowId` to the actual `FlowGraph` on the server
- Retry operations use the registered graph, not client-provided data
- The composition registers its graphs at startup (e.g., `registry.register('availability', availabilityFlow)`)

## Consequences

- FlowGraph never crosses the network boundary
- Retry works correctly (functions are available server-side)
- Multiple graph types can coexist (investigation, CI/CD, etc.)
- API is cleaner: clients reference flows by name, not by structure
