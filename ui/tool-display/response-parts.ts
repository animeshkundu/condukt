/**
 * Typed response part model + builder for structured agent output rendering.
 *
 * Replaces flat ANSI line lists with a typed part stream that maps
 * directly to React components. The builder is a state machine that
 * tracks pending tool invocations and merges adjacent markdown parts.
 */

import type { ToolInvocation, ToolCategory } from './types';
import type { ToolFormatterRegistry } from './formatter';
import { resolveFormatter, createToolInvocation, completeToolInvocation } from './formatter';

// ── Response part types ──────────────────────────────────────────────────────

export interface MarkdownPart {
  readonly kind: 'markdown';
  readonly id: string;
  content: string;
}

export interface ToolGroupPart {
  readonly kind: 'tool-group';
  readonly id: string;
  tools: ToolInvocation[];
  collapsed: boolean;
  status: 'running' | 'complete' | 'error';
}

export interface ThinkingPart {
  readonly kind: 'thinking';
  readonly id: string;
  content: string;
  collapsed: boolean;
}

export interface StatusPart {
  readonly kind: 'status';
  readonly id: string;
  text: string;
}

export type ResponsePart = MarkdownPart | ToolGroupPart | ThinkingPart | StatusPart;

// ── Metadata tools that render as status lines instead of tool groups ─────────

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
 * ResponseParts. Call the `on*` methods as events arrive; read `parts`
 * for the current state.
 *
 * Merges adjacent markdown, groups consecutive tool calls, and tracks
 * pending invocations via a toolCallId map.
 */
export class ResponsePartBuilder {
  private _parts: ResponsePart[] = [];
  private _pendingTools = new Map<string, ToolInvocation>();
  private _pendingArgs = new Map<string, Record<string, unknown>>();
  private _activeGroup: ToolGroupPart | null = null;
  private _activeThinking: ThinkingPart | null = null;
  private _formatters: ToolFormatterRegistry;
  private _metadataTools: Set<string>;

  constructor(opts?: ResponsePartBuilderOptions) {
    this._formatters = opts?.formatters ?? {};
    this._metadataTools = opts?.metadataTools ?? METADATA_TOOLS;
  }

  /** Current parts snapshot (mutable references — components should treat as immutable). */
  get parts(): readonly ResponsePart[] { return this._parts; }

  /** Number of tools currently pending (started but not completed). */
  get pendingToolCount(): number { return this._pendingTools.size; }

  // ── Markdown output ──────────────────────────────────────────────────────

  /**
   * Append agent speech / markdown content.
   * Merges into the last markdown part if the previous part is also markdown.
   */
  onOutput(content: string): void {
    this._closeThinking();

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
   */
  onToolStart(toolName: string, toolCallId: string, args: Record<string, unknown>): void {
    this._closeThinking();

    // Metadata tools → status line instead of tool group
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

    // Create or reuse active tool group
    if (this._activeGroup && this._activeGroup.status === 'running') {
      this._activeGroup.tools.push(invocation);
    } else {
      const group: ToolGroupPart = {
        kind: 'tool-group',
        id: uid(),
        tools: [invocation],
        collapsed: true,
        status: 'running',
      };
      this._activeGroup = group;
      this._parts.push(group);
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

    // Update group status when all tools in the group are complete
    if (this._activeGroup) {
      const allComplete = this._activeGroup.tools.every(t => t.isComplete);
      if (allComplete) {
        const hasError = this._activeGroup.tools.some(t => t.isError);
        this._activeGroup.status = hasError ? 'error' : 'complete';
        this._activeGroup = null;
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
   * Merges into the active thinking part if one exists.
   */
  onReasoning(content: string): void {
    if (this._activeThinking) {
      this._activeThinking.content += '\n' + content;
      return;
    }

    const part: ThinkingPart = {
      kind: 'thinking',
      id: uid(),
      content,
      collapsed: true,
    };
    this._activeThinking = part;
    this._parts.push(part);
  }

  // ── Status lines ─────────────────────────────────────────────────────────

  /** Append a dim metadata / status line. */
  onStatus(text: string): void {
    this._closeThinking();
    this._parts.push({ kind: 'status', id: uid(), text });
  }

  // ── Reset ────────────────────────────────────────────────────────────────

  /** Clear all state. */
  reset(): void {
    this._parts = [];
    this._pendingTools.clear();
    this._pendingArgs.clear();
    this._activeGroup = null;
    this._activeThinking = null;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private _closeThinking(): void {
    if (this._activeThinking) {
      this._activeThinking = null;
    }
  }
}
