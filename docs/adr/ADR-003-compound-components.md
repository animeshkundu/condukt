# ADR-003: Compound Components for NodeDetailPanel

## Status: Accepted

## Context

Three extension models were considered for NodeDetailPanel:

1. **Render slots**: `renderGateSection`, `renderNodeInfo` — function props
2. **Compound components**: `NodePanel.Header`, `NodePanel.Output` — composable building blocks
3. **Ship default, customize later** — monolithic component

### Decision Process

Tested against 5 pipeline types (CI/CD, ML, data ingestion, investigation, deployment):
- Initial analysis: 4/5 work with default → suggested render slots
- Deeper analysis: the panel needs 6+ customization points (output renderer, gate buttons, model display, line cap, auto-scroll, section ordering) → that's a compound component in disguise
- Investigation composition needs to INSERT QualityGateDisplay between info and controls — slots can't express section ordering

## Decision

Ship compound components from day one:

```typescript
// Building blocks (primary export):
NodePanel, NodePanel.Header, NodePanel.Info, NodePanel.Gate,
NodePanel.Controls, NodePanel.Output, NodePanel.Error

// Convenience default (zero-config):
NodeDetailPanel  // assembles all building blocks
```

The convenience `NodeDetailPanel` is a composition of the building blocks. Consumers who need customization use the individual pieces directly.

## Migration Trigger (from earlier "render slots" plan)

The original plan deferred compound components until ">2 slots needed." The 8-expert review found 6+ customization points already exist, triggering the migration before shipping.

## Consequences

- Every composition CAN customize by composing building blocks
- The 80% case (zero-config) uses `NodeDetailPanel` and pays no complexity cost
- New framework features (cost display, metadata sections) are added as new building blocks
- Building blocks are independently testable
