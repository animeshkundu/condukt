# ADR-001: Plain Text Default Output, ANSI Opt-In

## Status: Accepted

## Context

The framework's NodeDetailPanel renders agent output. The initial implementation defaulted to ANSI rendering (converting terminal escape codes to colored HTML). This was designed for the investigation pipeline which uses copilot CLI producing ANSI output.

An 8-member adversarial review (including Principal AI Engineer, Lead Systems Engineer, and Investigation-bias Adversary) found this is domain-biased:
- CI/CD pipelines may output structured JSON
- Data pipelines may output schema descriptions
- ML training may output TensorBoard metrics
- Deterministic nodes output plain data

Making ANSI the default means non-CLI pipelines are second-class.

## Decision

- Default output renderer is **plain text** (lines rendered as text nodes)
- ANSI is **opt-in** via `renderer: 'ansi'` prop on `NodePanel.Output`
- ANSI utilities (`ansiToHtml`, `stripAnsi`, `hasAnsi`) are exported from `/ui` for consumers to use
- Custom renderers supported via `renderer: (line: string) => ReactNode`

## Consequences

- Investigation composition passes `renderer="ansi"` explicitly
- CI/CD, ML, data pipelines work out of the box with no configuration
- The ANSI converter adds ~2KB to the `/ui` bundle but is tree-shakeable when not imported
