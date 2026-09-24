# Cost Accounting (AIC)

Condukt records billed AI usage per request and folds it into a monotonic
per-execution total. All amounts are **AI credits (AIC)**, the Copilot-native
billing unit.

## Unit

```
1 AIC = 1e9 nano-AIU = $0.01
```

The Copilot SDK reports each request's billed charge as nano AI units
(`assistant.usage` → `copilotUsage.totalNanoAiu`; session aggregates in
`session.shutdown` / `session.usage_checkpoint`). See `src/cost.ts`:

- `NANO_AIU_PER_AIC = 1_000_000_000`
- `nanoAiuToAic(nanoAiu)` — non-finite/negative input bills 0
- `defaultCostResolver(usage, model)` — bills the direct `totalNanoAiu`
  charge, else the nested `copilotUsage.totalNanoAiu` charge, else 0.
  Tokens alone are never priced here: without a per-model rate table there
  is no honest conversion, and rate tables rot. Consumers with their own
  pricing pass their own resolver.

## Pipeline

```
SDK assistant.usage (tokens, model, totalNanoAiu, duration)
  → agent.ts forwards totalNanoAiu/duration into node:usage output
    + metadata.usage / attemptUsage[] / subagentUsage[]
    + metadata.advisorUsage[] / standInUsage[] (see below)
  → scheduler.recordUsageCosts emits one cost:recorded per usage record
    (main + subagent + advisor + stand_in provenance, success AND failure paths)
  → reducer folds cost into projection.totalCost + projection.costByProvenance
    (persisted, replayable)
```

### Advisor / stand_in tool sessions

The `advisor` and `stand_in` tools run as separate one-shot SDK sessions
whose `assistant.usage` events never reach the parent session listener.
`runOneShotSession` therefore subscribes to the side session live (usage
events are ephemeral and absent from `getEvents()`) and returns the captured
records alongside the text. The tool handlers forward them to the parent
`CopilotSession` as a `tool_usage` event; `agent.ts` attributes them to
`metadata.advisorUsage` / `metadata.standInUsage` with their own serving
model (never the lead model), and the scheduler bills them under the
`advisor` / `stand_in` provenance. Failed tool calls report zero records but
still emit, so accounting stays complete; per-member records survive sibling
failures and later-round failures.

### Advisor prompt assembly (layered input)

Each advisor call is assembled server-side in positional order (highest
privilege and most decision-relevant content at the edges, where
long-context use is strongest):

```
OPERATOR FOCUS (§0, when configured — verbatim, lead-independent)
CALLER CONTEXT (lead-curated summary + the one specific question)
CALLING SESSION TRANSCRIPT (recency-walked, untrusted-data labeled)
OPERATOR FOCUS (RESTATED, when configured — query-at-both-ends)
```

- `AdvisorConfig.operatorFocus` injects §0 verbatim; per-execution
  `AgentConfig.advisorOperatorFocusResolver` (mirrors `cwdResolver`) wins
  over the static value. Empty focus omits §0 and the restatement, leaving
  the pre-focus layout byte-identical.
- `AdvisorConfig.maxRecentTranscriptChars` caps the auto-forwarded
  transcript independently (default 8_000; `0` sends headers with an empty
  transcript). An explicit legacy `maxTranscriptChars` is honored when the
  new field is absent, for migration.
- Every advisor `tool_usage` emission carries `sectionSizes`
  (`focusChars`, `contextChars`, `transcriptChars`, `promptChars`) so
  consumers can measure the curated-vs-transcript mix per call, node, and
  execution.

`node:reset`, `route:resolved`, `node:retrying`, and resume never zero
`totalCost`: the event log is append-only, so **redos, retries, loop
iterations, and resumes all accumulate**. `sum(cost:recorded.cost WHERE
executionId=X)` is the auditable total; `projection.totalCost` is the cached
sum. Failed attempts with reported usage are billed; failures with zero usage
emit no cost event.

## Consumer contract

- `RunOptions.costResolver?: (usage, model) => number` — custom billing hook.
- `BridgeOptions.costResolver?` — defaults to `defaultCostResolver`;
  applied to launch, resume, and retry runs. Pass `false`-equivalent custom
  `() => 0` only to deliberately disable billing.
- `UsageData.totalNanoAiu?`, `UsageData.duration?`, `NodeUsageEvent`
  carries both for live display. `CostRecordedEvent` carries
  `{ executionId, nodeId, tokens, model, provenance, cost, ts }`.

Requests without a reported charge bill 0. Historical executions (pre-cost
events) report `totalCost: 0`.
