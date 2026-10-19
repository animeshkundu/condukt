# Claude Runtime (Self-Contained)

Condukt supports a Claude Agent SDK runtime as a fallback to the default Copilot runtime.

## Selection

- Default: Copilot SDK (requires Copilot login).
- Fallback: Claude Agent SDK when Copilot is unavailable or fails.
- `FallbackRuntime` prefers Copilot and falls back transparently (logs a warning).

## Setup

Install the optional peer dependency:

```sh
npm install @anthropic-ai/claude-agent-sdk
```

Claude SDK spawns the Claude Code CLI; ensure it is available on `PATH` or set `CLAUDE_CODE_EXECUTABLE`.

### Environment variables

| Variable | Purpose |
|---|---|
| `CONDUKT_SAFE_MODE` | `1`/`true` disables bypass permissions (uses `dontAsk`) |
| `CLAUDE_CODE_EXECUTABLE` | Override the Claude Code CLI binary |
| `CONDUKT_SESSION_EPOCH` | `false`/`off`/`0` forces session epochs off (operator brake, wins over config) |
| `CONDUKT_SESSION_ROTATE` | `false`/`off`/`0` forces stagnation rotation off (wins over config) |
| `CONDUKT_EPOCH_PATH` | Override the epoch sidecar path |
| `CONDUKT_EPOCH_DEBUG` | `1`/`true` logs epoch bumps/rotations to stderr |

When a bridge is configured, the runtime injects `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` (fake credentials; the bridge authenticates upstream itself), and, when `bridgeSecret` is set, `ANTHROPIC_CUSTOM_HEADERS: x-condukt-bridge-secret: …` into the CLI subprocess via `Options.env` (merged over `process.env`).

## Self-contained bridge

`createBridge()` starts an in-process HTTP server (127.0.0.1 only) exposing an Anthropic-compatible surface:

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `GET /v1/models` (ids from `modelAliasMap`)

### Protocols

Upstream traffic is translated to one of three OpenCode Go / Zen surfaces, chosen per model:

| Protocol | Endpoint shape | Behavior |
|---|---|---|
| `anthropic` | `…/anthropic/v1/messages` | Raw pass-through; `cache_control` preserved |
| `openai` | `…/openai/v1/chat/completions` | Full request + SSE translation; cache stamping; chat extras |
| `responses` | `…/openai/v1/responses` | Full request + SSE translation (text-only; media/web-search raise) |

Routing precedence: explicit `protocol` force → `protocolMap[model]` → OpenCode docs table (exact model ids) → family fallback (`gpt-`/`grok-`/`muse-spark-` → responses; `claude-` → anthropic) — family fallback only applies to OpenCode bases; an Anthropic host defaults to `anthropic`, any other base to `openai`.

Endpoint derivation is shape-aware (live-verified):

- `…/inference`, `…/inference/go` (Go + Console docs shape) → `/{anthropic|openai}/v1/…`
- `…/zen`, `…/zen/go` (reference shape) → conventional `/v1/…`
- `…/v1` bases → conventional `/chat/completions`, `/messages`, `/responses`
- generic hosts → `/v1/…`

`endpoints` explicitly overrides individual protocols. Zen-only catalog ids (e.g. `space-bunny-free`, `gpt-6-astra`) resolve to a secondary Console base when one is derivable from the Go base (`zenBaseUrl` overrides; `zenEndpoints` overrides its protocol paths). Models the bridge cannot speak (`gemini-*`, `jev-*`, `omen-alpha`, `test`) are rejected with a 400 before any upstream call.

### Caching

- `x-opencode-session` header on every upstream request (session-scoped routing).
- Chat/completions bodies are stamped with `prompt_cache_key` (derived from the era-labeled session id, see below) and `prompt_cache_retention: 24h`; GLM/zhipu models are excluded.
- A 400 whose message matches the cache-field rejection signature strips the fields for that model and retries; the downgrade is remembered (and persisted to `stateFile` when configured).
- Responses-protocol bodies are never stamped (parity with the reference proxy).

### Session compaction epochs (`-eN` / `-rM`)

A post-compaction conversation reads as a new session upstream (fresh routing
affinity + cache namespace). Every session is era-labeled from birth:

- Non-OpenCode bases use the literal suffixed id (`<session>-e0`, `<session>-e2-r1`).
- OpenCode hosts keep a client-shaped base verbatim at era 0 (backward compatible)
  and mint a fresh client-shaped `ses_…` id per later era value; the cache key
  always carries the literal `-eN` suffix.
- Epoch `+1` fires at an exact compaction boundary (the SDK `compaction` event,
  phase `complete` → `bridge.notifyCompaction()`), or heuristically when an
  input shrink (< 60 % of the tracked max, ≥ 40 K pre / 25 K post floors), a
  novel head, and a calm streak (≥ 3 steady turns) coincide, followed by a
  5-request cooldown.
- `-rM` (stagnation rotation) fires when cached-token reads are flat/inverted
  across a streak (≥ 5 turns; ≥ 3 when the input-cached gap is ≥ 25 K), the
  head is unchanged and the window is monotonic — capped by the same cooldown,
  reset by compaction.
- State persists to a sidecar (atomic temp+rename; 7-day TTL GC; throttled
  every 16th request, synchronous on bump/rotate/compaction). Path resolution:
  `epochStateFile` → `CONDUKT_EPOCH_PATH` (relative paths resolve against the
  process cwd) → `<stateFile>.epochs.json` →
  `~/.condukt/claude-session-epochs.json` (skipped under test runners).
  The sidecar is keyed by session id, so eras survive restarts only when the
  consumer pins a stable `sessionId` (the default is a fresh UUID per session,
  which makes persistence inert across restarts by design).
- All floors/ratios above are expressed in the bridge's input estimate
  (characters ÷ 3 — the same no-tokenizer fallback the reference uses when
  tiktoken is absent), so thresholds live in estimate space, not exact
  tokenizer space.
- Kill switches: `SessionConfig.claude.epoch` / bridge `epochEnabled` /
  `epochRotateEnabled`, with the env brakes above taking precedence; disabled
  epochs keep tracking and use the verbatim session id (legacy behavior).
- Fail-open throughout: unusable bodies, malformed sidecars, and unwritable
  paths never fail a request; a malformed fingerprint leaves the stored epoch
  untouched.

### Chat extras (DeepSeek / GLM families only)

- `thinking` toggle and `reasoning_effort` mapped per family (`max` verbatim; `medium`/`xhigh` → `high`; `minimal` → `low` for DeepSeek only).
- `user_id` = sha256(era-labeled session)[:32] (KV isolation follows `-eN`/`-rM`); DeepSeek defaults `top_p` to 0.95 when unset; `max_tokens` floors (low 16384, high 65536, max 131072).
- Required/named `tool_choice` with thinking enabled → loud 400 (upstream limitation).
- `thinkingBudget` (condukt) maps 1:1 to the Claude SDK `effort` option; the bridge reads `effort` / `output_config.effort` / `thinking.effort` and maps it onto the upstream family.

### Streaming

- Keepalive `: ping` comments during upstream silence; idle timeout fails closed.
- Chat translation emits a proper `message_start`, reasoning → thinking blocks, stable block indices, `input_json_delta` for tool calls, `message_delta` → `message_stop`.
- Responses translation requires a terminal event; EOF without one fails closed. Truncated tool calls (length cut) error out without certifying a result.
- Mid-stream failures after client-visible output close open blocks and emit an `error` event (chat also emits a final `message_delta` with `stop_reason: "error"`).

### Config

`ClaudeRuntimeOptions.bridge` (per runtime) accepts:

| Field | Purpose |
|---|---|
| `upstreamBaseUrl` | OpenCode base (`/inference/go`, `/zen/go`), `/v1` base, or host base |
| `upstreamApiKey` | Upstream credential (`x-api-key` for Anthropic, `Bearer` otherwise) |
| `modelAliasMap` | Client model id → upstream model id |
| `protocol` / `protocolMap` / `endpoints` | Routing overrides |
| `zenBaseUrl` / `zenEndpoints` | Console (Zen) base for gap-fill of Zen-only model ids |
| `bridgeSecret` | Enforce `x-condukt-bridge-secret` on inbound requests |
| `stateFile` | Persist cache downgrades across runs |
| `epochEnabled` / `epochRotateEnabled` | Epoch identity + `-rM` rotation kill switches (default on) |
| `epochStateFile` | Epoch sidecar path, or `false` to disable persistence |
| `epochConstants` | Threshold overrides (tests/embedders) |
| `port` / `sessionId` | Ephemeral port by default; session id defaults to a fresh UUID per session |
| `maxAttempts`, `requestTimeoutMs`, `keepAliveMs`, `idleTimeoutMs`, `maxBodyBytes`, `cacheKeyEnabled` | Tuning |

Metrics: `handle.metrics` → `{ requestCount, downgradeCount, cacheStampedCount, errorCount, epochBumps, epochRotations, cacheReadTokens, cacheWriteTokens, protocolCounts }`.

Session-level configuration (`SessionConfig.claude`, takes precedence over bridge defaults):

| Field | Purpose |
|---|---|
| `tierModels` | `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` env overrides (no defaults shipped) |
| `autoCompact.window` | SDK `settings.autoCompactWindow` |
| `autoCompact.pctOverride` / `maxContextTokens` | `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` / `CLAUDE_CODE_MAX_CONTEXT_TOKENS` |
| `epoch` | `{ enabled?, rotate?, stateFile? }` |

`customAgents[].effort` maps to the SDK agent definition's `effort` (same union as `ThinkingBudget`).

One bridge is started lazily per session (`session.ensureBridge()`) and closed on `abort()`.

## Capability matrix

| Feature | Claude |
|---|---|
| Core events (text, reasoning, tool, idle, error) | ✅ |
| usage | ✅ |
| compaction | ✅ (complete only) |
| subagents | ✅ (translated) |
| permission | ✅ (translated) |
| continueSession (nudge) | ✅ |
| timeout/heartbeat | ✅ |
| advisor | ✅ (one-shot) |
| stand-in (oracle) | ✅ (consumer aliases) |
| MCP | ✅ |
| loops / quorum / scheduler / state | ✅ (runtime-agnostic) |
| caching | ✅ (bridge) |
| session recovery | ⚠️ (resume only, no policy) |
| context attribution | ✅ (getContextUsage; compaction count not reported) |
| history summarize/truncate | ⚠️ (summarize basic; truncate unsupported) |
| partial tool output | ✅ (tool_progress) |
| excluded builtin agents | ✅ (disallowedTools) |
| contextTier | N/A (model selection) |
| intent | ❌ (Copilot-specific) |

## Permissions

- Default: `bypassPermissions` (autonomous). Documented security warning: only use in trusted/contained environments.
- `mode: 'plan'`: Claude plan mode.
- `permissionPolicy: 'read-only'`: `dontAsk` + write tools denied.

## Advisor / stand-in

Condukt makes no model assumptions. Configure `advisor.model` and `standIn.members` (explicit model ids). If `members` is absent, stand-in is disabled (no silent degradation).

## Error codes

`CONDUKT_<DOMAIN>_<REASON>` (e.g. `CONDUKT_RUNTIME_UNAVAILABLE`, `CONDUKT_MODEL_ALIAS_INVALID`, `CONDUKT_MCP_CONFIG_INVALID`).

## Live verification status

Verified with a real `opencode-go` credential, `$0` models only (no paid probes):

| Surface | Model | Result |
|---|---|---|
| Go chat (free) | `longcat-2.5-preview-free` | non-stream + SSE stream 200; `reasoning_content` deltas |
| Go chat (free) | `beam-free` | 200; full Claude SDK turn through the bridge (`"pong"`, tools round-trip) |
| Go chat (included) | `deepseek-v4.1-flash` | full Claude SDK turn through the bridge; Bash round-trip (`cat hello.txt` → `hello world`), reasoning deltas, usage, 0 errors |
| Go chat (included) | `deepseek-v4.1-flash` | 3 continued turns with epochs live: era-0 id stable, `notifyCompaction()` → fresh `ses_…` id + `-e1` cache key + sidecar epoch 1; turn-2 cache read **25,856 / 25,972 tokens (99.5 %)**, 0 errors |
| Go responses | `muse-spark-1.3-contributor` | 2 continued turns through the Claude SDK (`PONG`/`PONG2`), cached usage surfaced (24,945 tokens), 0 errors |
| Go responses | `gpt-6-luna` (included) | non-stream + SSE 200 |
| Go anthropic | `claude-haiku-5-5` (included) | 200; native usage shape |
| Go `count_tokens` | — | upstream 404; the bridge answers locally with an estimate |
| Console free | `space-bunny-free`, `glm-5.3-flash-free` | upstream `FreeTierError` (see below) |

Console free-tier models (`*-free` on the Console base) are gated server-side (`403 FreeTierError: "can only be used from within OpenCode"`). Live probing shows the gate wants a Console member credential (the device-flow `st_...` session token, not the Go API key), a client-shaped `x-opencode-session` (`ses_` + 12 hex + 14 base62 — arbitrary ids are rejected), `x-opencode-client`, and a streaming body with tools; requests matching all of that still get rejected for some payload shapes, so the gate is not fully reproducible outside the client. Use the Go base for automation.

Notes from live probing:

- DeepSeek prompt caching is content-based server-side: a continued session read ~99.5 % of its ~26 K-token prefix on turn 2, and the hit rate held after an era rotation minted a new `prompt_cache_key` (the key drives routing affinity/cache namespace separation on first-use, not prefix identity). Cache reads surface as `prompt_tokens_details.cached_tokens` (chat) and `input_tokens_details.cached_tokens` (responses); both feed `metrics.cacheReadTokens` and the stagnation detector.
- Requests to OpenCode hosts carry the client identity the Console expects: the client User-Agent shape, `x-opencode-client: cli`, and a client-shaped `x-opencode-session` (the bridge mints `ses_` + descending-time + base62 ids per configured session and per post-compaction era; non-OpenCode bases keep the raw session value plus the literal `-eN` suffix and condukt's own User-Agent).
- The Go chat endpoint also accepts the conventional `/v1/chat/completions` path; the `/zen/go` legacy base accepts only the conventional shape.
- `max_completion_tokens` is only emitted for DeepSeek/GLM chat families (other models reject it alongside `max_tokens`).
- Free models are thinking-by-default; tiny `max_tokens` budgets may be consumed by reasoning before any text.

## Security notes

- Bypass permissions default is dangerous; use `CONDUKT_SAFE_MODE=1` or containers.
- MCP servers: allowlist, timeouts, credential redaction at all sinks.
- Bridge binds to localhost only; `bridgeSecret` is opt-in but recommended.
