import { describe, it, expect } from 'vitest';
import { mapConfig, mapPermissionMode } from '../../../runtimes/claude/config-mapper';

describe('config-mapper', () => {
  it('default autonomous bypass', () => {
    const r = mapPermissionMode(undefined, undefined);
    expect(r.mode).toBe('bypassPermissions');
    expect(r.requiresDangerousSkip).toBe(true);
  });
  it('plan mode', () => {
    expect(mapPermissionMode('plan', undefined).mode).toBe('plan');
  });
  it('read-only dontAsk + deny tools', () => {
    const r = mapPermissionMode(undefined, 'read-only');
    expect(r.mode).toBe('dontAsk');
    const cfg = mapConfig({ model: 'm', cwd: '/tmp', addDirs: [], timeout: 1, heartbeatTimeout: 1, permissionPolicy: 'read-only' } as any);
    expect(cfg.options.disallowedTools).toContain('Write');
    expect(cfg.options.allowedTools).toEqual(['Read','Grep','Glob']);
  });
  it('maps custom agents and mcp', () => {
    const cfg = mapConfig({ model: 'm', cwd: '/tmp', addDirs: [], timeout: 1, heartbeatTimeout: 1, customAgents: [{ name: 'a', prompt: 'p' }], mcpServers: { s: { command: 'x' } } } as any);
    expect(cfg.options.agents).toHaveProperty('a');
    expect(cfg.options.mcpServers).toHaveProperty('s');
  });
  it('excluded builtin agents -> disallowed', () => {
    const cfg = mapConfig({ model: 'm', cwd: '/tmp', addDirs: [], timeout: 1, heartbeatTimeout: 1, excludedBuiltinAgents: ['Explore'] } as any);
    expect(cfg.options.disallowedTools).toContain('Explore');
  });
  it('maps thinkingBudget to effort (1:1)', () => {
    const cfg = mapConfig({ model: 'm', cwd: '/tmp', addDirs: [], timeout: 1, heartbeatTimeout: 1, thinkingBudget: 'xhigh' } as any);
    expect(cfg.options.effort).toBe('xhigh');
    const none = mapConfig({ model: 'm', cwd: '/tmp', addDirs: [], timeout: 1, heartbeatTimeout: 1 } as any);
    expect(none.options.effort).toBeUndefined();
  });
  it('merges bridge env over process.env (SDK replaces child env)', () => {
    const cfg = mapConfig(
      { model: 'm', cwd: '/tmp', addDirs: [], timeout: 1, heartbeatTimeout: 1 } as any,
      { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234', ANTHROPIC_API_KEY: 'fake' } },
    );
    expect(cfg.options.env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:1234');
    expect(cfg.options.env?.ANTHROPIC_API_KEY).toBe('fake');
    // PATH preserved from process.env so the CLI can still spawn.
    expect(cfg.options.env?.PATH).toBe(process.env.PATH);
    const plain = mapConfig({ model: 'm', cwd: '/tmp', addDirs: [], timeout: 1, heartbeatTimeout: 1 } as any);
    expect(plain.options.env).toBeUndefined();
  });

  it('maps tier models to ANTHROPIC_DEFAULT_* env vars (no defaults shipped)', () => {
    const cfg = mapConfig({
      model: 'm',
      cwd: '/tmp',
      addDirs: [],
      timeout: 1,
      heartbeatTimeout: 1,
      claude: { tierModels: { opus: 'deepseek-v4-pro', sonnet: 'gpt-6-luna' } },
    } as any);
    expect(cfg.options.env?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('deepseek-v4-pro');
    expect(cfg.options.env?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-6-luna');
    expect(cfg.options.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
    const bare = mapConfig({ model: 'm', cwd: '/tmp', addDirs: [], timeout: 1, heartbeatTimeout: 1 } as any);
    expect(bare.options.env).toBeUndefined();
  });

  it('maps autoCompact window to SDK settings and pct/context to env', () => {
    const cfg = mapConfig({
      model: 'm',
      cwd: '/tmp',
      addDirs: [],
      timeout: 1,
      heartbeatTimeout: 1,
      claude: { autoCompact: { window: 200000, pctOverride: 80, maxContextTokens: 210000 } },
    } as any);
    expect(cfg.options.settings).toEqual({ autoCompactWindow: 200000 });
    expect(cfg.options.env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('80');
    expect(cfg.options.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('210000');
    expect(cfg.options.env?.PATH).toBe(process.env.PATH);
  });

  it('caller env wins over claude env defaults', () => {
    const cfg = mapConfig(
      {
        model: 'm',
        cwd: '/tmp',
        addDirs: [],
        timeout: 1,
        heartbeatTimeout: 1,
        claude: { autoCompact: { maxContextTokens: 1 } },
      } as any,
      { env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '42' } },
    );
    expect(cfg.options.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('42');
  });

  it('maps per-agent effort into the agent definition', () => {
    const cfg = mapConfig({
      model: 'm',
      cwd: '/tmp',
      addDirs: [],
      timeout: 1,
      heartbeatTimeout: 1,
      customAgents: [{ name: 'a', prompt: 'p', model: 'cheap', effort: 'low' }],
    } as any);
    expect((cfg.options.agents as any).a.effort).toBe('low');
    expect((cfg.options.agents as any).a.model).toBe('cheap');
  });

  it('session-level epoch config does not leak into CLI options', () => {
    const cfg = mapConfig({
      model: 'm',
      cwd: '/tmp',
      addDirs: [],
      timeout: 1,
      heartbeatTimeout: 1,
      claude: { epoch: { enabled: false } },
    } as any);
    expect(cfg.options.env).toBeUndefined();
    expect(cfg.options.settings).toBeUndefined();
  });
});
