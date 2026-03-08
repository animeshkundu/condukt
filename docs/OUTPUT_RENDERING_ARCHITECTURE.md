# Agent Output Rendering: Architecture

## System Overview

```
Copilot CLI (subprocess)          condukt Framework                    taco-helper UI
┌─────────────────────┐    ┌──────────────────────────┐    ┌───────────────────────────┐
│ assistant.message    │───→│ subprocess-backend.ts    │    │                           │
│ assistant.reasoning  │    │  • Parse JSONL stdout    │    │  OutputPanel (page.tsx)    │
│ tool.execution_start │    │  • Classify events       │    │  • EventSource SSE client │
│ tool.execution_*     │    │  • Extract args/results  │    │  • Feed → Builder         │
│ tool.execution_done  │    │  • NO truncation         │    │  • Flush → React state    │
└─────────────────────┘    └────────┬─────────────────┘    │  • Collapsed overrides    │
                                    │                       └──────────┬────────────────┘
                                    ▼                                  │
                           ┌──────────────────────┐                    ▼
                           │ agent.ts              │           ┌────────────────────┐
                           │  • Session events     │           │ ResponsePartBuilder │
                           │  • Emit OutputEvents  │           │  • State machine    │
                           │  • NO truncation      │           │  • Pin-to-thinking  │
                           └────────┬──────────────┘           │  • Part accumulator │
                                    │                          └────────┬───────────┘
                                    ▼                                   │
                           ┌──────────────────────┐                    ▼
                           │ state-runtime.ts      │           ┌────────────────────┐
                           │  • Escape newlines     │           │ ResponsePartRenderer│
                           │  • Persist to .log     │           │  • Part → Component │
                           │  • Publish to EventBus │           │  • ThinkingSection  │
                           └────────┬──────────────┘           │  • ToolProgressLine │
                                    │                          │  • Markdown         │
                                    ▼                          └────────────────────┘
                           ┌──────────────────────┐
                           │ sse.ts (bridge)       │
                           │  • Replay from .log   │
                           │  • Unescape newlines  │
                           │  • Stream live events  │
                           │  • SSE to client       │
                           └──────────────────────┘
```

## Data Flow

### 1. Event Generation (subprocess-backend.ts → agent.ts)

The Copilot CLI subprocess emits JSONL on stdout. `subprocess-backend.ts` classifies each line:

| JSONL Event | Session Event | OutputEvent Type |
|-------------|--------------|-----------------|
| `assistant.message` | `text` | `node:output` (no tool) |
| `assistant.reasoning` | `reasoning` | `node:reasoning` |
| `tool.execution_start` | `tool_start` | `node:tool` (phase: start) |
| `tool.execution_partial_result` | `text` | `node:output` (tool: name) |
| `tool.execution_complete` | `tool_complete` | `node:tool` (phase: complete) |

No truncation anywhere in this path. Full content flows through.

### 2. Storage (state-runtime.ts → storage.ts)

Output events are persisted as NUL-byte-prefixed lines in `output/{nodeId}.log`:

| Event Type | Storage Format |
|------------|---------------|
| Plain text | `{escaped_content}\n` |
| Tool-attributed | `\x00tool:output\x00{tool}\x00{escaped_content}\n` |
| Reasoning | `\x00reasoning\x00{escaped_content}\n` |
| Tool start | `\x00tool:start\x00{tool}\x00{escaped_summary}\n` |
| Tool complete | `\x00tool:complete\x00{tool}\x00{escaped_summary}\n` |

**Newline escaping**: Content is escaped before storage (`\n` → `\\n`, `\r` → `\\r`, `\\` → `\\\\`). Unescaped on read. This prevents multi-line content from being split into separate lines during replay.

### 3. Replay (sse.ts)

`createNodeSSEStream` reads all stored lines, decodes NUL-byte prefixes back to typed SSE events, and streams them to the client. Live events from the EventBus are also forwarded.

**Backward compatibility**: Old logs without escaping parse correctly — bare `\n` was already split by the line reader (appearing as separate lines). The unescape function only converts literal two-char `\\n` sequences.

### 4. State Machine (ResponsePartBuilder)

The builder receives events via `onOutput`, `onReasoning`, `onToolStartRaw`, `onToolComplete`, `onToolOutput`. It produces a `ResponsePart[]` array.

**State**: `_parts` (accumulated output), `_activeThinking` (current open thinking section or null), `_pendingTools` (toolCallId → ToolInvocation map).

**Transitions**:

| Event | Active Thinking? | Action |
|-------|-----------------|--------|
| onReasoning | No | Create thinking section, push thinking-text |
| onReasoning | Yes | Merge into last thinking-text item |
| onToolStartRaw (pinnable) | No | Create thinking section, push pinned-tool |
| onToolStartRaw (pinnable) | Yes | Push pinned-tool to existing section |
| onToolStartRaw (standalone) | Any | Push tool-progress line (no finalization) |
| onToolStartRaw (metadata) | Any | Silently ignored |
| onToolComplete (all pinned done) | Yes | Finalize thinking section |
| onOutput | Yes | Finalize thinking, push markdown |
| onOutput | No | Merge/push markdown |
| flush() | Yes | Finalize thinking section |

**Determinism**: The builder produces identical output for identical event sequences regardless of timing.

### 5. Rendering (ResponsePartRenderer)

Maps `ResponsePart` types to React components:

| Part Type | Component | Visual |
|-----------|-----------|--------|
| `markdown` | Consumer's `renderMarkdown` or `InlineMarkdown` | Full-size, prominent |
| `thinking-section` | `ThinkingSection` | Collapsed: dim borderless text. Expanded: bordered content with tools + markdown |
| `tool-progress` | `ToolProgressLine` | Dim flat line. Expandable: Input/Output code blocks |
| `status` | `StatusLine` | Dim metadata text |

## Key Files

### condukt (framework)
| File | Purpose |
|------|---------|
| `runtimes/copilot/subprocess-backend.ts` | JSONL parsing, event classification |
| `src/agent.ts` | Session event wiring to OutputEvents |
| `state/state-runtime.ts` | Output storage with newline escaping |
| `bridge/sse.ts` | SSE replay with newline unescaping |
| `ui/tool-display/response-parts.ts` | ResponsePartBuilder state machine |
| `ui/tool-display/types.ts` | ToolInvocation, ToolSpecificData types |
| `ui/tool-display/formatter.ts` | Tool classification, isPinnable, verb computation |
| `ui/tool-display/ThinkingSection.tsx` | Collapsible thinking section component |
| `ui/tool-display/ToolProgressLine.tsx` | Expandable tool progress line component |
| `ui/tool-display/ResponsePartRenderer.tsx` | Part type → component router |

### taco-helper (consumer)
| File | Purpose |
|------|---------|
| `src/app/flow/[id]/page.tsx` | OutputPanel: SSE handler, builder wiring, collapsed overrides |
