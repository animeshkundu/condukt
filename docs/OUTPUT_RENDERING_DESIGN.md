# Agent Output Rendering: Design

## VS Code Reference (from source study + screenshots)

### Visual Hierarchy

VS Code Copilot Chat renders output with three tiers of visual prominence:

1. **Agent speech** (Tier 1 — most prominent): Full-size markdown with bold, headings, tables, bullet points, code blocks. This is the agent's visible response to the user — findings, conclusions, analysis.

2. **Collapsed thinking sections** (Tier 2 — dim, scannable): Single line of dim text with a hover chevron. No border when collapsed. Title is an LLM-generated past-tense summary (e.g., "Analyzed systemic infrastructure issue and checked Redis health"). Expands to show reasoning text and tool invocations with chain-of-thought vertical lines.

3. **Tool progress lines** (Tier 3 — dimmest): "Calling kusto kusto_query... – Azure MCP (MCP Server)" while running, "Ran `get_similar_incidents` – icm-mcp (MCP Server)" when complete. Expandable to show Input (JSON args) and Output (result text).

### Key CSS Values (from chatThinkingContent.css)

**Collapsed thinking section**:
- Container: NO border, no background
- Button: `font-size: 13px`, `line-height: 1.5em`, `color: descriptionForeground`
- Chevron: `opacity: 0` default, `opacity: 1` on hover, `transition: opacity 0.1s`
- Active shimmer: `background-clip: text`, 5-stop gradient, `400% 100%`, `2s linear infinite`

**Expanded content area**:
- Container: `border: 1px solid requestBorder`, `border-radius: cornerRadius-medium`
- Chain line: `left: 10.5px`, `width: 1px`, `background: requestBorder`, `mask-image` gradients for gaps
- Thinking text: `padding: 6px 12px 6px 24px`, bullet at `left: 5px top: 9px`
- Tool items: `padding: 4px 12px 4px 18px`, icon at `left: 5px`, 12px codicons

**Tool progress line**:
- Container: `display: flex`, `align-items: center`, `gap: 4px`, `font-size: 13px`
- Expanded: `border: 1px solid requestBorder`, `border-radius: cornerRadius-medium`
- Input/Output labels: `font-size: body-s`, code blocks as editors

### Our Warm Theme Adaptation

| VS Code Token | Our Value | Use |
|---------------|-----------|-----|
| `descriptionForeground` | `#8a8578` | Dim text, thinking titles, tool lines |
| `requestBorder` | `#3d3a36` | Borders, chain lines |
| `cornerRadius-medium` | `8px` | Border radius on content areas |
| `font-size: body-s` | `12px` | Thinking text, tool items |
| Running indicator | `#60a5fa` | Spinner stroke (status color) |
| Success indicator | `#4ade80` | Checkmark (status color) |
| Error indicator | `#f87171` | Error cross (status color) |

## Component Design

### ThinkingSection

**Props**: `items`, `title`, `verb`, `collapsed`, `active`, `onToggle`, `renderMarkdown`

**Collapsed state**: Borderless button with dim title text and hover chevron. Shimmer animation when active. No visual weight — blends into flow as a dim text line.

**Expanded state**: Bordered content area below the title with chain-of-thought vertical lines. Items are either `thinking-text` (rendered as rich markdown via callback) or `pinned-tool` (icon + message, no output).

**Tool icons** (matching VS Code's `getToolInvocationIcon`):
- search/grep/find/glob → 🔍
- read/get_file/view → 📖
- edit/create/write → ✏️
- bash/powershell → 💻
- default → 🔧

### ToolProgressLine

**Props**: `tool` (ToolInvocation), `className`, `style`

**Collapsed state**: Dim flat line with status icon (spinner/check/cross) + message + hover chevron.

**Running verb**: MCP tools show "Calling `tool_name`... – server (MCP Server)". Non-MCP tools show the invocation message.

**Expanded state**: Bordered content area with Input label + pre block and Output label + pre block. Data from `tool.invocationMessage` (Input) and `tool.toolSpecificData` (Output).

### ResponsePartRenderer

Routes `ResponsePart` types to components. Forwards `renderMarkdown` to both markdown parts and ThinkingSection. Forwards `onToggleThinking` to ThinkingSection.

## State Management Design

### Builder Owns Structure, Consumer Owns Collapsed State

The `ResponsePartBuilder` determines the parts structure (which tools are pinned, when thinking sections finalize, etc.). It sets default collapsed values (active sections are expanded, finalized sections are collapsed).

The consumer (page.tsx) maintains a `collapsedOverrides` ref — a `Map<string, boolean>` that persists user toggle clicks. On each `flushParts` (rAF callback), the builder's parts are snapshotted with overrides applied:

```ts
setParts(builderRef.current.parts.map(p =>
  p.kind === 'thinking-section' && overrides.has(p.id)
    ? { ...p, collapsed: overrides.get(p.id)! }
    : p
));
```

### SSE Reconnect Safety

On reconnect, the builder and all associated state (pendingToolIds, toolIdCounter, errorLines, collapsedOverrides) are reset before the new EventSource is created. The server replays all stored events, and the builder reconstructs identical parts from scratch.

### Post-Replay Flush

For completed/terminal nodes, `builder.flush()` is called on SSE `onopen` to finalize any dangling thinking sections that were open when the agent stopped.
