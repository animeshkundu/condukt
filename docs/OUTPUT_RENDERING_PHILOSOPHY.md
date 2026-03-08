# Agent Output Rendering: Philosophy & Soul

## Why This Matters

An investigation agent runs for 15-45 minutes, invoking dozens of tools (Kusto queries, file reads, code searches), producing reasoning chains, and ultimately delivering an investigation report. The operator needs to:

1. **Follow the investigation live** — see the agent's thinking, tool calls, and findings as they happen
2. **Review completed investigations** — scan through historical output, expand relevant sections, inspect tool results
3. **Trust the output** — distinguish agent conclusions from intermediate reasoning, see evidence for claims

The output rendering is the primary surface through which operators interact with agent work. If it's cluttered, fragmented, or visually flat, operators can't find what matters. If it's inconsistent between live and replay, operators can't trust what they see.

## The North Star: VS Code Copilot Chat

VS Code's Copilot Chat panel is the gold standard for agent output rendering. After studying the full source code (`chatListRenderer.ts`, `chatThinkingContentPart.ts`, all CSS) and taking reference screenshots, we identified a single design principle that governs everything:

> **Agent speech is the only prominent content. Everything else is visually minimized.**

This manifests as a clear visual hierarchy:

```
[dim]  Calling kusto kusto_query... – Azure MCP (MCP Server)     tool activity
[dim]  Analyzed infrastructure and checked Redis health >         collapsed thinking
[BOLD] **Root cause identified.** The TokenServiceWrapper...      agent speech
[dim]  Calling kusto kusto_query... – Azure MCP (MCP Server)     tool activity
[dim]  Confirmed region-specific failure patterns                 collapsed thinking
[BOLD] **Confirmed: northeurope-specific.** US cluster at 0.01%  agent speech
```

The operator's eye skips over dim tool/thinking lines and locks onto the bold agent findings. When they need details, they expand a thinking section or tool result. The default view is scannable.

## Guiding Principles

### 1. Framework Renders, Consumer Configures

The rendering pipeline lives in condukt (the framework). Taco-helper (the consumer) configures it with:
- Tool formatters (Kusto, ICM, WorkIQ display names)
- Markdown renderer (MarkdownContent component)
- Collapsed-state overrides (user toggle persistence)

This separation means the same rendering works for availability investigations, ICM RCA investigations, and future pipeline types — without framework changes.

### 2. Event Sourcing: Identical Events → Identical Output

The `ResponsePartBuilder` is a deterministic state machine. Given the same sequence of events in the same order, it produces identical output regardless of timing (streaming vs replay). This is verified by the replay parity test.

The storage format must preserve event identity across write/read cycles. Multi-line content is escaped to prevent corruption. No truncation — full tool input/output flows through the pipeline.

### 3. Three Visual Patterns, Not Ad Hoc

Every piece of agent output maps to exactly one of three visual patterns:

| Pattern | Content | Visual | Interaction |
|---------|---------|--------|-------------|
| **Agent Speech** | LLM's visible response to the user | Full-size markdown, prominent, bold key terms | Read, copy |
| **Thinking Section** | Reasoning + pinned tools (file reads, grep, bash) | Dim borderless collapsed title → expandable with rich markdown + tool list | Expand/collapse |
| **Tool Progress Line** | Standalone tools (MCP, subagent) | Dim flat line → expandable with Input/Output | Expand/collapse |

There is no fourth pattern. Status lines exist but are ephemeral. This constraint prevents visual clutter and keeps the UI scannable.

### 4. Pin to Thinking: VS Code's Classification Model

VS Code classifies every part into **pinned** (absorbed into the active thinking section) or **standalone** (rendered independently). We implement the same model:

**Pinned** (inside thinking section):
- File tools: Read, view, show_file
- Search tools: Grep, Glob, rg, search
- Edit tools: Edit, Write, create, insert
- Shell tools: Bash, powershell
- Reasoning text

**Standalone** (rendered as progress lines):
- MCP tools: Kusto, ICM, WorkIQ, Bluebird
- Subagent/task tools
- Web tools: WebFetch, WebSearch

**Invisible** (silently ignored):
- Metadata tools: report_intent, think, report_progress, Skill, AskUserQuestion

### 5. Delete the Truncation, Trust the Data

Every arbitrary limit was removed from the pipeline:
- Tool input summary: no truncation (was 200 chars)
- Tool output result: no truncation (was 200 chars)
- Tool argument extraction: no truncation (was 200 chars)
- Tool execution result: no truncation (was 200 chars)

Storage is not a concern — these are investigation artifacts that the user explicitly ran. Full context is always available for inspection.

### 6. Backward Compatible, Forward Looking

The newline escaping in the storage format is backward-compatible: old logs without escaping parse correctly because bare `\n` was already split by the line reader (appearing as separate lines). The escape sequences (`\\n`, `\\r`) only appear in logs written by the new code.

The component APIs are additive: `renderMarkdown` is an optional callback, `onToggle` works in both controlled and uncontrolled modes, the expandable ToolProgressLine degrades to a flat line when no data is available.
