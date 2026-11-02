/** Test helpers for parsing Anthropic SSE frames produced by translators. */

export interface ParsedEvent {
  readonly event: string;
  readonly data: any;
}

/** Parse full SSE frame strings into {event, data} pairs. */
export function parseFrames(frames: readonly string[]): ParsedEvent[] {
  const out: ParsedEvent[] = [];
  for (const frame of frames) {
    const match = /^event: ([^\n]+)\ndata: (.*)\n\n$/s.exec(frame);
    if (!match) continue;
    try {
      out.push({ event: match[1], data: JSON.parse(match[2]) });
    } catch {
      out.push({ event: match[1], data: match[2] });
    }
  }
  return out;
}

export function events(frames: readonly string[]): string[] {
  return parseFrames(frames).map((p) => p.event);
}

export function eventData(frames: readonly string[], event: string): any[] {
  return parseFrames(frames)
    .filter((p) => p.event === event)
    .map((p) => p.data);
}
