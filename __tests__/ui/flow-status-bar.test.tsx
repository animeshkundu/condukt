// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { FlowStatusBar } from '../../ui/components/FlowStatusBar';
import type { ExecutionProjection } from '../../src/types';

afterEach(cleanup);

function makeProjection(overrides: Partial<ExecutionProjection> = {}): ExecutionProjection {
  return {
    id: 'exec-1',
    flowId: 'flow-1',
    status: 'running',
    params: {},
    graph: {
      nodes: [
        { id: 'n1', displayName: 'Step 1', nodeType: 'agent', status: 'completed', attempt: 1, iteration: 0 },
        { id: 'n2', displayName: 'Step 2', nodeType: 'agent', status: 'running', attempt: 1, iteration: 0 },
        { id: 'n3', displayName: 'Step 3', nodeType: 'agent', status: 'pending', attempt: 1, iteration: 0 },
      ],
      edges: [],
      activeNodes: ['n2'],
      completedPath: ['n1'],
    },
    totalCost: 0,
    metadata: {},
    ...overrides,
  };
}

describe('FlowStatusBar', () => {
  it('renders status counts for each status', () => {
    const { container } = render(<FlowStatusBar projection={makeProjection()} />);
    const text = container.textContent ?? '';
    expect(text).toContain('1');
    expect(text).toContain('completed');
    expect(text).toContain('running');
    expect(text).toContain('pending');
  });

  it('renders execution status text', () => {
    const { container } = render(<FlowStatusBar projection={makeProjection({ status: 'running' })} />);
    expect(container.textContent).toContain('running');
  });

  it('renders completed status', () => {
    const proj = makeProjection({
      status: 'completed',
      graph: {
        nodes: [
          { id: 'n1', displayName: 'S1', nodeType: 'agent', status: 'completed', attempt: 1, iteration: 0 },
          { id: 'n2', displayName: 'S2', nodeType: 'agent', status: 'completed', attempt: 1, iteration: 0 },
        ],
        edges: [],
        activeNodes: [],
        completedPath: ['n1', 'n2'],
      },
    });
    const { container } = render(<FlowStatusBar projection={proj} />);
    expect(container.textContent).toContain('2');
    expect(container.textContent).toContain('completed');
  });

  it('renders duration when startedAt and finishedAt present', () => {
    const proj = makeProjection({ startedAt: 1000, finishedAt: 6000 });
    const { container } = render(<FlowStatusBar projection={proj} />);
    expect(container.textContent).toContain('5s');
  });

  it('renders elapsed time when only startedAt present', () => {
    const now = Date.now();
    const proj = makeProjection({ startedAt: now - 10000 });
    const { container } = render(<FlowStatusBar projection={proj} />);
    // Should show approximately 10s
    expect(container.textContent).toMatch(/\d+s/);
  });

  it('renders total cost when > 0', () => {
    const proj = makeProjection({ totalCost: 1.23 });
    const { container } = render(<FlowStatusBar projection={proj} />);
    expect(container.textContent).toContain('$1.23');
  });

  it('does not render cost when 0', () => {
    const proj = makeProjection({ totalCost: 0 });
    const { container } = render(<FlowStatusBar projection={proj} />);
    expect(container.textContent).not.toContain('$');
  });

  it('shows failed count when nodes have failed', () => {
    const proj = makeProjection({
      status: 'failed',
      graph: {
        nodes: [
          { id: 'n1', displayName: 'S1', nodeType: 'agent', status: 'completed', attempt: 1, iteration: 0 },
          { id: 'n2', displayName: 'S2', nodeType: 'agent', status: 'failed', attempt: 1, iteration: 0 },
        ],
        edges: [],
        activeNodes: [],
        completedPath: ['n1'],
      },
    });
    const { container } = render(<FlowStatusBar projection={proj} />);
    expect(container.textContent).toContain('failed');
  });

  it('shows gated count when nodes are gated', () => {
    const proj = makeProjection({
      graph: {
        nodes: [
          { id: 'n1', displayName: 'S1', nodeType: 'gate', status: 'gated', attempt: 1, iteration: 0 },
        ],
        edges: [],
        activeNodes: ['n1'],
        completedPath: [],
      },
    });
    const { container } = render(<FlowStatusBar projection={proj} />);
    expect(container.textContent).toContain('gated');
  });
});
