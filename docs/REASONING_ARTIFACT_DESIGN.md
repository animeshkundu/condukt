# Reasoning Visibility & Artifact Tab: Detailed Design

## 1. StateRuntime `onOutput` Callback

### Interface Change

```typescript
// Before:
constructor(storage: StorageEngine, onEvent?: (event: ExecutionEvent) => void)

// After:
constructor(
  storage: StorageEngine,
  onEvent?: (event: ExecutionEvent) => void,
  onOutput?: (event: OutputEvent) => void,
)
```

### handleOutput Behavior

```typescript
handleOutput(event: OutputEvent): void {
  // Persist text and reasoning (not tool events)
  if (event.type === 'node:output' || event.type === 'node:reasoning') {
    const prefix = event.type === 'node:reasoning' ? '\x00reasoning\x00' : '';
    this.storage.appendOutput(event.executionId, event.nodeId, prefix + event.content);
  }
  // Notify ALL output events (text, tool, reasoning)
  this.onOutput?.(event);
}
```

### Design Decisions

1. **Third parameter (not options object)**: Matches the existing two-callback pattern. The StateRuntime constructor is internal API — consumers create it once in a singleton factory. Adding a third positional parameter is the least disruptive change.

2. **Callback fires for ALL output types**: `node:tool` events are not persisted (they're ephemeral notifications) but ARE forwarded to the callback. This lets consumers stream tool call events to the UI in real-time without storage overhead.

3. **No callback for `handleEvent`**: Already exists — `this.onEvent?.(event)` at the end of `_applyEvent()`. The patterns are now symmetric.

### Edge Cases

- **No callback provided**: Existing behavior — output stored, no notification. Backward compatible.
- **Callback throws**: Not caught here (unlike the bridge's emitOutput). The consumer's FlowEventBus swallows errors internally. Adding try/catch here would mask bugs in the transport layer.
- **node:tool persistence**: Deliberately NOT persisted. Tool events are high-frequency and low-value for replay. The callback still fires so live SSE streams show them.

---

## 2. Reasoning Prefix Encoding

### Format

```
Regular output:  "Hello world"
Reasoning:       "\x00reasoning\x00Hello world"
```

### Why null bytes

- **Cannot appear in LLM output**: Tokenizers strip them. JSON serializers escape them. Terminal emulators ignore them.
- **Cannot appear in ANSI escape sequences**: ANSI uses bytes 0x1B-0x7E, never 0x00.
- **O(1) detection**: `line.startsWith('\x00reasoning\x00')` — no regex, no JSON parsing.
- **No schema migration**: Existing stored output has no null bytes, so all existing lines are implicitly `node:output`.

### Rejected Alternatives

1. **JSON wrapper per line**: `{"type":"reasoning","content":"..."}` — Breaks existing consumers that read lines as raw text. Requires JSON parse per line on replay.
2. **Separate storage key**: `appendOutput(execId, nodeId + ':reasoning', content)` — Breaks the output pagination API. `getNodeOutput` returns interleaved lines in chronological order; splitting by type loses ordering.
3. **Event log persistence**: Store reasoning as `ExecutionEvent` in the JSONL log — Violates the architecture: output events are streamed, not persisted in the event log. Adding them to the log would bloat replay and break the reducer (which only handles execution events).

---

## 3. SSE Replay Reconstruction

### Current Replay (all lines → node:output)

```typescript
for (const line of page.lines) {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify({
    type: 'node:output', executionId, nodeId, content: line, ts: 0,
  })}\n\n`));
}
```

### New Replay (detect prefix → correct type)

```typescript
const REASONING_PREFIX = '\x00reasoning\x00';
for (const line of page.lines) {
  const isReasoning = line.startsWith(REASONING_PREFIX);
  const content = isReasoning ? line.slice(REASONING_PREFIX.length) : line;
  const type = isReasoning ? 'node:reasoning' : 'node:output';
  controller.enqueue(encoder.encode(`data: ${JSON.stringify({
    type, executionId, nodeId, content, ts: 0,
  })}\n\n`));
}
```

### Design Decisions

1. **Prefix stripped on replay**: The client receives clean content without the prefix. The prefix is a storage encoding detail, not a transport detail.
2. **`ts: 0` preserved**: Replay events don't have real timestamps (the storage layer doesn't track per-line timestamps). Clients already handle `ts: 0` as "replayed, not live."

---

## 4. useNodeOutput Reasoning Handling

### Current Handler

```typescript
if (data.type === 'node:output' && data.content) {
  setLines((prev) => [...prev, data.content]);
```

### New Handler

```typescript
if ((data.type === 'node:output' || data.type === 'node:reasoning') && data.content) {
  const line = data.type === 'node:reasoning'
    ? `\x1b[2m[thinking] ${data.content}\x1b[0m`
    : data.content;
  setLines((prev) => [...prev, line]);
```

### Design Decisions

1. **ANSI dim wrapping**: SGR code 2 (`\x1b[2m`) renders as `opacity: 0.6` via the existing ANSI renderer. This provides visual hierarchy without a CSS dependency.
2. **`[thinking]` prefix**: Semantic marker visible in both rendered and plain text output. Matches the convention used by Claude's API documentation.
3. **SGR reset at end**: `\x1b[0m` ensures the dim styling doesn't leak to subsequent lines.
4. **No separate state array**: Reasoning lines are interleaved in the same `lines[]` array. This preserves chronological order and simplifies rendering.

---

## 5. useNodeArtifact Hook

### Interface

```typescript
interface UseNodeArtifactOptions {
  executionId: string | null;
  nodeId: string | null;
  filename?: string;         // default: 'output.md'
  baseUrl?: string;          // default: ''
  urlBuilder?: (execId: string, nodeId: string, filename: string) => string;
}

interface ArtifactResult {
  content: string | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}
```

### Design Decisions

1. **`urlBuilder` option**: Consumers with non-standard API routes (different base paths, different URL structure) can provide a custom URL builder. The default assumes the condukt convention: `/api/executions/{id}/nodes/{nodeId}/artifact?filename={name}`.
2. **404 returns null, not error**: A missing artifact is a normal state (node hasn't completed yet). Only non-404 HTTP errors populate the `error` field.
3. **No SSE subscription**: Artifacts are fetched once, not streamed. The consumer triggers `refetch()` when the node status changes.

---

## 6. MarkdownContent Component

### Interface

```typescript
interface MarkdownContentProps {
  content: string;
  className?: string;
  style?: React.CSSProperties;
}
```

### Rendering Rules

| Markdown Element | Rendered As |
|-----------------|-------------|
| `## Heading` | `<h3>` with design language styling |
| `` ```lang ... ``` `` | `<pre><code>` with monospace font |
| `> blockquote` | `<blockquote>` with left border |
| `\| table \|` | `<pre>` (preformatted) |
| Regular text | `<p>` paragraphs |

### XSS Prevention

ALL text content passes through `escapeHtml()` before rendering:

```typescript
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
```

No `dangerouslySetInnerHTML`. No raw HTML injection. Agent output cannot execute scripts.

### Design Decisions

1. **No markdown library**: The rendering needs (headings, code, quotes, tables, paragraphs) are simple. A regex-based parser with HTML escaping is safer and smaller than marked/remark/rehype.
2. **Inline styles**: condukt is a framework — consumers may use Tailwind, CSS Modules, or plain CSS. Inline styles ensure the component works in any context.
3. **`className` prop**: Allows consumer to override container styling (e.g., remove padding for embedding).

---

## 7. NodePanel.Artifact Compound Component

### Interface

```typescript
interface ArtifactProps {
  content: string | null;
  filename?: string;      // default: 'output.md'
  loading?: boolean;
  style?: React.CSSProperties;
}
```

### States

| State | Rendering |
|-------|-----------|
| `loading=true` | Centered "Loading artifact..." |
| `content=null` | Centered "No artifact content" |
| `content` present | Filename header + MarkdownContent |

### Design Decisions

1. **Separate from Output**: Artifacts are formatted documents (markdown). Output is raw stream (ANSI text). Different rendering, different components.
2. **Filename in header**: Shows what file the artifact came from. Useful when nodes write to different filenames.
3. **No copy button in framework**: Copy-to-clipboard is domain-specific (taco-helper wants "Copy to ICM" with blockquote extraction). The framework provides rendering; the consumer adds chrome.

---

## 8. MockRuntime Reasoning Config

### Interface Change

```typescript
interface MockNodeConfig {
  text?: string[];
  reasoning?: string[];    // NEW — emitted before text
  tools?: Array<{...}>;
  artifact?: string;
  error?: Error;
  delay?: number;
}
```

### Emission Order

```
reasoning[0], reasoning[1], ..., reasoning[N]  // thinking phase
text[0], text[1], ..., text[N]                 // response phase
tool_start, tool_complete, ...                 // tool calls
artifact write                                 // file output
idle / error                                   // completion
```

This matches real agent behavior: thinking happens first, then the response streams, then tool calls execute.

### Design Decisions

1. **Reasoning before text**: Real LLM sessions emit thinking tokens before response tokens. The mock should match.
2. **Optional field**: Existing test configs without `reasoning` work identically. Zero backward compatibility risk.
