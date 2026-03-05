'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExecutionProjection } from '../../src/types';
import type { ExecutionEvent } from '../../src/events';

export type FlowSSEStatus = 'connecting' | 'open' | 'closed' | 'error';

interface UseFlowExecutionOptions {
  /** Execution ID to fetch. Null = don't fetch. */
  executionId: string | null;
  /** Base URL for API requests (default: ''). */
  baseUrl?: string;
  /** Polling fallback interval in ms (default: 5000). Used when SSE disconnects. */
  pollInterval?: number;
}

/**
 * Hook for a single flow execution: fetches projection + subscribes to SSE stream.
 *
 * Returns the current projection (updated in real-time via SSE) and status.
 */
export function useFlowExecution({ executionId, baseUrl = '', pollInterval = 5000 }: UseFlowExecutionOptions) {
  const [projection, setProjection] = useState<ExecutionProjection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sseStatus, setSseStatus] = useState<FlowSSEStatus>('closed');

  const sourceRef = useRef<EventSource | null>(null);

  // Fetch the projection (initial load + fallback refresh)
  const fetchProjection = useCallback(async () => {
    if (!executionId) return;
    try {
      const res = await fetch(`${baseUrl}/api/executions/${executionId}`);
      if (!res.ok) {
        setError(`Failed to fetch execution: ${res.status}`);
        return;
      }
      const data = (await res.json()) as ExecutionProjection;
      setProjection(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fetch error');
    } finally {
      setLoading(false);
    }
  }, [executionId, baseUrl]);

  // SSE subscription for real-time updates
  useEffect(() => {
    if (!executionId) {
      setProjection(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    fetchProjection();

    const url = `${baseUrl}/api/executions/${executionId}/stream`;
    const source = new EventSource(url);
    sourceRef.current = source;
    setSseStatus('connecting');

    source.onopen = () => setSseStatus('open');

    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'heartbeat') return;

        // Snapshot event: replace entire projection
        if (data.type === 'snapshot' && data.projection) {
          setProjection(data.projection);
          setLoading(false);
          return;
        }

        // Live event: refetch projection to get updated state
        fetchProjection();
      } catch {
        // Ignore unparseable events
      }
    };

    source.onerror = () => {
      setSseStatus('error');
      source.close();
      sourceRef.current = null;
    };

    return () => {
      source.close();
      sourceRef.current = null;
      setSseStatus('closed');
    };
  }, [executionId, baseUrl, fetchProjection]);

  // Polling fallback when SSE is down
  useEffect(() => {
    if (sseStatus !== 'error' && sseStatus !== 'closed') return;
    if (!executionId) return;

    const timer = setInterval(fetchProjection, pollInterval);
    return () => clearInterval(timer);
  }, [sseStatus, executionId, pollInterval, fetchProjection]);

  return { projection, loading, error, sseStatus, refetch: fetchProjection };
}

/**
 * Hook for the executions list.
 */
export function useFlowExecutions(baseUrl = '') {
  const [executions, setExecutions] = useState<ExecutionProjection[]>([]);
  const [loading, setLoading] = useState(true);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/executions`);
      if (res.ok) {
        setExecutions((await res.json()) as ExecutionProjection[]);
      }
    } finally {
      setLoading(false);
    }
  }, [baseUrl]);

  useEffect(() => { fetch_(); }, [fetch_]);

  return { executions, loading, refetch: fetch_ };
}
