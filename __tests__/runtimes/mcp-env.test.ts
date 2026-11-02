/**
 * MCP env-reference resolution, shared by the Copilot and Claude config
 * mappers. The replacement-safety cases matter most: a credential is arbitrary
 * user data, and `String.replace` with a string replacement would expand `$&`,
 * `$1`, and `$$` found inside it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveMcpEnvironmentRecord,
  resolveMcpEnvironmentValue,
  resolveMcpHeaders,
} from '../../runtimes/mcp-env';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('resolveMcpEnvironmentValue', () => {
  it('resolves a whole-value reference and takes the first set fallback', () => {
    vi.stubEnv('CONDUKT_MCP_A', '');
    vi.stubEnv('CONDUKT_MCP_B', 'b-value');
    expect(resolveMcpEnvironmentValue('${CONDUKT_MCP_A|CONDUKT_MCP_B|CONDUKT_MCP_C}')).toBe('b-value');
    expect(resolveMcpEnvironmentValue('plain-value')).toBe('plain-value');
    expect(resolveMcpEnvironmentValue('${CONDUKT_MCP_MISSING}')).toBeUndefined();
  });

  it('resolves a record and drops entries no variable satisfies', () => {
    vi.stubEnv('CONDUKT_MCP_TOKEN', 'tok');
    expect(resolveMcpEnvironmentRecord({
      TOKEN: '${CONDUKT_MCP_TOKEN}',
      STATIC: 'literal',
      MISSING: '${CONDUKT_MCP_MISSING}',
    })).toEqual({ TOKEN: 'tok', STATIC: 'literal' });
    expect(resolveMcpEnvironmentRecord(undefined)).toBeUndefined();
  });
});

describe('resolveMcpHeaders', () => {
  it('inserts credentials containing replacement patterns literally', () => {
    vi.stubEnv('CONDUKT_MCP_TOKEN', 'pa$&ss$1$$word');
    expect(resolveMcpHeaders({ Authorization: 'Bearer ${CONDUKT_MCP_TOKEN}' }))
      .toEqual({ Authorization: 'Bearer pa$&ss$1$$word' });
  });

  it('resolves several embedded references in one header', () => {
    vi.stubEnv('CONDUKT_MCP_A', 'a');
    vi.stubEnv('CONDUKT_MCP_B', 'b');
    expect(resolveMcpHeaders({ 'X-Combo': '${CONDUKT_MCP_A}-${CONDUKT_MCP_B}' }))
      .toEqual({ 'X-Combo': 'a-b' });
  });

  it('drops an unsatisfiable header and reports the names it tried', () => {
    const missing = vi.fn();
    const headers = resolveMcpHeaders(
      { Authorization: 'Bearer ${CONDUKT_MCP_NOPE|CONDUKT_MCP_ALSO_NOPE}' },
      missing,
    );
    expect(headers).toBeUndefined();
    expect(missing).toHaveBeenCalledWith({
      header: 'Authorization',
      names: ['CONDUKT_MCP_NOPE', 'CONDUKT_MCP_ALSO_NOPE'],
    });
  });

  it('leaves headers without references untouched', () => {
    expect(resolveMcpHeaders({ 'X-Static': 'plain' })).toEqual({ 'X-Static': 'plain' });
    expect(resolveMcpHeaders(undefined)).toBeUndefined();
  });
});
