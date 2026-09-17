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
  → scheduler.recordUsageCosts emits one cost:recorded per usage record
    (main + subagent provenance, success AND failure paths)
  → reducer folds cost into projection.totalCost (persisted, replayable)
```

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
