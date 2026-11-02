/**
 * Environment-reference resolution shared by runtime MCP config mappers.
 *
 * condukt MCP configs may embed `${NAME}` / `${NAME|FALLBACK|...}` references
 * in env values and headers. Resolving them is runtime-independent, so the
 * logic lives here rather than in any one backend.
 */

/** Matches a whole env value that is a single `${A|B|...}` reference. */
const ENV_REFERENCE = /^\$\{([A-Z_][A-Z0-9_]*(?:\|[A-Z_][A-Z0-9_]*)*)\}$/;

/**
 * Resolves ${NAME} and ${NAME|FALLBACK|...}, taking the first variable that is set.
 *
 * The fallback chain exists because there is no single conventional name for a GitHub
 * token: the Copilot CLI itself reads COPILOT_GITHUB_TOKEN, then GH_TOKEN, then
 * GITHUB_TOKEN. A default that insisted on one spelling would silently ship an
 * unauthenticated server in any environment that chose a different one.
 */
export function resolveMcpEnvironmentValue(value: string): string | undefined {
  const match = ENV_REFERENCE.exec(value);
  if (!match) return value;
  for (const name of match[1]!.split('|')) {
    const resolved = process.env[name];
    if (resolved !== undefined && resolved !== '') return resolved;
  }
  return undefined;
}

export function resolveMcpEnvironmentRecord(
  values: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (values === undefined) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const environmentValue = resolveMcpEnvironmentValue(value);
    if (environmentValue !== undefined) resolved[key] = environmentValue;
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** A header value contained a reference none of whose names is set. */
export interface McpMissingHeader {
  readonly header: string;
  readonly names: readonly string[];
}

/**
 * Embedded references, so `Bearer ${A|B}` resolves rather than only a bare `${A|B}`. The
 * fallback alternatives must be part of the pattern: a reference matcher without them finds
 * nothing in `${A|B}`, leaves the value untouched, and emits the placeholder as a literal
 * header — an unauthenticated server that reports no error and simply returns no tools.
 */
const HEADER_ENV_REFERENCE = /\$\{([A-Z_][A-Z0-9_]*(?:\|[A-Z_][A-Z0-9_]*)*)\}/g;

export function resolveMcpHeaders(
  headers: Record<string, string> | undefined,
  onMissing?: (missing: McpMissingHeader) => void,
): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const references = [...value.matchAll(HEADER_ENV_REFERENCE)];
    let resolvedValue = value;
    let complete = true;
    for (const reference of references) {
      const names = reference[1]!.split('|');
      const environmentValue = names
        .map((name) => process.env[name])
        .find((candidate) => candidate !== undefined && candidate !== '');
      if (environmentValue === undefined) {
        // Dropping the header is deliberate — a missing credential must not abort a run — but
        // it is invisible at the server, which just answers with nothing.
        onMissing?.({ header: key, names });
        complete = false;
        break;
      }
      // Replacer function, not a string: a credential containing `$&`, `$1`,
      // or `$$` would otherwise be expanded as a replacement pattern.
      resolvedValue = resolvedValue.replace(reference[0], () => environmentValue);
    }
    if (complete) resolved[key] = resolvedValue;
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}
