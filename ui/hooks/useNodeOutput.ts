'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { OutputPage } from '../../src/types';

interface UseNodeOutputOptions {
  executionId: string | null;
  nodeId: string | null;
  /** Base URL for API requests (default: ''). */
  baseUrl?: string;
  /** Whether to auto-scroll to bottom on new output (default: true) */
  autoScroll?: boolean;
}

/**
 * Hook for per-node output streaming.
 * Fetches initial output, then subscribes to SSE for live updates.
 */
export function useNodeOutput({ executionId, nodeId, baseUrl = '', autoScroll = true }: UseNodeOutputOptions) {
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const sourceRef = useRef<EventSource | null>(null);
  const scrollRef = useRef<HTMLElement | null>(null);

  // Fetch initial output
  const fetchOutput = useCallback(async () => {
    if (!executionId || !nodeId) return;
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/executions/${executionId}/nodes/${nodeId}/output?limit=10000`);
      if (res.ok) {
        const page = (await res.json()) as OutputPage;
        setLines(page.lines as string[]);
        setTotal(page.total);
      }
    } finally {
      setLoading(false);
    }
  }, [executionId, nodeId, baseUrl]);

  // SSE for live output
  useEffect(() => {
    if (!executionId || !nodeId) {
      setLines([]);
      return;
    }

    fetchOutput();

    const url = `${baseUrl}/api/executions/${executionId}/nodes/${nodeId}/stream`;
    const source = new EventSource(url);
    sourceRef.current = source;

    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'heartbeat') return;
        if ((data.type === 'node:output' || data.type === 'node:reasoning') && data.content) {
          const line = data.type === 'node:reasoning'
            ? `\x1b[2m[thinking] ${data.content}\x1b[0m`
            : data.content;
          setLines((prev) => [...prev, line]);
          setTotal((prev) => prev + 1);

          // Auto-scroll
          if (autoScroll && scrollRef.current) {
            requestAnimationFrame(() => {
              scrollRef.current?.scrollTo({
                top: scrollRef.current.scrollHeight,
                behavior: 'smooth',
              });
            });
          }
        }
      } catch { /* ignore */ }
    };

    source.onerror = () => {
      source.close();
      sourceRef.current = null;
    };

    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, [executionId, nodeId, baseUrl, fetchOutput, autoScroll]);

  return { lines, total, loading, scrollRef, refetch: fetchOutput };
}
