/**
 * ANSI escape code handling for copilot CLI output.
 * Ported from geneva-dashboard — handles SGR codes for colors, bold, dim.
 */

/** Returns true if the text contains any ANSI escape sequences. */
export function hasAnsi(text: string): boolean {
  return text.includes('\x1b');
}

const SGR_COLORS: Record<number, string> = {
  30: '#3a3a3a', 31: '#ef4444', 32: '#22c55e', 33: '#eab308',
  34: '#3b82f6', 35: '#a855f7', 36: '#06b6d4', 37: '#d4d4d8',
  90: '#71717a', 91: '#f87171', 92: '#4ade80', 93: '#facc15',
  94: '#60a5fa', 95: '#c084fc', 96: '#22d3ee', 97: '#fafafa',
};

interface AnsiState { color: string | null; bold: boolean; dim: boolean; }

function applySgr(state: AnsiState, params: string): void {
  const codes = params === '' ? [0] : params.split(';').map(Number);
  for (const code of codes) {
    if (code === 0) { state.color = null; state.bold = false; state.dim = false; }
    else if (code === 1) state.bold = true;
    else if (code === 2) state.dim = true;
    else if (code === 22) { state.bold = false; state.dim = false; }
    else if (code === 39) state.color = null;
    else if (SGR_COLORS[code]) state.color = SGR_COLORS[code];
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function spanWrap(text: string, state: AnsiState): string {
  const styles: string[] = [];
  if (state.color) styles.push(`color:${state.color}`);
  if (state.bold) styles.push('font-weight:bold');
  if (state.dim) styles.push('opacity:0.6');
  return styles.length === 0 ? text : `<span style="${styles.join(';')}">${text}</span>`;
}

export function ansiToHtml(text: string): string {
  const state: AnsiState = { color: null, bold: false, dim: false };
  let result = '';
  let lastIndex = 0;
  const pattern = /\x1b\[([0-9;]*)([A-Za-z])|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[A-Z]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index);
    if (before) result += spanWrap(escapeHtml(before), state);
    lastIndex = match.index + match[0].length;
    if (match[2] === 'm' && match[1] !== undefined) applySgr(state, match[1]);
  }
  const remaining = text.slice(lastIndex);
  if (remaining) result += spanWrap(escapeHtml(remaining), state);
  return result;
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[A-Z]/g, '');
}
