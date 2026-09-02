#!/usr/bin/env node

/**
 * Isolated probe for Copilot SDK empty-turn recovery semantics.
 *
 * Uses a local OpenAI-compatible provider, an isolated config directory, no
 * tools, and no external services. The provider returns one successful turn,
 * one transport failure, then a final successful turn.
 */

import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CopilotClient } from '@github/copilot-sdk';

function jsonResponse(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(encoded),
  });
  response.end(encoded);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function successfulCompletion(id, content) {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'probe-model',
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 16, completion_tokens: 4, total_tokens: 20 },
  };
}

async function main() {
  const configDirectory = await mkdtemp(join(tmpdir(), 'condukt-sdk-empty-turn-'));
  const providerRequests = [];
  let providerCall = 0;
  let providerMode = 'initial';

  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    providerRequests.push({ method: request.method, url: request.url, body, providerMode });
    providerCall += 1;

    if (providerMode === 'failing') {
      response.writeHead(400, { 'content-length': '0' });
      response.end();
      return;
    }

    jsonResponse(
      response,
      200,
      successfulCompletion(
        `chatcmpl-probe-${providerCall}`,
        providerMode === 'initial' ? 'INITIAL_OK' : 'RECOVERED_OK',
      ),
    );
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Provider did not bind a TCP port');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const sessionId = `condukt-empty-turn-${randomUUID()}`;
  const events = [];
  const sendResults = [];
  const clientConfig = {
    mode: 'empty',
    baseDirectory: configDirectory,
    logLevel: 'warning',
  };
  let client = new CopilotClient(clientConfig);
  let activeSession;

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
    onEvent: (event) => events.push(event),
    hooks: {
      onUserPromptSubmitted: async (input) => {
        sendResults.push(input);
        return {};
      },
    },
  };

  try {
    await client.start();
    activeSession = await client.createSession(sessionConfig);

    await activeSession.sendAndWait('Establish durable probe history. Reply exactly INITIAL_OK.', 30_000);
    const beforeFailure = await activeSession.getEvents();

    providerMode = 'failing';
    let failure;
    const failureObserved = new Promise((resolve) => {
      const unsubscribe = activeSession.on('model.call_failure', (event) => {
        unsubscribe();
        resolve(event.data);
      });
    });
    await activeSession.send('This provider call is intentionally terminated.');
    await Promise.race([
      failureObserved,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for model.call_failure')), 30_000)),
    ]).catch((error) => {
      failure = error instanceof Error ? error.message : String(error);
    });

    const afterFailure = await activeSession.getEvents();
    providerMode = 'recovered';
    const liveResult = await activeSession.rpc.sendMessages({ messages: [], wait: true });
    let afterLiveEmptyTurn = await activeSession.getEvents();
    let liveEmptyTurnRecovered = afterLiveEmptyTurn.some(
      (event) => event.type === 'assistant.message' && event.data?.content === 'RECOVERED_OK',
    );
    let resumedEmptyTurnMessageIds;
    let afterResumedEmptyTurn;

    if (!liveEmptyTurnRecovered) {
      await activeSession.disconnect().catch(() => undefined);
      await client.stop().catch(() => undefined);
      client = new CopilotClient(clientConfig);
      await client.start();
      activeSession = await client.resumeSession(sessionId, {
        ...sessionConfig,
        continuePendingWork: false,
      });
      if (activeSession.sessionId !== sessionId) {
        throw new Error(`Resume returned mismatched session ID ${activeSession.sessionId}`);
      }
      resumedEmptyTurnMessageIds = (await activeSession.rpc.sendMessages({ messages: [], wait: true })).messageIds;
      afterResumedEmptyTurn = await activeSession.getEvents();
    }

    const result = {
      sessionId,
      providerCallCount: providerCall,
      providerRequests: providerRequests.map(({ method, url, body, providerMode: mode }) => ({
        method,
        url,
        mode,
        bodyBytes: Buffer.byteLength(body),
      })),
      failure: failure ?? null,
      submittedPrompts: sendResults.map((input) => input.prompt),
      liveEmptyTurnMessageIds: liveResult.messageIds,
      resumedEmptyTurnMessageIds: resumedEmptyTurnMessageIds ?? null,
      history: {
        beforeFailure: summarizeHistory(beforeFailure),
        afterFailure: summarizeHistory(afterFailure),
        afterLiveEmptyTurn: summarizeHistory(afterLiveEmptyTurn),
        afterResumedEmptyTurn: afterResumedEmptyTurn ? summarizeHistory(afterResumedEmptyTurn) : null,
      },
      observedFailureEvents: events
        .filter((event) => event.type === 'model.call_failure')
        .map((event) => event.data),
      liveEmptyTurnRecovered,
      resumedEmptyTurnRecovered: afterResumedEmptyTurn?.some(
        (event) => event.type === 'assistant.message' && event.data?.content === 'RECOVERED_OK',
      ) ?? false,
    };

    console.log(JSON.stringify(result, null, 2));
    await activeSession.disconnect().catch(() => undefined);

    if (!result.liveEmptyTurnRecovered && !result.resumedEmptyTurnRecovered) process.exitCode = 2;
  } finally {
    await client.stop().catch(() => undefined);
    await new Promise((resolve) => server.close(resolve));
    await rm(configDirectory, { recursive: true, force: true });
  }
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
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
