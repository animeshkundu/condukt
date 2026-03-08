# VS Code Copilot Chat Parity — Comprehensive Reference & Plan

## Executive Summary

After exhaustive study of VS Code Core source (chatListRenderer.ts, chatThinkingContentPart.ts, all tool invocation parts, CSS), analysis of our actual event logs (30 unique tool names, 4 node types), and side-by-side screenshot comparison, we have identified **13 remaining gaps** organized into 4 priority tiers.

The single biggest issue is the **data pipeline**: structured tool args are lost at the subprocess boundary, causing all formatters to be bypassed. This produces generic tool messages ("Tool: 758521266") instead of rich descriptions ("Read `SettingsStoreEventsController.cs`, lines 1 to 100").

---

## Part 1: VS Code Visual Reference

### 1.1 Content Part Types (25 total in VS Code)
| Kind | Component | Our Equivalent |
|------|-----------|---------------|
| markdown | ChatMarkdownContentPart | MarkdownContent ✓ |
| toolInvocation | ChatToolInvocationPart | ToolProgressLine (standalone) or PinnedToolItemView (in thinking) |
| toolInvocationSerialized | Same as above | Same |
| thinking | ChatThinkingContentPart | ThinkingSection ✓ |
| progressMessage | ChatProgressContentPart | StatusLine (suppressed) |
| textEditGroup | (edit diffs) | Not needed |
| hook | (confirmation hooks) | Not applicable |
| treeData/warning/confirmation | Various | Not needed for investigation |

### 1.2 Tool States (6 in VS Code)
| State | Icon | Color | Message |
|-------|------|-------|---------|
| Streaming | codicon-loading~spin | blue | Dynamic from partial args |
| WaitingForConfirmation | codicon-shield | yellow | Confirmation prompt |
| Executing | codicon-loading~spin | blue | invocationMessage |
| WaitingForPostApproval | codicon-shield | yellow | Post-approval prompt |
| Completed | codicon-check | green | pastTenseMessage |
| Cancelled | codicon-circleSlash | gray | reasonMessage |
| Error (denied) | codicon-error | red | Error message |

**Our status**: We have 3 states (running/complete/error). Missing: streaming, confirmation, cancelled.

### 1.3 Thinking Section Lifecycle
| Phase | Title | Border | Content | Icon | Animation |
|-------|-------|--------|---------|------|-----------|
| Active streaming | "Working: {latest tool msg}" | None (pill) | Hidden or expanded | codicon-circle-filled (hidden) | Shimmer on title |
| Active expanded | "Working: {latest tool msg}" | On content area | Visible: tools + markdown | codicon-chevron-down | Shimmer + spinner item |
| Finalized collapsed | "{LLM-generated summary}" | None (pill) | Hidden | codicon-check | None (snaps) |
| Finalized expanded | "{LLM-generated summary}" | On content area | Visible: tools + markdown | codicon-check | None |
| Single-item (1 tool, no text) | N/A | N/A | Tool restored to standalone | N/A | Thinking box hidden |

### 1.4 Collapsed Pill Style (NOT full-width)
```css
.chat-used-context-label .monaco-button {
  width: fit-content;        /* ← shrink-wrap, not full width */
  border: none;
  border-radius: 4px;
  padding: 2px 6px 2px 2px;
  margin-left: -2px;
  font-size: 13px;           /* thinking override */
  line-height: 1.5em;
  display: inline-flex;      /* ← inline pill */
}
```

### 1.5 Tool Message Generation Pipeline (VS Code)
```
Tool.prepareToolInvocation(args)
  → { invocationMessage: "Reading `file.cs`, lines 1-100",
      pastTenseMessage: "Read `file.cs`, lines 1-100" }

Tool.invoke(args)
  → IToolResult { toolResultMessage: "Read `file.cs`, lines 1-100, 2847 chars" }

ChatToolInvocation.didExecuteTool(result)
  → this.pastTenseMessage = result.toolResultMessage  // enriched with result context
```

### 1.6 Shimmer Animation (exact)
```css
@keyframes chat-thinking-shimmer {
  0% { background-position: 120% 0; }
  100% { background-position: -20% 0; }
}
/* 5-stop gradient, 400% size, 2s duration */
background: linear-gradient(90deg,
  var(--foreground) 0%,
  var(--foreground) 30%,
  var(--shimmer) 50%,
  var(--foreground) 70%,
  var(--foreground) 100%);
background-size: 400% 100%;
animation: chat-thinking-shimmer 2s linear infinite;
```

### 1.7 Spacing & Typography
| Element | Font Size | Margin/Padding | Color |
|---------|-----------|---------------|-------|
| Agent speech | 1em (default) | Standard markdown spacing | foreground |
| Thinking title | 13px | No external margin (inline pill) | descriptionForeground |
| Thinking content | body-s (0.923em) | 6px 12px 6px 24px (text), 4px 12px 4px 18px (tools) | descriptionForeground |
| Progress line | 13px | margin: 0 0 6px 0, padding-top: 2px | descriptionForeground |
| Thinking bottom margin | — | margin-bottom: 16px | — |
| Code inline | body-xs (0.846em) | 1px 3px, border-radius 4px | textPreformat-background |

---

## Part 2: Complete Gap Analysis

### P0 — Data Pipeline (Fixes the root cause)

| # | Gap | Impact | Fix |
|---|-----|--------|-----|
| G1 | **Full tool args not passed through pipeline** | Formatters bypassed → generic messages instead of rich descriptions | Pass args from subprocess-backend through agent.ts → events.ts → SSE → page.tsx |
| G2 | **Missing tools in isPinnable** | `read_agent`, `read_powershell`, `stop_powershell`, `list_powershell`, `write_powershell`, `apply_patch` render as standalone instead of pinned | Add to PINNABLE_TOOLS set |
| G3 | **No result-enriched pastTenseMessage** | No ", 200 results" or ", 6 matches" after completion | Extract result context from tool output in completeToolInvocation |

### P1 — Visual Structure (Biggest visual differences)

| # | Gap | Impact | Fix |
|---|-----|--------|-----|
| G4 | **Collapsed thinking is full-width, not pill** | Collapsed sections too visually heavy | `width: fit-content`, `display: inline-flex`, `border-radius: 4px`, `padding: 2px 6px` |
| G5 | **Single-item restoration** | Thinking box wrapping a single tool is visual clutter | When finalized with 1 tool + no thinking text, hide thinking box, render tool standalone |
| G6 | **Inline code badges** | Tool patterns/filenames not styled as code | Render markdown in tool messages so backtick patterns become `<code>` elements |

### P2 — Visual Polish

| # | Gap | Impact | Fix |
|---|-----|--------|-----|
| G7 | **Shimmer is 3-stop/200%/1.5s** | Broader pulse vs VS Code's narrow traveling glint | Change to 5-stop/400%/2s |
| G8 | **Chain lines lack mask-image gaps** | Continuous line vs VS Code's broken-chain with gaps around icons | Add mask-image gradients |
| G9 | **Thinking bottom margin** | No 16px gap after thinking sections | Add margin-bottom: 16px |
| G10 | **Inline code in progress lines** | Tool names in thinking show plain text, not code-styled | Render tool message as markdown in PinnedToolItemView |

### P3 — Advanced Features (Future work)

| # | Gap | Impact | Fix |
|---|-----|--------|-----|
| G11 | **LLM-generated thinking titles** | Concatenated tool names vs intelligent summaries | Call copilot-fast for title generation (requires model API) |
| G12 | **Tool streaming state** | No dynamic message during arg parsing | Would need tool.execution_start partial args support |
| G13 | **File reference widgets** | Plain text vs clickable file links | Would need URI resolution + click handlers |

---

## Part 3: Implementation Plan

### Phase 1: Data Pipeline Fix (G1, G2, G3)

**7 files, 7 changes** — pass full tool args through the pipeline:

1. `subprocess-backend.ts`: Emit full args in tool_start event
2. `types.ts`: Update AgentSession tool_start handler signature
3. `agent.ts`: Forward args in NodeToolEvent
4. `events.ts`: Add `args?` field to NodeToolEvent
5. `state-runtime.ts`: Store args as 4th NUL-delimited field
6. `sse.ts`: Parse 4th field on replay
7. `page.tsx`: Use `onToolStart` with parsed args when available, fallback to `onToolStartRaw`

Also: Add missing tools to `PINNABLE_TOOLS` set in `formatter.ts`:
```
read_agent, read_powershell, stop_powershell, list_powershell,
write_powershell, apply_patch
```

### Phase 2: Visual Structure (G4, G5, G6)

**ThinkingSection.tsx**:
- Collapsed state: `width: fit-content`, `display: inline-flex`, `border-radius: 4px`, `padding: 2px 6px`
- Single-item restoration: when finalizing with 1 pinned tool + 0 thinking-text items, emit the tool as a standalone ToolProgressPart and remove the thinking section from parts

**PinnedToolItemView**: Render tool.invocationMessage through markdown renderer so backtick patterns become `<code>` elements

### Phase 3: Visual Polish (G7, G8, G9, G10)

**ThinkingSection.tsx**:
- Shimmer: 5-stop gradient, `background-size: 400%`, `2s linear infinite`
- Chain lines: mask-image gradients for gaps around icons
- Margin-bottom: 16px on container

### Phase 4: Tests & Verification

1. Unit tests for all pipeline changes
2. Playwright screenshots of all 4 investigation nodes
3. Side-by-side comparison with VS Code reference screenshots

---

## Part 4: Files Changed

### condukt
| File | Phase | Changes |
|------|-------|---------|
| `runtimes/copilot/subprocess-backend.ts` | 1 | Emit full args in tool_start |
| `src/types.ts` | 1 | Update tool_start handler signature |
| `src/agent.ts` | 1 | Forward args in NodeToolEvent |
| `src/events.ts` | 1 | Add args field to NodeToolEvent |
| `state/state-runtime.ts` | 1 | Store args as 4th field |
| `bridge/sse.ts` | 1 | Parse 4th field |
| `ui/tool-display/formatter.ts` | 1 | Add 6 missing tools to PINNABLE_TOOLS |
| `ui/tool-display/ThinkingSection.tsx` | 2,3 | Pill style, single-item, shimmer, chain gaps, margin |
| `ui/tool-display/response-parts.ts` | 2 | Single-item restoration logic |
| `__tests__/tool-display.test.ts` | 4 | All new tests |

### taco-helper
| File | Phase | Changes |
|------|-------|---------|
| `src/app/flow/[id]/page.tsx` | 1 | Use onToolStart with args when available |

---

## Part 5: What We're NOT Doing (and why)

| Feature | VS Code | Decision | Rationale |
|---------|---------|----------|-----------|
| LLM-generated titles | copilot-fast model call | Defer | Requires model API access |
| Progressive word-rate rendering | 40-2000 w/s throttle | Defer | Complex, minimal UX impact |
| File reference widgets | InlineAnchorWidget with icons | Defer | Requires URI resolution service |
| Tool confirmation UI | Editable JSON input | Defer | Not needed for investigation pipeline |
| Todo list widget | Virtualized checklist | Defer | Current task rendering is adequate |
| Monaco code blocks | Full editor widgets | Defer | MarkdownContent's `<pre>` is sufficient |
| Drag and drop | File references draggable | Defer | Not applicable to our use case |
