/**
 * Typed response part model + builder for structured agent output rendering.
 *
 * Implements VS Code Copilot Chat's "pin to thinking" model:
 * - Pinnable tools (file, search, edit, shell) are absorbed into collapsible
 *   thinking sections — only the progress line (icon + message), never output.
 * - Standalone tools (MCP, subagent, task) render as flat progress lines.
 * - Markdown (agent speech) ALWAYS renders full-size, never absorbed into thinking.
 * - Tool output goes to onToolOutput() and is invisible in thinking blocks.
 */

import type { ToolInvocation, ToolCategory, ToolSpecificData } from './types';
import type { ToolFormatterRegistry } from './formatter';
import { resolveFormatter, createToolInvocation, completeToolInvocation, isPinnable, computeVerb } from './formatter';
import { shortenToolMessage } from './format-utils';

// ── Thinking section item types ──────────────────────────────────────────────

export interface ThinkingTextItem {
  readonly kind: 'thinking-text';
  content: string;
}

export interface PinnedToolItem {
  readonly kind: 'pinned-tool';
  tool: ToolInvocation;
}

export type ThinkingSectionItem = ThinkingTextItem | PinnedToolItem;

// ── Response part types ──────────────────────────────────────────────────────

export interface MarkdownPart {
  readonly kind: 'markdown';
  readonly id: string;
  content: string;
}

export interface ToolProgressPart {
  readonly kind: 'tool-progress';
  readonly id: string;
  tool: ToolInvocation;
}

export interface ThinkingSectionPart {
  readonly kind: 'thinking-section';
  readonly id: string;
  items: ThinkingSectionItem[];
  title: string;
  verb: string;
  collapsed: boolean;
  active: boolean;
}

export interface StatusPart {
  readonly kind: 'status';
  readonly id: string;
  text: string;
}

export type ResponsePart = MarkdownPart | ToolProgressPart | ThinkingSectionPart | StatusPart;

// ── Metadata tools that render as status lines ───────────────────────────────

const METADATA_TOOLS = new Set([
  'report_intent', 'think', 'report_progress', 'skill', 'Skill',
  'EnterPlanMode', 'AskUserQuestion', 'ask_user',
]);

// ── ResponsePartBuilder ──────────────────────────────────────────────────────

let nextId = 0;
function uid(): string { return `rp-${++nextId}`; }

export interface ResponsePartBuilderOptions {
  /** Tool formatter registry. If not provided, uses builtins only. */
  formatters?: ToolFormatterRegistry;
  /** Treat these tool names as metadata (dim status lines). */
  metadataTools?: Set<string>;
}

/**
 * State machine that accumulates streaming agent events into typed
 * ResponseParts using VS Code's pin-to-thinking model.
 *
 * Key rules (matching VS Code exactly):
 * - Tool output is NEVER shown inside thinking blocks — only progress lines
 * - Agent speech (onOutput) ALWAYS finalizes thinking and renders standalone
 * - Reasoning (onReasoning) is always pinned to the thinking section
 * - Tool streaming output goes to onToolOutput (invisible in UI)
 */
export class ResponsePartBuilder {
  private _parts: ResponsePart[] = [];
  private _pendingTools = new Map<string, ToolInvocation>();
  private _pendingArgs = new Map<string, Record<string, unknown>>();
  private _activeThinking: ThinkingSectionPart | null = null;
  private _formatters: ToolFormatterRegistry;
  private _metadataTools: Set<string>;

  constructor(opts?: ResponsePartBuilderOptions) {
    this._formatters = opts?.formatters ?? {};
    this._metadataTools = opts?.metadataTools ?? METADATA_TOOLS;
  }

  /** Current parts snapshot. */
  get parts(): readonly ResponsePart[] { return this._parts; }

  /** Number of tools currently pending (started but not completed). */
  get pendingToolCount(): number { return this._pendingTools.size; }

  // ── Markdown output ──────────────────────────────────────────────────────

  /**
   * Append agent speech / markdown content.
   * ALWAYS finalizes any active thinking section and renders standalone.
   * VS Code rule: output text is never absorbed into thinking blocks.
   */
  onOutput(content: string): void {
    this._finalizeThinking();

    const last = this._parts[this._parts.length - 1];
    if (last?.kind === 'markdown') {
      last.content += content;
      return;
    }

    this._parts.push({ kind: 'markdown', id: uid(), content });
  }

  // ── Tool lifecycle ───────────────────────────────────────────────────────

  /**
   * Called when a tool invocation starts.
   * Routes to: silently ignored (metadata), thinking section (pinnable), or progress line (standalone).
   */
  onToolStart(toolName: string, toolCallId: string, args: Record<string, unknown>): void {
    // Metadata tools → silently ignored (ephemeral progress, VS Code hides them)
    if (this._metadataTools.has(toolName)) {
      return;
    }

    const invocation = createToolInvocation(this._formatters, toolName, toolCallId, args);
    this._pendingTools.set(toolCallId, invocation);
    this._pendingArgs.set(toolCallId, args);

    this._routeInvocation(invocation);
  }

  /**
   * Start a tool with a pre-formatted invocation message from the backend.
   * Bypasses formatter args parsing — useful when the backend provides
   * a human-readable summary instead of raw JSON args.
   */
  onToolStartRaw(toolName: string, toolCallId: string, message: string): void {
    // Metadata tools → silently ignored (ephemeral progress, VS Code hides them)
    if (this._metadataTools.has(toolName)) {
      return;
    }

    const fmt = resolveFormatter(this._formatters, toolName);
    const category = fmt.category;
    const invocation: ToolInvocation = {
      toolName,
      toolCallId,
      category,
      friendlyName: fmt.friendlyName,
      verb: computeVerb(category),
      serverName: undefined,
      isPinnable: isPinnable(toolName),
      invocationMessage: shortenToolMessage(message) || fmt.friendlyName,
      isComplete: false,
      isError: false,
      output: [],
    };

    this._pendingTools.set(toolCallId, invocation);
    this._pendingArgs.set(toolCallId, {});

    this._routeInvocation(invocation);
  }

  /**
   * Called when a tool invocation completes.
   *
   * When toolSpecificData is provided (e.g. from SDK rich events), it takes
   * precedence over the formatter's formatComplete() output. This preserves
   * backward compatibility -- SubprocessBackend still uses string-based formatters.
   */
  onToolComplete(toolCallId: string, result: string, isError = false, toolSpecificData?: ToolSpecificData): void {
    const invocation = this._pendingTools.get(toolCallId);
    if (!invocation) { return; }

    const args = this._pendingArgs.get(toolCallId) ?? {};
    completeToolInvocation(this._formatters, invocation, result, args, isError);

    // Override with structured data when provided by the SDK
    if (toolSpecificData) {
      invocation.toolSpecificData = toolSpecificData;
    }

    this._pendingTools.delete(toolCallId);
    this._pendingArgs.delete(toolCallId);

    // If this was a pinned tool, check if all pinned tools in the section are done
    if (this._activeThinking && invocation.isPinnable) {
      const allPinnedDone = this._activeThinking.items.every(
        item => item.kind !== 'pinned-tool' || item.tool.isComplete
      );
      if (allPinnedDone) {
        this._finalizeThinking();
      }
    }
  }

  /**
   * Append streaming output to a pending tool invocation.
   * This output is NOT visible in thinking blocks — it's stored on the
   * tool's output[] array for tools that want to display it elsewhere.
   */
  onToolOutput(toolCallId: string, line: string): void {
    const invocation = this._pendingTools.get(toolCallId);
    if (invocation) {
      invocation.output.push(line);
    }
  }

  // ── Reasoning / thinking ─────────────────────────────────────────────────

  /**
   * Append reasoning / thinking content.
   * Always pins to the active thinking section (creating one if needed).
   */
  onReasoning(content: string): void {
    if (!content) return;

    this._ensureThinkingSection();

    // Merge with last thinking-text item if possible
    const items = this._activeThinking!.items;
    const last = items[items.length - 1];
    if (last?.kind === 'thinking-text') {
      last.content += '\n' + content;
    } else {
      items.push({ kind: 'thinking-text', content });
    }
  }

  // ── Status lines ─────────────────────────────────────────────────────────

  /** Append a dim metadata / status line. Does not interrupt thinking flow. */
  onStatus(text: string): void {
    this._parts.push({ kind: 'status', id: uid(), text });
  }

  // ── Reset ────────────────────────────────────────────────────────────────

  /** Finalize any open thinking section. Call when stream ends. */
  flush(): void {
    this._finalizeThinking();
  }

  /** Clear all state. */
  reset(): void {
    this._parts = [];
    this._pendingTools.clear();
    this._pendingArgs.clear();
    this._activeThinking = null;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  /** Route a tool invocation to thinking section (pinnable) or progress line (standalone). */
  private _routeInvocation(invocation: ToolInvocation): void {
    if (invocation.isPinnable) {
      // Pin to active thinking section (create one if needed)
      this._ensureThinkingSection();
      this._activeThinking!.items.push({ kind: 'pinned-tool', tool: invocation });
    } else {
      // Standalone tool → flat progress line (does NOT finalize thinking)
      // VS Code: standalone tools render alongside thinking section, don't interrupt it.
      // Thinking is only finalized by agent speech (onOutput) or stream end (flush).
      this._parts.push({ kind: 'tool-progress', id: uid(), tool: invocation });
    }
  }

  /** Ensure a thinking section exists. Creates one if needed. */
  private _ensureThinkingSection(): void {
    if (this._activeThinking) { return; }

    const section: ThinkingSectionPart = {
      kind: 'thinking-section',
      id: uid(),
      items: [],
      title: 'Working',
      verb: 'Working',
      collapsed: false,
      active: true,
    };
    this._activeThinking = section;
    this._parts.push(section);
  }

  /** Finalize the active thinking section: generate title, collapse, deactivate. */
  private _finalizeThinking(): void {
    if (!this._activeThinking) { return; }

    const section = this._activeThinking;
    section.active = false;
    section.collapsed = true;

    // Generate summary title from pinned tools
    const pinnedTools = section.items.filter(
      (item): item is PinnedToolItem => item.kind === 'pinned-tool'
    );

    if (pinnedTools.length > 0) {
      if (pinnedTools.length <= 3) {
        const summaries = pinnedTools.map(item => {
          const t = item.tool;
          return t.pastTenseMessage ?? t.invocationMessage;
        }).filter(s => s.length > 0);
        section.title = summaries.join(', ') || `${pinnedTools.length} tools`;
      } else {
        // 4+ tools: "Read file.ts, Searched for pattern + 3 more"
        const first2 = pinnedTools.slice(0, 2).map(item => {
          const t = item.tool;
          return t.pastTenseMessage ?? t.invocationMessage;
        }).filter(s => s.length > 0);
        section.title = first2.length > 0
          ? `${first2.join(', ')} + ${pinnedTools.length - 2} more`
          : `Finished with ${pinnedTools.length} steps`;
      }
      section.verb = pinnedTools[0].tool.verb;
    } else {
      // Thinking-only section
      const thinkingItems = section.items.filter(item => item.kind === 'thinking-text');
      if (thinkingItems.length > 0) {
        const firstLine = thinkingItems[0].content.split('\n')[0];
        section.title = firstLine.length > 60 ? firstLine.slice(0, 57) + '...' : firstLine;
        section.verb = 'Thought about';
      }
    }

    // G5: Single-item restoration — if finalized section has 1 pinned tool and no text,
    // restore it as a standalone tool-progress line (VS Code behavior).
    const pinnedToolItems = section.items.filter(
      (item): item is PinnedToolItem => item.kind === 'pinned-tool'
    );
    const thinkingTextItems = section.items.filter(item => item.kind === 'thinking-text');

    if (pinnedToolItems.length === 1 && thinkingTextItems.length === 0) {
      const idx = this._parts.indexOf(section);
      if (idx >= 0) {
        this._parts[idx] = {
          kind: 'tool-progress',
          id: section.id,
          tool: pinnedToolItems[0].tool,
        };
      }
    }

    this._activeThinking = null;
  }
}
