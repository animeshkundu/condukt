/**
 * Typed response part model + builder for structured agent output rendering.
 *
 * Implements VS Code Copilot Chat's "pin to thinking" model:
 * - Pinnable tools (file, search, edit, shell) are absorbed into collapsible
 *   thinking sections with chain-of-thought vertical lines.
 * - Standalone tools (MCP, subagent, task) render as flat progress lines.
 * - Markdown (agent speech) renders full-size between sections.
 */

import type { ToolInvocation } from './types';
import type { ToolFormatterRegistry } from './formatter';
import { resolveFormatter, createToolInvocation, completeToolInvocation, isPinnable } from './formatter';

// ── Thinking section item types ──────────────────────────────────────────────

export interface ThinkingTextItem {
  readonly kind: 'thinking-text';
  content: string;
}

export interface PinnedToolItem {
  readonly kind: 'pinned-tool';
  tool: ToolInvocation;
}

export interface PinnedMarkdownItem {
  readonly kind: 'pinned-markdown';
  content: string;
}

export type ThinkingSectionItem = ThinkingTextItem | PinnedToolItem | PinnedMarkdownItem;

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
 * Pinnable tools and reasoning are absorbed into collapsible thinking sections.
 * Standalone tools (MCP, subagent) render as flat progress lines.
 * Agent speech (markdown) renders full-size between sections.
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
   * Finalizes any active thinking section, then merges into last markdown part.
   */
  onOutput(content: string): void {
    // If we have an active thinking section, pin the markdown there instead
    if (this._activeThinking) {
      // Only close thinking if there's no pending pinned tool in it
      const hasPendingPinned = this._activeThinking.items.some(
        item => item.kind === 'pinned-tool' && !item.tool.isComplete
      );
      if (hasPendingPinned) {
        // Pin markdown inside thinking section while tools are still running
        this._activeThinking.items.push({ kind: 'pinned-markdown', content });
        return;
      }
      this._finalizeThinking();
    }

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
   * Routes to: status line (metadata), thinking section (pinnable), or progress line (standalone).
   */
  onToolStart(toolName: string, toolCallId: string, args: Record<string, unknown>): void {
    // Metadata tools → status line
    if (this._metadataTools.has(toolName)) {
      const fmt = resolveFormatter(this._formatters, toolName);
      const msg = fmt.formatStart(toolName, args);
      if (msg) {
        this._parts.push({ kind: 'status', id: uid(), text: msg });
      }
      return;
    }

    const invocation = createToolInvocation(this._formatters, toolName, toolCallId, args);
    this._pendingTools.set(toolCallId, invocation);
    this._pendingArgs.set(toolCallId, args);

    if (invocation.isPinnable) {
      // Pin to active thinking section (create one if needed)
      this._ensureThinkingSection();
      this._activeThinking!.items.push({ kind: 'pinned-tool', tool: invocation });
    } else {
      // Standalone tool → flat progress line
      // Only finalize thinking if no pinned tools are still pending
      if (this._activeThinking) {
        const hasPending = this._activeThinking.items.some(
          item => item.kind === 'pinned-tool' && !item.tool.isComplete
        );
        if (!hasPending) { this._finalizeThinking(); }
      }
      this._parts.push({ kind: 'tool-progress', id: uid(), tool: invocation });
    }
  }

  /**
   * Called when a tool invocation completes.
   */
  onToolComplete(toolCallId: string, result: string, isError = false): void {
    const invocation = this._pendingTools.get(toolCallId);
    if (!invocation) { return; }

    const args = this._pendingArgs.get(toolCallId) ?? {};
    completeToolInvocation(this._formatters, invocation, result, args, isError);
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

  /** Append a dim metadata / status line. */
  onStatus(text: string): void {
    this._finalizeThinking();
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
      const summaries = pinnedTools.slice(0, 3).map(item => {
        const t = item.tool;
        return t.pastTenseMessage ?? t.invocationMessage;
      }).filter(s => s.length > 0);
      const more = pinnedTools.length > 3 ? ` + ${pinnedTools.length - 3} more` : '';
      section.title = summaries.length > 0 ? summaries.join(', ') + more : `${pinnedTools.length} tools`;
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

    this._activeThinking = null;
  }
}
