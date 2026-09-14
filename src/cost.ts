/**
 * AI-credit (AIC) cost accounting.
 *
 * The Copilot SDK reports per-request billed cost as nano AI units
 * (`assistant.usage` → `copilotUsage.totalNanoAiu`, `session.shutdown` →
 * per-model `totalNanoAiu`). GitHub pegs 1 AIC = $0.01, and 1 AIC = 1e9
 * nano-AIU, so AIC = totalNanoAiu / 1e9.
 *
 * This module is billing-math only: no model price tables live here. When the
 * SDK omits nano-AIU for a request, the default resolver bills 0 and the
 * consumer may supply its own `costResolver` (e.g. tokens × published rates).
 */

/** Nano AI units per AI credit. 1 AIC = 1e9 nano-AIU = $0.01. */
export const NANO_AIU_PER_AIC = 1_000_000_000;

/** Convert nano AI units to AI credits. Non-finite or negative input bills 0. */
export function nanoAiuToAic(nanoAiu: number): number {
  if (!Number.isFinite(nanoAiu) || nanoAiu <= 0) return 0;
  return nanoAiu / NANO_AIU_PER_AIC;
}

function readNanoAiu(usage: Readonly<Record<string, unknown>>): number | undefined {
  const direct = usage.totalNanoAiu;
  if (typeof direct === 'number') return direct;
  // The SDK nests the charge under `copilotUsage.totalNanoAiu` in some payloads.
  const nested = usage.copilotUsage;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const total = (nested as Readonly<Record<string, unknown>>).totalNanoAiu;
    if (typeof total === 'number') return total;
  }
  return undefined;
}

/**
 * Default cost resolver: bills the SDK-reported nano-AIU charge as AIC.
 * Requests without a reported charge bill 0 (tokens alone cannot be priced
 * without a per-model rate table, which belongs to the consumer).
 */
export function defaultCostResolver(
  usage: Readonly<Record<string, unknown>>,
  _model: string | undefined,
): number {
  const nanoAiu = readNanoAiu(usage);
  return nanoAiu === undefined ? 0 : nanoAiuToAic(nanoAiu);
}
