/**
 * CI/CD pipeline composition — proves framework genericity.
 *
 * Zero investigation imports. Uses only generic flow primitives.
 * If this compiles, the framework is truly generic.
 *
 * Pipeline: lint + test (parallel) → build → deploy (conditional on env)
 */

import { deterministic, gate } from '../../src/nodes.js';
import type { FlowGraph, NodeInput, NodeOutput } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Nodes — all deterministic (no LLM, no runtime needed)
// ---------------------------------------------------------------------------

const lint = deterministic(
  'Lint',
  async (input: NodeInput): Promise<NodeOutput> => {
    // Simulate linting
    const hasErrors = (input.params as { lintErrors?: boolean }).lintErrors ?? false;
    return {
      action: hasErrors ? 'fail' : 'default',
      artifact: hasErrors ? 'Lint errors found' : 'Lint passed',
    };
  },
);

const test = deterministic(
  'Test',
  async (input: NodeInput): Promise<NodeOutput> => {
    // Simulate test run
    const passing = (input.params as { testsPassing?: boolean }).testsPassing ?? true;
    return {
      action: passing ? 'default' : 'fail',
      artifact: passing ? 'All tests passed' : 'Test failures detected',
      metadata: { testCount: 42, duration: 1234 },
    };
  },
);

const build = deterministic(
  'Build',
  async (_input: NodeInput): Promise<NodeOutput> => {
    return {
      action: 'default',
      artifact: 'Build succeeded: dist/app.js (1.2MB)',
      metadata: { buildSize: 1200000 },
    };
  },
);

const deploy = deterministic(
  'Deploy',
  async (input: NodeInput): Promise<NodeOutput> => {
    const env = (input.params as { environment?: string }).environment ?? 'staging';
    return {
      action: 'default',
      artifact: `Deployed to ${env}`,
      metadata: { environment: env, deployedAt: Date.now() },
    };
  },
);

const approval = gate('Production Deployment Approval');

// ---------------------------------------------------------------------------
// Flow composition
// ---------------------------------------------------------------------------

export const cicdFlow: FlowGraph = {
  nodes: {
    lint: { fn: lint, displayName: 'Lint', nodeType: 'deterministic', output: 'lint.txt' },
    test: { fn: test, displayName: 'Test', nodeType: 'deterministic', output: 'test.txt' },
    build: { fn: build, displayName: 'Build', nodeType: 'deterministic', output: 'build.txt', reads: ['lint.txt', 'test.txt'] },
    approval: { fn: approval, displayName: 'Production Approval', nodeType: 'gate' },
    deploy: { fn: deploy, displayName: 'Deploy', nodeType: 'deterministic', output: 'deploy.txt', reads: ['build.txt'] },
  },
  edges: {
    lint: { default: 'build', fail: 'end' },
    test: { default: 'build', fail: 'end' },
    build: { default: 'approval' },
    approval: { approved: 'deploy', rejected: 'end' },
  },
  start: ['lint', 'test'],
};
