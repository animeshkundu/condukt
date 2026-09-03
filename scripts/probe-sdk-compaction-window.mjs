#!/usr/bin/env node

/**
 * Native Copilot SDK automatic-compaction probe.
 *
 * Uses a loopback OpenAI-compatible provider and deliberately omits
 * CopilotClient.requestHandler. It compares the runtime default against
 * enabled-only and explicit-stock infinite-session configuration, then submits
 * an ordinary parent message while the compaction provider response is held.
 */

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk';

const require = createRequire(import.meta.url);
const SCENARIO_TIMEOUT_MS = 90_000;
const TURN_TIMEOUT_MS = 30_000;
const MAX_FILL_TURNS = 24;
const COMPACTION_HOLD_MS = 2_000;

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function resolveCliPath() {
  const configuredPath = process.env.COPILOT_CLI_PATH?.trim();
  if (configuredPath) {
    const absolutePath = resolve(configuredPath);
    if (!existsSync(absolutePath)) throw new Error(`COPILOT_CLI_PATH does not exist: ${absolutePath}`);
    return absolutePath;
  }

  const platformPackage = `@github/copilot-${process.platform}-${process.arch}`;
  try {
    const packageCliPath = require.resolve(platformPackage);
    return existsSync(packageCliPath) ? packageCliPath : undefined;
  } catch {
    return undefined;
  }
}

function requestMessages(body) {
  return Array.isArray(body?.messages) ? body.messages : [];
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .map((part) => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')
    .join('');
}

function requestText(body) {
  return requestMessages(body).map(messageText).join('\n');
}

function deterministicFill(turn) {
  let state = (0x9e3779b9 ^ turn) >>> 0;
  const words = [];
  for (let index = 0; index < 3_000; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    words.push(`t${turn}_${index}_${(state >>> 0).toString(16).padStart(8, '0')}`);
  }
  return `FILL_TURN_${turn}\n${words.join(' ')}`;
}

function writeStreamingCompletion(res, text, callId) {
  const created = Math.floor(Date.now() / 1000);
  const first = {
    id: `chatcmpl-probe-${callId}`,
    object: 'chat.completion.chunk',
    created,
    model: 'probe-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
  };
  const final = {
    id: `chatcmpl-probe-${callId}`,
    object: 'chat.completion.chunk',
    created,
    model: 'probe-model',
    choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }],
  };
  res.write(`data: ${JSON.stringify(first)}\n\n`);
  res.write(`data: ${JSON.stringify(final)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function writeBufferedCompletion(res, text, callId) {
  const body = {
    id: `chatcmpl-probe-${callId}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'probe-model',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102 },
  };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function respond(res, stream, text, callId) {
  if (stream) {
    if (!res.headersSent) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
    }
    writeStreamingCompletion(res, text, callId);
  } else {
    writeBufferedCompletion(res, text, callId);
  }
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function scenarioVariants() {
  return [
    { name: 'omitted', config: {} },
    { name: 'enabled-only', config: { infiniteSessions: { enabled: true } } },
    {
      name: 'explicit-stock',
      config: {
        infiniteSessions: {
          enabled: true,
          backgroundCompactionThreshold: 0.80,
          bufferExhaustionThreshold: 0.95,
        },
      },
    },
  ];
}

async function runScenario(variant, cliPath) {
  const configDirectory = await mkdtemp(join(tmpdir(), `condukt-compaction-${variant.name}-`));
  const requests = [];
  const events = [];
  const compactionHeld = deferred();
  const releaseCompaction = deferred();
  const parentCompleted = deferred();
  const parentIdle = deferred();
  let session;
  let server;
  let client;
  let compactionActive = false;
  let compactionStartAt;
  let compactionCompleteAt;
  let holdNextProviderRequest = false;
  let heldRequest;
  let parentSendInvokedAt;
  let parentSendInvokedWhileHeld = false;
  let parentSendAcceptedAt;
  let parentMessageId;
  let parentAssistantMessages = 0;
  let inFlightRequests = 0;
  let maxConcurrentRequests = 0;
  let providerCallCount = 0;
  let parentSeen = false;

  try {
    server = createServer(async (req, res) => {
      providerCallCount += 1;
      const callId = providerCallCount;
      inFlightRequests += 1;
      maxConcurrentRequests = Math.max(maxConcurrentRequests, inFlightRequests);
      const record = {
        callId,
        method: req.method,
        url: req.url,
        openedAt: Date.now(),
        closedAt: undefined,
        releasedAt: undefined,
        stream: undefined,
        model: undefined,
        messages: undefined,
        bodyBytes: undefined,
        kind: 'unknown',
      };
      requests.push(record);
      const close = () => {
        if (record.closedAt === undefined) {
          record.closedAt = Date.now();
          inFlightRequests = Math.max(0, inFlightRequests - 1);
        }
      };
      res.once('close', close);

      try {
        if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'unexpected provider path' }));
          return;
        }
        const raw = await readRequestBody(req);
        record.bodyBytes = raw.byteLength;
        const body = JSON.parse(raw.toString('utf8'));
        record.stream = body.stream === true;
        record.model = body.model;
        record.messages = requestMessages(body).length;
        const text = requestText(body);

        if (text.includes('PARENT_DURING_COMPACTION')) {
          record.kind = 'parent';
          parentSeen = true;
          if (heldRequest && heldRequest.releasedAt === undefined) await releaseCompaction.promise;
          respond(res, record.stream, 'PARENT_OK', callId);
          return;
        }

        if (holdNextProviderRequest) {
          holdNextProviderRequest = false;
          record.kind = 'compaction';
          heldRequest = record;
          if (record.stream) {
            res.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              connection: 'keep-alive',
            });
          }
          compactionHeld.resolve(record);
          await releaseCompaction.promise;
          record.releasedAt = Date.now();
          respond(res, record.stream, 'COMPACTION_SUMMARY_OK', callId);
          return;
        }

        record.kind = 'fill';
        respond(res, record.stream, 'FILL_OK', callId);
      } catch (error) {
        compactionHeld.reject(error);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        if (!res.writableEnded) res.end(JSON.stringify({ error: String(error) }));
      }
    });

    await new Promise((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise);
      server.listen(0, '127.0.0.1', resolvePromise);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Probe provider did not bind a TCP port');
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;

    const sessionConfig = {
      sessionId: `condukt-compaction-${variant.name}-${randomUUID()}`,
      model: 'probe-model',
      contextTier: 'default',
      provider: {
        type: 'openai',
        wireApi: 'completions',
        transport: 'http',
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
      memory: { enabled: false },
      skipCustomInstructions: true,
      customAgentsLocalOnly: true,
      coauthorEnabled: false,
      manageScheduleEnabled: false,
      onEvent: (event) => {
        events.push({ id: event.id, type: event.type, timestamp: event.timestamp, data: event.data });
        if (event.type === 'session.compaction_start') {
          compactionActive = true;
          compactionStartAt = Date.now();
          holdNextProviderRequest = true;
        } else if (event.type === 'session.compaction_complete') {
          compactionActive = false;
          compactionCompleteAt = Date.now();
        } else if (event.type === 'assistant.message') {
          const content = typeof event.data?.content === 'string' ? event.data.content : '';
          if (content.includes('PARENT_OK')) {
            parentAssistantMessages += 1;
            parentCompleted.resolve(event);
          }
        } else if (event.type === 'session.idle' && parentSeen) {
          parentIdle.resolve(event);
        }
      },
      ...variant.config,
    };

    client = new CopilotClient({
      mode: 'empty',
      baseDirectory: configDirectory,
      logLevel: 'warning',
      connection: RuntimeConnection.forStdio({ path: cliPath }),
    });
    await client.start();
    session = await client.createSession(sessionConfig);

    const windowTask = (async () => {
      const record = await withTimeout(compactionHeld.promise, SCENARIO_TIMEOUT_MS, `${variant.name} compaction request`);
      if (!compactionActive) throw new Error(`${variant.name}: compaction was not active when its provider request was held`);
      parentSendInvokedAt = Date.now();
      parentSendInvokedWhileHeld = record.closedAt === undefined && record.releasedAt === undefined;
      const sendPromise = session.send('PARENT_DURING_COMPACTION');
      await new Promise(resolvePromise => setTimeout(resolvePromise, COMPACTION_HOLD_MS));
      if (record.closedAt !== undefined || record.releasedAt !== undefined) {
        throw new Error(`${variant.name}: compaction response closed before the parent send remained queued for ${COMPACTION_HOLD_MS}ms`);
      }
      releaseCompaction.resolve();
      parentMessageId = await sendPromise;
      parentSendAcceptedAt = Date.now();
      if (typeof parentMessageId !== 'string' || parentMessageId.length === 0) {
        throw new Error(`${variant.name}: parent send returned no message ID`);
      }
    })();

    let fillTurns = 0;
    while (compactionStartAt === undefined && fillTurns < MAX_FILL_TURNS) {
      fillTurns += 1;
      await session.sendAndWait(deterministicFill(fillTurns), TURN_TIMEOUT_MS);
    }
    if (compactionStartAt === undefined) {
      throw new Error(`${variant.name}: automatic compaction did not start after ${fillTurns} fill turns`);
    }

    await withTimeout(windowTask, SCENARIO_TIMEOUT_MS, `${variant.name} parent submission`);
    await withTimeout(parentCompleted.promise, SCENARIO_TIMEOUT_MS, `${variant.name} parent response`);
    await withTimeout(parentIdle.promise, SCENARIO_TIMEOUT_MS, `${variant.name} parent idle`);

    const history = await session.getEvents();
    const parentUsers = history.filter((event) => event.type === 'user.message'
      && typeof event.data?.content === 'string'
      && event.data.content.includes('PARENT_DURING_COMPACTION'));
    const parentAssistants = history.filter((event) => event.type === 'assistant.message'
      && typeof event.data?.content === 'string'
      && event.data.content.includes('PARENT_OK'));
    const compactionStarts = events.filter((event) => event.type === 'session.compaction_start');
    const compactionCompletes = events.filter((event) => event.type === 'session.compaction_complete');
    const failures = events.filter((event) => event.type === 'session.error' || event.type === 'model.call_failure');
    const unexpectedPaths = requests.filter((request) => request.url !== '/v1/chat/completions');
    const unresolvedRequests = requests.filter((request) => request.closedAt === undefined);
    const latestCompletion = compactionCompletes.at(-1);

    const assertions = [
      ['workspace path is defined', typeof session.workspacePath === 'string' && session.workspacePath.length > 0],
      ['compaction started', compactionStarts.length > 0],
      ['compaction completed', compactionCompletes.length > 0],
      ['compaction succeeded', latestCompletion?.data?.success === true && !latestCompletion?.data?.error],
      ['compaction request was held', heldRequest !== undefined],
      ['parent invoked during compaction', parentSendInvokedAt !== undefined && parentSendInvokedWhileHeld],
      ['parent completed once', parentAssistantMessages === 1 && parentAssistants.length === 1],
      ['parent prompt persisted once', parentUsers.length === 1],
      ['no session failures', failures.length === 0],
      ['only completions endpoint used', unexpectedPaths.length === 0],
      ['all provider requests closed', unresolvedRequests.length === 0],
      ['compaction finished after parent invocation', compactionCompleteAt !== undefined && parentSendInvokedAt !== undefined && parentSendInvokedAt < compactionCompleteAt],
    ];
    const failed = assertions.filter(([, pass]) => !pass).map(([name]) => name);
    if (failed.length > 0) throw new Error(`${variant.name}: failed assertions: ${failed.join(', ')}`);

    return {
      variant: variant.name,
      cliPath,
      workspacePathDefined: typeof session.workspacePath === 'string',
      fillTurns,
      providerCallCount,
      maxConcurrentRequests,
      compactionStartCount: compactionStarts.length,
      compactionCompleteCount: compactionCompletes.length,
      compaction: latestCompletion?.data,
      compactionRequest: heldRequest,
      parentSendInvokedAt,
      parentSendInvokedWhileHeld,
      parentSendAcceptedAt,
      compactionCompleteAt,
      parentMessageId,
      parentAssistantMessages: parentAssistants.length,
      parentUserMessages: parentUsers.length,
      providerPaths: [...new Set(requests.map((request) => request.url))],
      streamModes: [...new Set(requests.map((request) => request.stream))],
      eventTypes: events.map((event) => event.type),
    };
  } finally {
    releaseCompaction.resolve();
    await session?.disconnect().catch(() => undefined);
    await client?.stop().catch(() => undefined);
    await client?.forceStop().catch(() => undefined);
    if (server) await new Promise((resolvePromise) => server.close(resolvePromise));
    await rm(configDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const cliPath = resolveCliPath();
  if (!cliPath) throw new Error('Could not resolve the Copilot runtime path');

  const results = [];
  for (const variant of scenarioVariants()) {
    results.push(await withTimeout(
      runScenario(variant, cliPath),
      SCENARIO_TIMEOUT_MS * 2,
      `${variant.name} scenario`,
    ));
  }

  console.log(JSON.stringify({ cliPath, results }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
