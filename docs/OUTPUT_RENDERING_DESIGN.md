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

## Collapsed Pill Style (VS Code parity)

When a thinking section is finalized and collapsed, it renders as a compact inline pill — not a full-width block:

```css
width: fit-content;        /* shrink-wrap, not full width */
display: inline-flex;      /* inline pill layout */
border-radius: 4px;        /* tight pill radius */
padding: 2px 6px 2px 2px;  /* compact padding */
margin-left: -2px;         /* align with content */
font-size: 13px;
line-height: 1.5em;
```

This matches the VS Code `.chat-used-context-label .monaco-button` CSS.

## Single-Item Restoration

When a thinking section finalizes with exactly 1 pinned tool and 0 thinking-text items, the thinking box adds unnecessary visual wrapping. In this case:

1. The thinking section is replaced with a standalone `tool-progress` part
2. The single tool renders as a flat `ToolProgressLine` instead of a collapsible section

This matches VS Code's behavior where a solo tool invocation renders standalone, not wrapped in a thinking container.

## Shimmer Animation (VS Code exact)

The active thinking shimmer uses a 5-stop gradient for a narrow traveling glint:

```css
@keyframes thinkingShimmer {
  0% { background-position: 120% 0; }
  100% { background-position: -20% 0; }
}
background: linear-gradient(90deg,
  #6b6660 0%, #6b6660 30%, #8a8578 50%, #6b6660 70%, #6b6660 100%);
background-size: 400% 100%;
animation: thinkingShimmer 2s linear infinite;
```

Previous implementation used 3-stop/200%/1.5s — too broad a pulse. The 5-stop/400%/2s produces the narrow traveling glint matching VS Code.

## Chain Line Mask Gaps

VS Code's chain-of-thought vertical lines have gaps around icons using `mask-image` gradients, creating a broken-chain effect. The mask creates transparent zones at the top and bottom of each line segment.

## Thinking Bottom Margin

Thinking sections have `margin-bottom: 16px` to create visual separation between thinking sections and subsequent agent speech, matching VS Code spacing.

## Pinnable Tools

The full set of pinnable tools (absorbed into thinking sections):

Shell: `Bash`, `bash`, `powershell`, `read_powershell`, `stop_powershell`, `list_powershell`, `write_powershell`
File: `Read`, `view`, `show_file`, `read_agent`
Search: `Grep`, `grep`, `rg`, `Glob`, `glob`, `search`, `semantic_code_search`
Edit: `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `edit`, `str_replace`, `create`, `insert`, `undo_edit`, `apply_patch`

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
