'use client';

import { useCallback, useEffect, useState } from 'react';

interface UseNodeArtifactOptions {
  executionId: string | null;
  nodeId: string | null;
  /** Artifact filename to fetch (default: 'output.md'). */
  filename?: string;
  /** Base URL for API requests (default: ''). */
  baseUrl?: string;
  /** Custom URL builder for consumers with non-standard routes. */
  urlBuilder?: (execId: string, nodeId: string, filename: string) => string;
}

interface ArtifactResult {
  content: string | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Hook for fetching node artifact content on demand.
 * Returns markdown content, loading state, and error state.
 */
export function useNodeArtifact({
  executionId,
  nodeId,
  filename = 'output.md',
  baseUrl = '',
  urlBuilder,
}: UseNodeArtifactOptions): ArtifactResult {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchArtifact = useCallback(async () => {
    if (!executionId || !nodeId) return;
    setLoading(true);
    setError(null);
    try {
      const url = urlBuilder
        ? urlBuilder(executionId, nodeId, filename)
        : `${baseUrl}/api/executions/${executionId}/nodes/${nodeId}/artifact?filename=${encodeURIComponent(filename)}`;
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 404) {
          setContent(null);
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      setContent(data.content ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fetch error');
      setContent(null);
    } finally {
      setLoading(false);
    }
  }, [executionId, nodeId, filename, baseUrl, urlBuilder]);

  useEffect(() => {
    fetchArtifact();
  }, [fetchArtifact]);

  return { content, loading, error, refetch: fetchArtifact };
}
