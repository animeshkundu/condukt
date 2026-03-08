/**
 * Pure utility functions for tool output processing.
 *
 * Adapted from VS Code Copilot Chat (MIT). Zero framework dependencies.
 */

import type { TodoItem, TodoStatus } from './types';

// ── Tool result extraction ───────────────────────────────────────────────────

/**
 * Extract text from tool result content blocks.
 * Handles: string, array of `{ type: 'text', text }` blocks, or undefined.
 */
export function extractToolResultContent(
  content: string | ReadonlyArray<{ type: string; text?: string }> | undefined,
): string {
  if (!content) { return ''; }
  if (typeof content === 'string') { return content; }
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n');
}

// ── Reminder / XML tag stripping ─────────────────────────────────────────────

/**
 * Remove injected XML blocks from model output:
 * `<reminder>`, `<attachments>`, `<context>`, `<system-reminder>`,
 * `<current_datetime>`, `<pr_metadata …/>`, `<user_query …/>`.
 */
export function stripReminders(text: string): string {
  return text
    .replace(/<reminder>[\s\S]*?<\/reminder>\s*/g, '')
    .replace(/<attachments>[\s\S]*?<\/attachments>\s*/g, '')
    .replace(/<userRequest>[\s\S]*?<\/userRequest>\s*/g, '')
    .replace(/<context>[\s\S]*?<\/context>\s*/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '')
    .replace(/<current_datetime>[\s\S]*?<\/current_datetime>\s*/g, '')
    .replace(/<pr_metadata[^>]*\/?>\s*/g, '')
    .replace(/<user_query[^>]*\/?>\s*/g, '')
    .trim();
}

// ── cd prefix extraction ─────────────────────────────────────────────────────

export interface CdPrefix {
  directory: string;
  command: string;
}

/**
 * Split `cd <dir> && <command>` into directory + remaining command.
 * Supports both bash (`cd dir && cmd`) and powershell (`Set-Location -Path dir; cmd`).
 */
export function extractCdPrefix(commandLine: string, isPowershell = false): CdPrefix | undefined {
  const cdPrefixMatch = commandLine.match(
    isPowershell
      ? /^(?:cd(?: \/d)?|Set-Location(?: -Path)?) (?<dir>"[^"]*"|[^\s]+) ?(?:&&|;)\s+(?<suffix>.+)$/i
      : /^cd (?<dir>"[^"]*"|[^\s]+) &&\s+(?<suffix>.+)$/,
  );

  const cdDir = cdPrefixMatch?.groups?.dir;
  const cdSuffix = cdPrefixMatch?.groups?.suffix;

  if (cdDir && cdSuffix) {
    let directory = cdDir;
    if (directory.startsWith('"') && directory.endsWith('"')) {
      directory = directory.slice(1, -1);
    }
    return { directory, command: cdSuffix };
  }
  return undefined;
}

// ── Exit code parsing ────────────────────────────────────────────────────────

/**
 * Extract exit code from tool result text.
 * Recognises patterns like `exit code: 1`, `exited with exit code 0`,
 * and `<exited with exit code 127>`.
 */
export function parseExitCode(output: string): number | undefined {
  const match = /(?:exit code|exited with(?:\s+exit\s+code)?)[:=\s]*(\d+)/i.exec(output);
  return match ? parseInt(match[1], 10) : undefined;
}

/**
 * Remove the exit code trailer from tool output for cleaner display.
 */
export function stripExitCodeTrailer(output: string): string {
  return output
    .replace(/<exited with exit code \d+>\s*$/, '')
    .replace(/(?:exit code|exited with)[:=\s]*\d+\s*$/i, '')
    .trimEnd();
}

// ── Todo markdown parsing ────────────────────────────────────────────────────

export interface ParsedTodo {
  title: string;
  todoList: TodoItem[];
}

/**
 * Parse a markdown checklist into a structured todo list.
 *
 * Supports:
 * - `- [x]` / `- [X]` → completed
 * - `- [>]` / `- [~]` → in-progress
 * - `- [ ]`           → not-started
 * - Ordered lists (`1. [x]`)
 * - Code-fence-aware (ignores items inside fences)
 * - Multi-line items (continuation lines indented with 2+ spaces or tab)
 */
export function parseTodoMarkdown(markdown: string): ParsedTodo {
  const lines = markdown.split('\n');
  const todoList: TodoItem[] = [];
  let title = 'Updated todo list';
  let inCodeBlock = false;
  let currentItem: { title: string; status: TodoStatus } | null = null;

  for (const line of lines) {
    if (line.trim().startsWith('```') || line.trim().startsWith('~~~')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) { continue; }

    // Extract title from first non-empty, non-checklist line
    if (title === 'Updated todo list' && line.trim()) {
      const trimmed = line.trim();
      if (!trimmed.match(/^[-*+]\s+\[.\]/) && !trimmed.match(/^\d+[.)]\s+\[.\]/)) {
        title = trimmed.replace(/^#+\s*/, '');
      }
    }

    // Parse checklist items
    const unorderedMatch = line.match(/^\s*[-*+]\s+\[(.?)\]\s*(.*)$/);
    const orderedMatch = line.match(/^\s*\d+[.)]\s+\[(.?)\]\s*(.*)$/);
    const match = unorderedMatch || orderedMatch;

    if (match) {
      if (currentItem && currentItem.title.trim()) {
        todoList.push({ id: todoList.length + 1, title: currentItem.title.trim(), status: currentItem.status });
      }

      const checkboxChar = match[1];
      const itemTitle = match[2];

      let status: TodoStatus;
      if (checkboxChar === 'x' || checkboxChar === 'X') {
        status = 'completed';
      } else if (checkboxChar === '>' || checkboxChar === '~') {
        status = 'in-progress';
      } else {
        status = 'not-started';
      }

      currentItem = { title: itemTitle, status };
    } else if (currentItem && line.trim() && (line.startsWith('  ') || line.startsWith('\t'))) {
      currentItem.title += ' ' + line.trim();
    }
  }

  if (currentItem && currentItem.title.trim()) {
    todoList.push({ id: todoList.length + 1, title: currentItem.title.trim(), status: currentItem.status });
  }

  return { title, todoList };
}
