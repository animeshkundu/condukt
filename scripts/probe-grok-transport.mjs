#!/usr/bin/env node

/**
 * One-turn Grok transport probe.
 *
 * Modes:
 * - handler: current condukt SdkBackend path
 * - native:  raw SDK client with no requestHandler
 *
 * Emits lifecycle metadata only. Prompt, reasoning, and assistant content are
 * never printed or written by this script.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk';
import { SdkBackend } from '../dist/runtimes/copilot/index.js';

const require = createRequire(import.meta.url);
const mode = process.argv[2];
const PROMPT = 'Reply with exactly READY.';
const TIMEOUT_MS = 120_000;

if (mode !== 'handler' && mode !== 'native') {
  throw new Error('Usage: node scripts/probe-grok-transport.mjs <handler|native>');
}

async function packageVersion(packageName) {
  const entryPath = require.resolve(packageName);
  let current = dirname(entryPath);
  for (;;) {
    const packagePath = join(current, 'package.json');
    try {
      const parsed = JSON.parse(await readFile(packagePath, 'utf8'));
      if (parsed.name === packageName && typeof parsed.version === 'string') return parsed.version;
    } catch {
      // Continue toward the package root.
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(`Could not resolve package version for ${packageName}`);
    current = parent;
  }
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

function sanitizeFailure(data) {
  if (!data || typeof data !== 'object') return undefined;
  const value = data;
  const allowed = [
    'source',
    'initiator',
    'failureKind',
    'transport',
    'statusCode',
    'errorCode',
    'errorType',
    'badRequestKind',
    'model',
    'endpoint',
    'requestId',
    'serviceRequestId',
    'apiCallId',
    'durationMs',
  ];
  return Object.fromEntries(allowed
    .filter((key) => value[key] !== undefined)
    .map((key) => [key, value[key]]));
}

function runtimePath() {
  const packageName = `@github/copilot-${process.platform}-${process.arch}`;
  return resolve(require.resolve(packageName));
}

async function runNative() {
  const baseDirectory = await mkdtemp(join(tmpdir(), 'condukt-grok-native-'));
  const events = [];
  const failures = [];
  let assistantMessages = 0;
  let client;
  let session;
  const startedAt = Date.now();
  try {
    client = new CopilotClient({
      mode: 'empty',
      baseDirectory,
      logLevel: 'warning',
      connection: RuntimeConnection.forStdio({ path: runtimePath() }),
    });
    await client.start();
    session = await client.createSession({
      sessionId: `grok-native-${randomUUID()}`,
      model: 'grok-4.6',
      reasoningEffort: 'high',
      contextTier: 'default',
      workingDirectory: baseDirectory,
      streaming: true,
      tools: [],
      mcpServers: {},
      availableTools: [],
      excludedTools: ['builtin:*', 'mcp:*', 'custom:*'],
      onPermissionRequest: () => ({ kind: 'reject', feedback: 'Transport probe has no tools.' }),
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
      onEvent: (event) => {
        events.push(event.type);
        if (event.type === 'assistant.message') assistantMessages += 1;
        if (event.type === 'model.call_failure' || event.type === 'session.error') {
          failures.push({ type: event.type, data: sanitizeFailure(event.data) });
        }
      },
    });
    let message;
    let thrownFailure;
    try {
      message = await withTimeout(session.sendAndWait(PROMPT, TIMEOUT_MS), TIMEOUT_MS + 5_000, 'native turn');
    } catch (error) {
      thrownFailure = {
        name: error instanceof Error ? error.name : 'UnknownError',
        messageClass: error instanceof Error && /stream closed|socket|connection/i.test(error.message)
          ? 'transport-close'
          : error instanceof Error && /timed out/i.test(error.message)
            ? 'timeout'
            : 'other',
      };
    }
    return {
      mode,
      sdkVersion: await packageVersion('@github/copilot-sdk'),
      runtimeVersion: await packageVersion('@github/copilot-win32-x64'),
      runtimePath: runtimePath(),
      model: 'grok-4.6',
      reasoningEffort: 'high',
      contextTier: 'default',
      elapsedMs: Date.now() - startedAt,
      terminalOutcome: message
        ? 'assistant_message'
        : failures.length > 0 || thrownFailure
          ? 'failure'
          : 'no_assistant_message',
      assistantMessages,
      failures,
      thrownFailure,
      eventTypes: events,
    };
  } finally {
    await session?.disconnect().catch(() => undefined);
    await client?.stop().catch(() => undefined);
    await client?.forceStop().catch(() => undefined);
    await rm(baseDirectory, { recursive: true, force: true });
  }
}

async function runHandler() {
  const events = [];
  let assistantChunks = 0;
  let terminalOutcome = 'unknown';
  let failure;
  const startedAt = Date.now();
  const configDirectory = await mkdtemp(join(tmpdir(), 'condukt-grok-handler-config-'));
  const backend = new SdkBackend({
    terminalLogLevel: 'none',
    subagentsEnabled: false,
    configDir: configDirectory,
  });
  const workingDirectory = await mkdtemp(join(tmpdir(), 'condukt-grok-handler-work-'));
  let session;
  try {
    session = await backend.createSession({
      model: 'grok-4.6',
      thinkingBudget: 'high',
      contextTier: 'default',
      compactionMode: 'stock',
      mode: 'autopilot',
      mcpServers: false,
      cwd: workingDirectory,
      addDirs: [],
      timeout: TIMEOUT_MS / 1_000,
      heartbeatTimeout: TIMEOUT_MS / 1_000,
      availableTools: [],
      excludedTools: ['builtin:*', 'mcp:*', 'custom:*'],
      subagentRoster: false,
      sessionRecovery: false,
    });
    const settled = new Promise((resolvePromise) => {
      session.on('text', () => {
        assistantChunks += 1;
        events.push('text');
      });
      session.on('reasoning', () => events.push('reasoning'));
      session.on('usage', (data) => events.push(`usage:${String(data.model ?? 'unknown')}`));
      session.on('idle', () => {
        terminalOutcome = 'idle';
        events.push('idle');
        resolvePromise();
      });
      session.on('error', (error) => {
        terminalOutcome = 'error';
        failure = { name: error.name, messageClass: /stream closed|socket|connection/i.test(error.message) ? 'transport-close' : 'other' };
        events.push('error');
        resolvePromise();
      });
      session.on('recovery', (event) => events.push(`recovery:${event.phase}`));
    });
    session.send(PROMPT);
    await withTimeout(settled, TIMEOUT_MS + 5_000, 'handler turn');
    return {
      mode,
      sdkVersion: await packageVersion('@github/copilot-sdk'),
      runtimeVersion: await packageVersion('@github/copilot-win32-x64'),
      runtimePath: runtimePath(),
      model: 'grok-4.6',
      reasoningEffort: 'high',
      contextTier: 'default',
      elapsedMs: Date.now() - startedAt,
      terminalOutcome,
      assistantChunks,
      failure,
      eventTypes: events,
    };
  } finally {
    await session?.abort().catch(() => undefined);
    await rm(workingDirectory, { recursive: true, force: true });
    if (typeof configDirectory === 'string') await rm(configDirectory, { recursive: true, force: true });
  }
}

const result = mode === 'native' ? await runNative() : await runHandler();
console.log(JSON.stringify(result, null, 2));
