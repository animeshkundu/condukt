#!/usr/bin/env node

/** Strip Copilot CLI JSONL down to content-free transport metadata. */

import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

function string(value) {
  return typeof value === 'string' ? value : undefined;
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

for await (const line of lines) {
  if (!line.trim()) continue;
  try {
    const value = JSON.parse(line);
    const data = value && typeof value.data === 'object' ? value.data : {};
    const safe = {
      type: string(value.type) ?? string(value.eventType) ?? string(value.kind) ?? 'json',
      id: string(value.id),
      timestamp: string(value.timestamp),
      status: string(value.status),
      model: string(value.model) ?? string(data.model),
      endpoint: string(value.endpoint) ?? string(data.endpoint),
      failureKind: string(value.failureKind) ?? string(data.failureKind),
      transport: string(value.transport) ?? string(data.transport),
      statusCode: number(value.statusCode) ?? number(data.statusCode),
      errorCode: string(value.errorCode) ?? string(data.errorCode),
      requestId: string(value.requestId) ?? string(data.requestId),
      serviceRequestId: string(value.serviceRequestId) ?? string(data.serviceRequestId),
      apiCallId: string(value.apiCallId) ?? string(data.apiCallId),
      durationMs: number(value.durationMs) ?? number(data.durationMs),
    };
    console.log(JSON.stringify(Object.fromEntries(
      Object.entries(safe).filter(([, entry]) => entry !== undefined),
    )));
  } catch {
    console.log(JSON.stringify({ type: 'non_json_line' }));
  }
}
