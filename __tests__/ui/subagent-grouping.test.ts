/**
 * ResponsePartBuilder sub-agent grouping tests.
 *
 * Verifies that sub-agent lifecycle events (start, child tool/text, end)
 * are correctly routed into SubagentSectionPart entries, including
 * out-of-order buffering, concurrent sub-agents, and reset semantics.
 */

import { describe, it, expect } from 'vitest';

import {
  ResponsePartBuilder,
} from '../../ui/tool-display/response-parts';

import type { SubagentSectionPart } from '../../ui/tool-display/types';

import { createToolFormatterRegistry } from '../../ui/tool-display/formatter';

describe('ResponsePartBuilder sub-agent grouping', () => {
  it('onSubagentStart creates a SubagentSectionPart', () => {
    const builder = new ResponsePartBuilder();
    builder.onSubagentStart('tc-sa-1', 'reviewer', 'Code Reviewer', 'Review the PR');

    expect(builder.parts).toHaveLength(1);
    const section = builder.parts[0] as SubagentSectionPart;
    expect(section.kind).toBe('subagent-section');
    expect(section.toolCallId).toBe('tc-sa-1');
    expect(section.agentName).toBe('reviewer');
    expect(section.agentDisplayName).toBe('Code Reviewer');
    expect(section.description).toBe('Review the PR');
    expect(section.status).toBe('running');
    expect(section.items).toHaveLength(0);
  });

  it('child tool with parentToolCallId routes into sub-agent section', () => {
    const builder = new ResponsePartBuilder({ formatters: createToolFormatterRegistry() });
    builder.onSubagentStart('tc-sa-1', 'worker', 'Worker');

    builder.onToolStart('Read', 'tc-child-1', { file_path: 'src/app.ts' }, 'tc-sa-1');

    const section = builder.parts[0] as SubagentSectionPart;
    expect(section.items).toHaveLength(1);
    expect(section.items[0].kind).toBe('pinned-tool');
    if (section.items[0].kind === 'pinned-tool') {
      expect(section.items[0].tool.toolName).toBe('Read');
      expect(section.items[0].tool.toolCallId).toBe('tc-child-1');
    }
  });

  it('child text with parentToolCallId routes into sub-agent section', () => {
    const builder = new ResponsePartBuilder();
    builder.onSubagentStart('tc-sa-1', 'worker', 'Worker');

    builder.onOutput('Found an issue in line 42', 'tc-sa-1');

    const section = builder.parts[0] as SubagentSectionPart;
    expect(section.items).toHaveLength(1);
    expect(section.items[0].kind).toBe('agent-text');
    if (section.items[0].kind === 'agent-text') {
      expect(section.items[0].content).toBe('Found an issue in line 42');
    }
  });

  it('text without parentToolCallId stays in parent stream', () => {
    const builder = new ResponsePartBuilder();
    builder.onSubagentStart('tc-sa-1', 'worker', 'Worker');
    builder.onOutput('This is parent speech');

    // Should be 2 parts: subagent-section + markdown
    expect(builder.parts).toHaveLength(2);
    expect(builder.parts[0].kind).toBe('subagent-section');
    expect(builder.parts[1].kind).toBe('markdown');
    if (builder.parts[1].kind === 'markdown') {
      expect(builder.parts[1].content).toBe('This is parent speech');
    }
  });

  it('onSubagentEnd finalizes section status', () => {
    const builder = new ResponsePartBuilder();
    builder.onSubagentStart('tc-sa-1', 'worker', 'Worker');
    builder.onSubagentEnd('tc-sa-1');

    const section = builder.parts[0] as SubagentSectionPart;
    expect(section.status).toBe('completed');
    expect(section.error).toBeUndefined();
  });

  it('onSubagentEnd with error sets failed status', () => {
    const builder = new ResponsePartBuilder();
    builder.onSubagentStart('tc-sa-1', 'worker', 'Worker');
    builder.onSubagentEnd('tc-sa-1', 'Tool execution failed');

    const section = builder.parts[0] as SubagentSectionPart;
    expect(section.status).toBe('failed');
    expect(section.error).toBe('Tool execution failed');
  });

  it('concurrent sub-agents create separate sections', () => {
    const builder = new ResponsePartBuilder({ formatters: createToolFormatterRegistry() });
    builder.onSubagentStart('tc-sa-1', 'reviewer', 'Reviewer');
    builder.onSubagentStart('tc-sa-2', 'tester', 'Tester');

    // Route child events to each sub-agent
    builder.onOutput('Review note', 'tc-sa-1');
    builder.onToolStart('Read', 'tc-child-1', { file_path: 'test.ts' }, 'tc-sa-2');

    const section1 = builder.parts[0] as SubagentSectionPart;
    const section2 = builder.parts[1] as SubagentSectionPart;

    expect(section1.agentName).toBe('reviewer');
    expect(section1.items).toHaveLength(1);
    expect(section1.items[0].kind).toBe('agent-text');

    expect(section2.agentName).toBe('tester');
    expect(section2.items).toHaveLength(1);
    expect(section2.items[0].kind).toBe('pinned-tool');
  });

  it('out-of-order: child event before subagent.started gets buffered and flushed', () => {
    const builder = new ResponsePartBuilder({ formatters: createToolFormatterRegistry() });

    // Child tool arrives BEFORE subagent.started
    builder.onToolStart('Read', 'tc-child-1', { file_path: 'src/index.ts' }, 'tc-sa-1');

    // No parts yet (buffered)
    expect(builder.parts).toHaveLength(0);

    // Now the subagent.started arrives — should flush the buffered tool
    builder.onSubagentStart('tc-sa-1', 'worker', 'Worker');

    expect(builder.parts).toHaveLength(1);
    const section = builder.parts[0] as SubagentSectionPart;
    expect(section.items).toHaveLength(1);
    expect(section.items[0].kind).toBe('pinned-tool');
    if (section.items[0].kind === 'pinned-tool') {
      expect(section.items[0].tool.toolName).toBe('Read');
    }
  });

  it('onToolComplete finds tool in sub-agent section via _subagentTools map', () => {
    const builder = new ResponsePartBuilder({ formatters: createToolFormatterRegistry() });
    builder.onSubagentStart('tc-sa-1', 'worker', 'Worker');
    builder.onToolStart('Read', 'tc-child-1', { file_path: 'app.ts' }, 'tc-sa-1');

    // Complete the child tool
    builder.onToolComplete('tc-child-1', 'file contents here');

    const section = builder.parts[0] as SubagentSectionPart;
    expect(section.items).toHaveLength(1);
    if (section.items[0].kind === 'pinned-tool') {
      expect(section.items[0].tool.isComplete).toBe(true);
    }
  });

  it('reset() clears sub-agent state', () => {
    const builder = new ResponsePartBuilder();
    builder.onSubagentStart('tc-sa-1', 'worker', 'Worker');
    builder.onOutput('Child text', 'tc-sa-1');

    expect(builder.parts).toHaveLength(1);

    builder.reset();

    expect(builder.parts).toHaveLength(0);

    // After reset, routing to the old sub-agent should buffer (not crash)
    // since the section no longer exists
    builder.onOutput('Orphaned text', 'tc-sa-1');
    // Buffered, not rendered — no active sub-agent with that ID
    // The text gets buffered in _pendingSubagentEvents, so no parts created
    expect(builder.parts).toHaveLength(0);
  });

  it('onSubagentEnd sets collapsed=true on success', () => {
    const builder = new ResponsePartBuilder();
    builder.onSubagentStart('tc-sa-1', 'worker', 'Worker');

    const section = builder.parts[0] as SubagentSectionPart;
    expect(section.collapsed).toBe(false);

    builder.onSubagentEnd('tc-sa-1');

    expect(section.status).toBe('completed');
    expect(section.collapsed).toBe(true);
  });

  it('onSubagentEnd does NOT collapse on failure', () => {
    const builder = new ResponsePartBuilder();
    builder.onSubagentStart('tc-sa-1', 'worker', 'Worker');

    const section = builder.parts[0] as SubagentSectionPart;
    expect(section.collapsed).toBe(false);

    builder.onSubagentEnd('tc-sa-1', 'Agent crashed');

    expect(section.status).toBe('failed');
    expect(section.collapsed).toBe(false);
  });
});
