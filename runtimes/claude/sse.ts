/**
 * Minimal SSE framing helpers shared by the bridge translators.
 */

/** Format one Anthropic SSE frame. */
export function sseFrame(event: string | null, payload: unknown): string {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (event) return `event: ${event}\ndata: ${data}\n\n`;
  return `data: ${data}\n\n`;
}

/**
 * Incremental line splitter for upstream SSE byte streams.
 * Feed decoded text; receive complete lines (no trailing newline).
 */
export function createLineReader(): { push(chunk: string): string[]; flush(): string[] } {
  let buffer = '';
  return {
    push(chunk: string): string[] {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      return lines;
    },
    flush(): string[] {
      const rest = buffer;
      buffer = '';
      return rest ? [rest] : [];
    },
  };
}

/** Extract the JSON payload of a `data:` SSE line, or null. */
export function parseDataLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const data = trimmed.slice(5).trim();
  if (!data || data === '[DONE]') return null;
  return data;
}
