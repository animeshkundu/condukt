# ADR-002: Data-Driven Gate Buttons

## Status: Accepted

## Context

The initial gate UI hardcoded exactly 2 buttons: "Approve" and "Reject." This models the investigation pipeline's quality gate override pattern.

Review found other pipelines need different gate resolutions:
- Deployment: "Deploy" / "Rollback" / "Skip" (3 options)
- Compliance: "Certify" / "Remand" / "Escalate" (3 options)
- Data quality: "Accept" / "Quarantine" / "Reprocess" (3 options)

The underlying `resolveGate(executionId, nodeId, resolution)` already accepts ANY string.

## Decision

- `NodeGatedEvent.gateData` carries `allowedResolutions?: string[]`
- Default: `['approved', 'rejected']` when `allowedResolutions` is absent
- The UI renders one button per allowed resolution
- Button labels are the resolution strings, title-cased
- The `renderGateSection` compound component slot allows full override

## Consequences

- Any pipeline can define custom gate resolutions at composition time
- The framework never hardcodes domain-specific gate labels
- Existing compositions (investigation) work unchanged (default 2 buttons)
