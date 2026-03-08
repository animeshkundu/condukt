# Agent Output Rendering: Implementation Record

## What Was Built (13 commits across 2 repos)

### condukt commits (Phase 1)
| Hash | Title | Files | Lines |
|------|-------|-------|-------|
| `947739e` | feat: pin-to-thinking model — VS Code Copilot Chat visual overhaul | 11 | +902/-624 |
| `46246c5` | fix: match VS Code output rules — no tool results in thinking blocks | 4 | +111/-69 |
| `68f1f7b` | fix: VS Code parity — suppress ephemeral progress, don't fragment thinking | 2 | +33/-38 |
| `0e5fe20` | feat: VS Code parity — storage format fix, remove truncation, visual overhaul | 9 | +185/-58 |
| `73fc2cd` | docs: agent output rendering — philosophy, architecture, design, implementation | 5 | docs |
| `5d0d11c` | fix: buffer tool partials arriving before execution_start | 1 | +20/-3 |
| `1753120` | fix: show tool friendlyName for non-MCP standalone tools | 1 | +3/-1 |
| `fbc2fb3` | fix: shorten absolute paths in tool display messages | 2 | +35/-1 |

### taco-helper commits (Phase 1)
| Hash | Title | Files | Lines |
|------|-------|-------|-------|
| `ae3e8d6` | feat: adopt pin-to-thinking model, fix toggle state ownership | 2 | +52/-37 |
| `4ce293f` | fix: use onToolStartRaw, drop tool-attributed output, remove parseToolArgs | 2 | +56/-15 |
| `80190b0` | fix: SSE reconnect reset, post-replay flush for completed nodes | 2 | +17/-2 |

## Key Decisions

### D1: Always finalize thinking on output (not conditional)

**Decision**: `onOutput()` always calls `_finalizeThinking()`, regardless of whether pinned tools are pending.

**Rationale**: The adversarial review showed that conditional finalization causes temporal ordering corruption — post-speech reasoning appears in a pre-speech thinking section, misrepresenting the event sequence. VS Code's renderer also finalizes thinking on all plain markdown. Pending tools complete in-place inside the finalized section via shared object references.

**Trade-off**: Thinking sections may show spinning tools inside them when expanded (tools that were in-flight when the section was finalized). This is acceptable and matches VS Code behavior.

### D2: Suppress metadata tools silently (not as status lines)

**Decision**: `report_intent`, `report_progress`, `think`, `Skill`, `AskUserQuestion` produce no output.

**Rationale**: VS Code hides progress messages once subsequent content arrives. In our completed-investigation replay, these would be permanently visible status lines that add visual clutter without user value. The thinking section title serves as the progress indicator.

### D3: Standalone tools don't finalize thinking

**Decision**: When a standalone (non-pinnable) tool starts, it pushes a `tool-progress` part but does NOT finalize the active thinking section.

**Rationale**: VS Code renders standalone tools alongside thinking without interrupting the thinking flow. The thinking section stays open for future pinnable tools and reasoning. Only agent speech (`onOutput`) or stream end (`flush`) finalizes thinking.

### D4: Remove all truncation

**Decision**: No `.substring(0, 200)` or `.slice(0, 200)` anywhere in the pipeline.

**Rationale**: The user explicitly stated "Why have limits on the output? Why truncate?" Storage is not a concern for investigation artifacts. Full tool input/output is needed for the expandable Input/Output code blocks in `ToolProgressLine`.

### D5: Borderless collapsed thinking

**Decision**: Collapsed thinking sections render as borderless dim text lines. Border only wraps the expanded content area.

**Rationale**: VS Code's CSS confirmed: border is on `.chat-thinking-collapsible` (content area), not on `.chat-thinking-box` (container). When collapsed, the content is `display: none`, so no border is visible. This makes collapsed sections blend into the flow as dim scannable lines.

### D6: onToolStartRaw for pre-formatted messages

**Decision**: Added `onToolStartRaw(toolName, callId, message)` to bypass formatter args parsing.

**Rationale**: The backend's `extractArgSummary()` produces a human-readable string (e.g., "Q:\Software\investigation\file.ts"), not JSON args. `JSON.parse` on this always failed, producing empty args and broken tool messages. `onToolStartRaw` accepts the string directly and uses the formatter only for category/isPinnable classification.

### D7: Newline escaping in storage format

**Decision**: Escape `\n` → `\\n`, `\r` → `\\r`, `\\` → `\\\\` before storage. Unescape on read.

**Rationale**: The NUL-byte log format uses `\n` as record delimiter. Multi-line content (reasoning, tool output) was split into separate lines on replay, causing misclassification. This was THE root cause of the streaming vs replay rendering difference, identified by the adversarial team.

### D8: Partial buffering for out-of-order events

**Decision**: Buffer `tool.execution_partial_result` events in `_pendingPartials` when they arrive before the corresponding `tool.execution_start`.

**Rationale**: The Copilot CLI sometimes emits partial results before the start event for the same `toolCallId`. Without buffering, these partials are either lost (no tool name to attribute them to) or emitted as unattributed text (corrupting the output). On `tool.execution_start`, any buffered partials for that callId are flushed to the tool's output stream.

### D9: Path shortening in tool display messages

**Decision**: Shorten absolute paths to the last 2 segments (e.g., `Q:\Software\investigation\taco-helper\src\app.ts` → `src/app.ts`).

**Rationale**: Agent tool calls use absolute paths, which are long and obscure the meaningful filename. VS Code shows relative paths. `shortenPath()` normalizes and trims, `shortenToolMessage()` applies it to comma-separated path lists in tool messages.

### D10: FriendlyName display for non-MCP standalone tools

**Decision**: When `onToolStartRaw` receives an empty or trivial message, fall back to the formatter's `friendlyName` instead of showing a raw tool call ID.

**Rationale**: Some tools (especially edit tools) have minimal args summaries. The friendlyName ("Shell", "Read", "Search") provides a meaningful display label when the args-derived message is empty.

## Test Coverage

### condukt: 575 tests (46 suites)
- `__tests__/tool-display.test.ts`: 67 tests covering ResponsePartBuilder state machine, formatter, isPinnable, createToolInvocation, completeToolInvocation, type guards, view logic, format utils, onToolStartRaw, flush, edge cases

### taco-helper: 503 tests (24 suites)
- All existing test suites pass unchanged

## Known Limitations

1. **LLM-generated thinking titles**: VS Code uses `copilot-fast` to generate past-tense summaries. We generate titles from the first 2-3 tool invocation messages. Future work could add model-generated titles.

2. **GPT-5.4 verbose thinking**: GPT has no separate reasoning stream — its "thinking aloud" renders as full-size markdown. VS Code handles this the same way (no special treatment for GPT reasoning).

3. **Builder mutates parts in-place**: The `ResponsePartBuilder` mutates `ToolInvocation` and `ThinkingSectionPart` objects that React holds in state. This works because `flushParts` always triggers a re-render, but violates React's immutability contract. Future work should make the builder produce new objects on mutation.

4. **Tool name-based FIFO matching**: `pendingToolIds` matches tool completions by name, not by callId. Parallel same-name tools may mismatch. Future work should propagate the backend's toolCallId.

5. **Old investigation data**: Investigations run before the newline escaping fix have corrupted replay (multi-line content split into separate events). Re-running the investigation produces correct output. Old data is read-only and eventually deleted.
