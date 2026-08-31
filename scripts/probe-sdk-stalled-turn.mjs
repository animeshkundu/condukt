#!/usr/bin/env node

/**
 * Isolated probe for Copilot SDK empty-turn recovery semantics.
 *
 * Uses a local OpenAI-compatible SSE streaming server, an isolated config directory,
 * no tools, and no external services.
 *
 * Compares two scenarios in separate sessions:
 * Scenario A:
 *   - Turn 1: Normal prompt -> SSE response "INITIAL_OK".
 *   - Turn 2: Stalled prompt -> SSE response emits deltas "STALLED_PARTIAL_DELTA_"
 *     and holds the socket open indefinitely.
 *   - Measure SDK events before intervention (turn_retry, model.call_failure, etc.).
 *   - Action: Disconnect old SDK session & stop client without abort.
 *   - Verify if server sees request/socket close.
 *   - Resume same sessionId on fresh client with continuePendingWork: false.
 *   - Trigger empty sendMessages turn -> SSE responds "RECOVERED_OK".
 *   - Check history, message counts, continuation calls, late output overlaps.
 *
 * Scenario B:
 *   - Same initial and stalled turns in a fresh session.
 *   - Action: session.abort() then disconnect old session & stop client.
 *   - Verify server socket closure immediately after abort.
 *   - Resume same sessionId on fresh client with continuePendingWork: false.
 *   - Trigger empty sendMessages turn -> SSE responds "RECOVERED_OK".
 *   - Check history, message counts, continuation calls, late output overlaps.
 */

import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk';

function resolveCliPath() {
  if (process.env.COPILOT_CLI_PATH && existsSync(process.env.COPILOT_CLI_PATH)) {
    return process.env.COPILOT_CLI_PATH;
  }
  const candidate1 = 'C:/Users/anikundu/Software/investigation/condukt/node_modules/@github/copilot-win32-x64/copilot.exe';
  if (existsSync(candidate1)) return candidate1;
  const candidate2 = 'C:/Users/anikundu/Software/investigation/taco-helper/node_modules/@github/copilot-win32-x64/copilot.exe';
  if (existsSync(candidate2)) return candidate2;
  return undefined;
}

function summarizeHistory(events) {
  return {
    eventCount: events.length,
    userMessages: events
      .filter((event) => event.type === 'user.message')
      .map((event) => ({ id: event.id, content: event.data?.content })),
    assistantMessages: events
      .filter((event) => event.type === 'assistant.message')
      .map((event) => ({ id: event.id, content: event.data?.content })),
    turnStarts: events.filter((event) => event.type === 'assistant.turn_start').length,
    turnEnds: events.filter((event) => event.type === 'assistant.turn_end').length,
    rawTypes: events.map((e) => e.type),
  };
}

async function runScenario(scenarioName, cliPath) {
  const configDirectory = await mkdtemp(join(tmpdir(), `condukt-probe-stall-${scenarioName.toLowerCase()}-`));
  const providerRequests = [];
  let providerCallCount = 0;
  let inFlightRequests = 0;
  let maxConcurrentRequests = 0;
  let stalledReqClosed = false;
  let stalledSocketClosed = false;
  let stalledResRef = null;

  const server = createServer((req, res) => {
    providerCallCount++;
    inFlightRequests++;
    if (inFlightRequests > maxConcurrentRequests) {
      maxConcurrentRequests = inFlightRequests;
    }
    const currentCall = providerCallCount;
    const reqRecord = {
      callId: currentCall,
      method: req.method,
      url: req.url,
      timestamp: Date.now(),
      closed: false,
      socketClosed: false,
    };
    providerRequests.push(reqRecord);

    req.on('close', () => {
      inFlightRequests = Math.max(0, inFlightRequests - 1);
      reqRecord.closed = true;
      if (currentCall === 2) {
        stalledReqClosed = true;
      }
    });

    res.on('close', () => {
      reqRecord.socketClosed = true;
      if (currentCall === 2) {
        stalledSocketClosed = true;
      }
    });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    if (currentCall === 1) {
      // Turn 1: Normal initial response
      const chunk1 = {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'probe-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'INITIAL_OK' }, finish_reason: null }],
      };
      const chunk2 = {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'probe-model',
        choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }],
      };
      res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
      res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else if (currentCall === 2) {
      // Turn 2: Stalled turn - send deltas then hold socket open indefinitely
      stalledResRef = res;
      const chunk1 = {
        id: 'chatcmpl-2',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'probe-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'STALLED_PARTIAL_DELTA_' }, finish_reason: null }],
      };
      const chunk2 = {
        id: 'chatcmpl-2',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'probe-model',
        choices: [{ index: 0, delta: { content: 'MORE_DELTA' }, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
      res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
      // Intentionally do not write finish_reason, [DONE], or end response
    } else {
      // Subsequent turns (Empty turn recovery)
      const chunk1 = {
        id: `chatcmpl-${currentCall}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'probe-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'RECOVERED_OK' }, finish_reason: null }],
      };
      const chunk2 = {
        id: `chatcmpl-${currentCall}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'probe-model',
        choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }],
      };
      res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
      res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Provider failed to bind TCP port');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const sessionId = `condukt-probe-stall-${scenarioName.toLowerCase()}-${randomUUID()}`;
  const eventsClient1 = [];
  const eventsClient2 = [];

  const clientConfig = {
    mode: 'empty',
    baseDirectory: configDirectory,
    logLevel: 'warning',
    connection: RuntimeConnection.forStdio({ path: cliPath }),
  };

  const sessionConfig = {
    sessionId,
    model: 'probe-model',
    contextTier: 'default',
    provider: {
      type: 'openai',
      wireApi: 'completions',
      baseUrl,
      apiKey: 'local-probe-only',
      modelId: 'gpt-4o',
      wireModel: 'probe-model',
      maxPromptTokens: 16_384,
      maxOutputTokens: 1_024,
    },
    workingDirectory: configDirectory,
    streaming: true,
    tools: [],
    mcpServers: {},
    availableTools: [],
    excludedTools: ['builtin:*', 'mcp:*', 'custom:*'],
    onPermissionRequest: () => ({ kind: 'reject', feedback: 'Probe is inert.' }),
    onAutoModeSwitchRequest: () => 'no',
    enableMcpApps: false,
    enableConfigDiscovery: false,
    enableSkills: false,
    enableFileHooks: false,
    enableHostGitOperations: false,
    enableSessionStore: false,
    remoteSession: 'off',
    infiniteSessions: { enabled: false },
    memory: { enabled: false },
    skipCustomInstructions: true,
    customAgentsLocalOnly: true,
    coauthorEnabled: false,
    manageScheduleEnabled: false,
    onEvent: (event) => eventsClient1.push(event),
  };

  let client1 = new CopilotClient(clientConfig);
  let client2 = null;
  let activeSession1 = null;
  let activeSession2 = null;

  try {
    await client1.start();
    activeSession1 = await client1.createSession(sessionConfig);

    // Step 1: Normal Turn
    await activeSession1.sendAndWait('Initial prompt. Reply INITIAL_OK', 15_000);
    const historyAfterTurn1 = await activeSession1.getEvents();

    // Step 2: Stalled Turn
    let deltaReceived = false;
    const unsubDelta = activeSession1.on('assistant.streaming_delta', () => {
      deltaReceived = true;
    });

    await activeSession1.send('Stalled prompt to hold socket open');

    const startWaitDelta = Date.now();
    while (!deltaReceived && Date.now() - startWaitDelta < 5_000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    unsubDelta();

    if (!deltaReceived) {
      throw new Error(`Scenario ${scenarioName}: failed to observe streaming delta on stalled turn`);
    }

    // Measure SDK events during stall before intervention (1.5s window)
    const stallMeasurementWindowMs = 1500;
    const preInterventionEventCount = eventsClient1.length;
    await new Promise((r) => setTimeout(r, stallMeasurementWindowMs));
    const eventsDuringStall = eventsClient1.slice(preInterventionEventCount);

    const observedTurnRetries = eventsClient1.filter((e) => e.type === 'assistant.turn_retry').map((e) => e.data);
    const observedModelFailures = eventsClient1.filter((e) => e.type === 'model.call_failure').map((e) => e.data);

    const historyBeforeIntervention = await activeSession1.getEvents();
    const serverStateBeforeIntervention = {
      providerCallCount,
      inFlightRequests,
      stalledReqClosed,
      stalledSocketClosed,
    };

    let serverStateAfterAbort = null;
    if (scenarioName === 'B') {
      // Scenario B: Abort first
      await activeSession1.abort().catch((err) => {
        // Record if abort failed
        console.error('Abort call rejected:', err);
      });
      // Short delay to let socket close propagate to local HTTP server
      await new Promise((r) => setTimeout(r, 200));
      serverStateAfterAbort = {
        inFlightRequests,
        stalledReqClosed,
        stalledSocketClosed,
      };
    }

    // Intervene: Disconnect session and stop client 1
    await activeSession1.disconnect().catch(() => undefined);
    await client1.stop().catch(() => undefined);

    // Give 300ms for OS/runtime process shutdown & socket teardown
    await new Promise((r) => setTimeout(r, 300));
    const serverStateAfterDisconnectAndStop = {
      inFlightRequests,
      stalledReqClosed,
      stalledSocketClosed,
    };

    // Step 3: Resume on fresh Client 2
    client2 = new CopilotClient(clientConfig);
    await client2.start();
    activeSession2 = await client2.resumeSession(sessionId, {
      ...sessionConfig,
      onEvent: (event) => eventsClient2.push(event),
      continuePendingWork: false,
    });

    const sessionResumedId = activeSession2.sessionId;
    const historyImmediatelyAfterResume = await activeSession2.getEvents();

    // Step 4: Empty turn recovery
    const continuationCallsBefore = providerCallCount;
    const sendMessagesResult = await activeSession2.rpc.sendMessages({ messages: [], wait: true });
    const continuationCallsAfter = providerCallCount;
    const continuationProviderCalls = continuationCallsAfter - continuationCallsBefore;

    const historyAfterEmptyTurn = await activeSession2.getEvents();

    // Check if late output from stalled turn overlapped
    const assistantMessages = historyAfterEmptyTurn
      .filter((e) => e.type === 'assistant.message')
      .map((e) => e.data?.content);

    const lateOutputOverlapped = assistantMessages.some(
      (content) => typeof content === 'string' && content.includes('STALLED_PARTIAL_DELTA'),
    );

    const recoveredOk = assistantMessages.some(
      (content) => typeof content === 'string' && content.includes('RECOVERED_OK'),
    );

    await activeSession2.disconnect().catch(() => undefined);

    return {
      scenario: scenarioName,
      sessionId,
      sessionResumedId,
      sessionIdStable: sessionId === sessionResumedId,
      maxConcurrentRequests,
      serverStateBeforeIntervention,
      serverStateAfterAbort,
      serverStateAfterDisconnectAndStop,
      eventsBeforeIntervention: {
        totalEvents: eventsClient1.length,
        eventsDuringStallCount: eventsDuringStall.length,
        turnRetryEvents: observedTurnRetries,
        modelCallFailureEvents: observedModelFailures,
      },
      history: {
        afterTurn1: summarizeHistory(historyAfterTurn1),
        beforeIntervention: summarizeHistory(historyBeforeIntervention),
        immediatelyAfterResume: summarizeHistory(historyImmediatelyAfterResume),
        afterEmptyTurn: summarizeHistory(historyAfterEmptyTurn),
      },
      continuation: {
        sendMessagesMessageIds: sendMessagesResult.messageIds,
        continuationProviderCalls,
        lateOutputOverlapped,
        recoveredOk,
      },
      providerRequests: providerRequests.map((r) => ({
        callId: r.callId,
        method: r.method,
        url: r.url,
        closed: r.closed,
        socketClosed: r.socketClosed,
      })),
    };
  } finally {
    if (activeSession1) await activeSession1.disconnect().catch(() => undefined);
    if (activeSession2) await activeSession2.disconnect().catch(() => undefined);
    if (client1) await client1.stop().catch(() => undefined);
    if (client2) await client2.stop().catch(() => undefined);
    await new Promise((resolve) => server.close(resolve));
    await rm(configDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const cliPath = resolveCliPath();
  if (!cliPath) {
    console.error('Fatal: Could not resolve Copilot CLI binary path.');
    process.exit(1);
  }

  const resultA = await runScenario('A', cliPath);
  const resultB = await runScenario('B', cliPath);

  const report = {
    cliPath,
    scenarioA: resultA,
    scenarioB: resultB,
    comparison: {
      sessionStability: {
        scenarioA: resultA.sessionIdStable,
        scenarioB: resultB.sessionIdStable,
      },
      serverSocketClosure: {
        scenarioA_afterDisconnectAndStop: resultA.serverStateAfterDisconnectAndStop.stalledSocketClosed,
        scenarioB_afterAbort: resultB.serverStateAfterAbort?.stalledSocketClosed,
        scenarioB_afterDisconnectAndStop: resultB.serverStateAfterDisconnectAndStop.stalledSocketClosed,
      },
      turnCounts: {
        scenarioA: {
          beforeInterventionTurnStarts: resultA.history.beforeIntervention.turnStarts,
          beforeInterventionTurnEnds: resultA.history.beforeIntervention.turnEnds,
          afterEmptyTurnTurnStarts: resultA.history.afterEmptyTurn.turnStarts,
          afterEmptyTurnTurnEnds: resultA.history.afterEmptyTurn.turnEnds,
          userMessageCount: resultA.history.afterEmptyTurn.userMessages.length,
          assistantMessageCount: resultA.history.afterEmptyTurn.assistantMessages.length,
        },
        scenarioB: {
          beforeInterventionTurnStarts: resultB.history.beforeIntervention.turnStarts,
          beforeInterventionTurnEnds: resultB.history.beforeIntervention.turnEnds,
          afterEmptyTurnTurnStarts: resultB.history.afterEmptyTurn.turnStarts,
          afterEmptyTurnTurnEnds: resultB.history.afterEmptyTurn.turnEnds,
          userMessageCount: resultB.history.afterEmptyTurn.userMessages.length,
          assistantMessageCount: resultB.history.afterEmptyTurn.assistantMessages.length,
        },
      },
      continuationCalls: {
        scenarioA: resultA.continuation.continuationProviderCalls,
        scenarioB: resultB.continuation.continuationProviderCalls,
      },
      lateOutputOverlapped: {
        scenarioA: resultA.continuation.lateOutputOverlapped,
        scenarioB: resultB.continuation.lateOutputOverlapped,
      },
      recovered: {
        scenarioA: resultA.continuation.recoveredOk,
        scenarioB: resultB.continuation.recoveredOk,
      },
    },
  };

  console.log(JSON.stringify(report, null, 2));

  // Assertions for safety and expected behavior
  const assertions = [
    {
      name: 'Scenario A session ID stability',
      pass: resultA.sessionIdStable === true,
    },
    {
      name: 'Scenario B session ID stability',
      pass: resultB.sessionIdStable === true,
    },
    {
      name: 'Scenario A server socket closure after client teardown',
      pass: resultA.serverStateAfterDisconnectAndStop.stalledSocketClosed === true,
    },
    {
      name: 'Scenario B server socket closure after session.abort()',
      pass: resultB.serverStateAfterAbort?.stalledSocketClosed === true,
    },
    {
      name: 'Scenario A continuation provider call made',
      pass: resultA.continuation.continuationProviderCalls === 1,
    },
    {
      name: 'Scenario B continuation provider call made',
      pass: resultB.continuation.continuationProviderCalls === 1,
    },
    {
      name: 'Scenario A recovered cleanly without late partial leakage',
      pass: resultA.continuation.recoveredOk === true && resultA.continuation.lateOutputOverlapped === false,
    },
    {
      name: 'Scenario B recovered cleanly without late partial leakage',
      pass: resultB.continuation.recoveredOk === true && resultB.continuation.lateOutputOverlapped === false,
    },
    {
      name: 'Session history user message count preserved (2 user messages)',
      pass: resultA.history.afterEmptyTurn.userMessages.length === 2 && resultB.history.afterEmptyTurn.userMessages.length === 2,
    },
    {
      name: 'Session history assistant message count (2 assistant messages)',
      pass: resultA.history.afterEmptyTurn.assistantMessages.length === 2 && resultB.history.afterEmptyTurn.assistantMessages.length === 2,
    },
  ];

  const failedAssertions = assertions.filter((a) => !a.pass);
  if (failedAssertions.length > 0) {
    console.error('Probe failed safety assertions:', failedAssertions);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('Fatal probe execution error:', err);
  process.exit(1);
});
