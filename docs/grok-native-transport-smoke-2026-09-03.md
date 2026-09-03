# Grok 4.6 native transport smoke

**Date:** 2026-09-03

## Scope

Three application-initiated requests used the same minimal no-tool task with `grok-4.6`, high reasoning effort, and default context tier. No application-level retry or replacement request was issued.

This is one sample per arm. It is smoke evidence, not a reliability estimate or proof of the original incomplete-stream rate.

## Results

| Arm | SDK / runtime | Result | Elapsed | Native failure/retry evidence |
|---|---|---:|---:|---|
| Stock Copilot CLI | CLI `1.0.83-2` | Success | about 17s wall-clock | No failure; two internal model turns and one built-in `task_complete` tool lifecycle |
| Condukt `0.21.1` handler | SDK `1.0.11`, runtime `1.0.81` | Error before assistant output | 1,081ms | Error was not classified as a socket/connection close by the metadata-only harness |
| Raw SDK, no handler | SDK `1.0.11`, runtime `1.0.81` | Success, one assistant message | 7,204ms | No `model.call_failure`, `session.error`, or retry event |

## Interpretation

The same-runtime differential identifies Condukt's experimental request-handler/admission path as the material local difference in this sample. It supports removing the host provider override and using the native runtime path.

It does **not** establish that the handler caused the previously reported remote stream close:

- the handler arm failed before output but did not surface a transport-close classification;
- the stock CLI used a newer runtime and performed extra internal work;
- one sample per arm cannot estimate intermittent failure rates.

Independent upstream reports still show Grok Responses streams ending without terminal events outside Condukt, so an upstream/runtime failure may remain after the architecture correction.

## Data handling

The diagnostic retained only runtime/model configuration, event types, request/service identifiers, latency, terminal outcome, and coarse failure class. Prompt, reasoning, and assistant response content were not persisted in this report.
