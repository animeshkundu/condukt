import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CustomAgentConfig, MCPServerConfig, SessionConfig } from '../../../src/types';
import {
  mapConfig,
  mapPermissionMode,
  toClaudeMcpServers,
} from '../../../runtimes/claude/config-mapper';

function base(extra: Partial<SessionConfig> = {}): SessionConfig {
  return {
    model: 'm',
    cwd: '/workspace',
    addDirs: [],
    timeout: 1,
    heartbeatTimeout: 1,
    ...extra,
  };
}

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  vi.unstubAllEnvs();
  process.env = { ...ORIGINAL_ENV };
});

describe('config-mapper', () => {
  describe('permission modes', () => {
    it('default autonomous bypass', () => {
      const r = mapPermissionMode(undefined, undefined);
      expect(r.mode).toBe('bypassPermissions');
      expect(r.requiresDangerousSkip).toBe(true);
    });

    it('plan mode', () => {
      expect(mapPermissionMode('plan', undefined).mode).toBe('plan');
    });

    it('read-only uses dontAsk plus a positive built-in allow-list', () => {
      const r = mapPermissionMode(undefined, 'read-only');
      expect(r.mode).toBe('dontAsk');
      const cfg = mapConfig(base({ permissionPolicy: 'read-only' }));
      expect(cfg.options.tools).toEqual(['Read', 'Grep', 'Glob']);
      expect(cfg.options.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
      // No negative deny-list is needed: the built-in preset is restricted to
      // the allow-list, so a page of denials cannot drift out of date.
      expect(cfg.options.disallowedTools).toBeUndefined();
    });

    it('read-only intersects an explicit built-in allow-list', () => {
      const cfg = mapConfig(base({
        permissionPolicy: 'read-only',
        availableTools: ['builtin:Read', 'builtin:Bash', 'builtin:Grep'],
      }));
      expect(cfg.options.tools).toEqual(['Read', 'Grep']);
      expect(cfg.options.allowedTools).toEqual(['Read', 'Grep']);
    });

    it('read-only safe mode also denies subagents only when disabled', () => {
      const cfg = mapConfig(base({ permissionPolicy: 'read-only' }));
      expect(cfg.options.disallowedTools).toBeUndefined();
      const noAgents = mapConfig(base({ subagentsEnabled: false }));
      expect(noAgents.options.disallowedTools).toEqual(expect.arrayContaining(['Agent', 'Task']));
    });
  });

  describe('availableTools translation', () => {
    it('builtin:* selects the full preset', () => {
      const cfg = mapConfig(base({ availableTools: ['builtin:*'] }));
      expect(cfg.options.tools).toEqual({ type: 'preset', preset: 'claude_code' });
    });

    it('named built-ins restrict Options.tools', () => {
      const cfg = mapConfig(base({ availableTools: ['builtin:Read', 'builtin:Grep', 'Bash'] }));
      expect(cfg.options.tools).toEqual(['Read', 'Grep', 'Bash']);
    });

    it('legacy built-in names resolve through the SDK alias table', () => {
      const cfg = mapConfig(base({ availableTools: ['builtin:Task'] }));
      expect(cfg.options.tools).toEqual(['Agent']);
    });

    it('an allow-list without an MCP entry prunes every server', () => {
      const cfg = mapConfig(base({
        availableTools: ['builtin:Read'],
        mcpServers: { s: { command: 'x' } },
      }));
      // An empty map is deliberate: it suppresses condukt's servers, and the
      // strict flag is what stops the SDK discovering `.mcp.json`, user
      // settings, and plugin servers instead.
      expect(cfg.options.mcpServers).toEqual({});
      expect(cfg.options.strictMcpConfig).toBe(true);
    });

    it('a kept server set leaves host discovery alone', () => {
      const cfg = mapConfig(base({ mcpServers: { s: { command: 'x' } } }));
      expect(cfg.options.mcpServers).toHaveProperty('s');
      // Strict mode is only for "condukt supplies none": a main session that
      // keeps servers must not silently drop the host's own MCP config.
      expect(cfg.options.strictMcpConfig).toBeUndefined();
    });

    it('mcp:* keeps servers and their per-tool policies', () => {
      const cfg = mapConfig(base({
        availableTools: ['mcp:*'],
        mcpServers: { s: { command: 'x', tools: ['search', 'fetch'] } },
      }));
      expect(cfg.options.mcpServers).toHaveProperty('s');
      expect(cfg.options.allowedTools).toEqual(['mcp__s__search', 'mcp__s__fetch']);
    });

    it('mcp:<tool> becomes exact mcp__server__tool auto-allow names', () => {
      const cfg = mapConfig(base({
        availableTools: ['mcp:search'],
        mcpServers: { alpha: { command: 'x' }, beta: { command: 'y' } },
      }));
      expect(cfg.options.allowedTools).toEqual(['mcp__alpha__search', 'mcp__beta__search']);
    });

    it('custom entries are reported once and otherwise ignored', () => {
      const onDiagnostic = vi.fn();
      const cfg = mapConfig(
        base({ availableTools: ['custom:thing', 'custom:thing'] }),
        { onDiagnostic },
      );
      expect(cfg.options.tools).toEqual([]);
      expect(onDiagnostic).toHaveBeenCalledTimes(1);
      expect(onDiagnostic).toHaveBeenCalledWith(expect.stringContaining('custom:thing'));
    });
  });

  describe('deny-lists and agents', () => {
    it('merges excludedTools with defaultAgent.excludedTools', () => {
      const cfg = mapConfig(base({
        excludedTools: ['Bash'],
        defaultAgent: { excludedTools: ['WebFetch'] },
      }));
      expect(cfg.options.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'WebFetch']));
    });

    it('subagentsEnabled:false disallows Agent and its legacy Task alias', () => {
      const cfg = mapConfig(base({ subagentsEnabled: false }));
      expect(cfg.options.disallowedTools).toEqual(expect.arrayContaining(['Agent', 'Task']));
    });

    it('excludedBuiltinAgents has no Claude equivalent and is reported', () => {
      const onDiagnostic = vi.fn();
      const cfg = mapConfig(
        base({ excludedBuiltinAgents: ['Explore'] }),
        { onDiagnostic },
      );
      expect(cfg.options.disallowedTools).toBeUndefined();
      expect(onDiagnostic).toHaveBeenCalledWith(expect.stringContaining('excludedBuiltinAgents'));
    });

    it('maps custom agents, including per-agent effort and model', () => {
      const agent: CustomAgentConfig = {
        name: 'a',
        prompt: 'p',
        model: 'cheap',
        effort: 'low',
        displayName: 'Display',
      };
      const onDiagnostic = vi.fn();
      const cfg = mapConfig(base({ customAgents: [agent] }), { onDiagnostic });
      const def = (cfg.options.agents as Record<string, Record<string, unknown>>).a;
      expect(def.effort).toBe('low');
      expect(def.model).toBe('cheap');
      expect(def.description).toBe('a');
      expect(onDiagnostic).toHaveBeenCalledWith(expect.stringContaining('displayName'));
    });
  });

  describe('system prompt and directories', () => {
    it('appends systemMessage to the Claude Code preset', () => {
      const cfg = mapConfig(base({ systemMessage: 'be terse' }));
      expect(cfg.options.systemPrompt).toEqual({
        type: 'preset',
        preset: 'claude_code',
        append: 'be terse',
      });
    });

    it('one-shot uses the raw system prompt instead of the preset', () => {
      const cfg = mapConfig(base({ systemMessage: 'you are an advisor' }), { oneShot: true });
      expect(cfg.options.systemPrompt).toBe('you are an advisor');
      expect(cfg.options.tools).toEqual([]);
      expect(cfg.options.mcpServers).toEqual({});
      expect(cfg.options.settingSources).toEqual([]);
      expect(cfg.options.permissionMode).toBe('dontAsk');
    });

    it('resolves addDirs to absolute paths and dedupes', () => {
      const cfg = mapConfig(base({ addDirs: ['sub', '/abs/other', 'sub', ''] }));
      expect(cfg.options.additionalDirectories).toEqual(['/workspace/sub', '/abs/other']);
    });
  });

  describe('MCP conversion', () => {
    it('converts stdio servers and resolves ${A|B} env references', () => {
      vi.stubEnv('CONDUKT_MCP_TOKEN', 'secret');
      const servers: Record<string, MCPServerConfig> = {
        s: {
          command: 'npx',
          args: ['server'],
          env: { TOKEN: '${CONDUKT_MCP_MISSING|CONDUKT_MCP_TOKEN}' },
          tools: ['search'],
          timeout: 5000,
        },
      };
      const conversion = toClaudeMcpServers(servers);
      expect(conversion.servers?.s).toMatchObject({
        type: 'stdio',
        command: 'npx',
        args: ['server'],
        env: { TOKEN: 'secret' },
        tools: [{ name: 'search', permission_policy: 'always_allow' }],
        timeout: 5000,
      });
      expect(conversion.allowedTools).toEqual(['mcp__s__search']);
    });

    it('converts http servers and resolves embedded header references', () => {
      vi.stubEnv('CONDUKT_MCP_HEADER', 'abc');
      const conversion = toClaudeMcpServers({
        remote: {
          type: 'http',
          url: 'https://example.test/mcp',
          headers: { Authorization: 'Bearer ${CONDUKT_MCP_HEADER}' },
        },
      });
      expect(conversion.servers?.remote).toEqual({
        type: 'http',
        url: 'https://example.test/mcp',
        headers: { Authorization: 'Bearer abc' },
      });
    });

    it('tools: [] removes the server; tools: ["*"] adds none', () => {
      const off = toClaudeMcpServers({ s: { command: 'x', tools: [] } });
      expect(off.servers).toBeUndefined();
      const all = toClaudeMcpServers({ s: { command: 'x', tools: ['*'] } });
      expect(all.servers?.s).not.toHaveProperty('tools');
      expect(all.allowedTools).toEqual([]);
    });

    it('reports stdio working directories the SDK cannot express', () => {
      const onDiagnostic = vi.fn();
      const conversion = toClaudeMcpServers(
        { s: { command: 'x' } },
        { workingDirectory: '/w', onDiagnostic },
      );
      expect(conversion.servers?.s).toMatchObject({ type: 'stdio', command: 'x' });
      expect(onDiagnostic).toHaveBeenCalledWith(expect.stringContaining('working direct'));
    });

    it('mcpServers:false disables configuration-provided and host servers', () => {
      const cfg = mapConfig(base({ mcpServers: false }));
      expect(cfg.options.mcpServers).toEqual({});
      expect(cfg.options.strictMcpConfig).toBe(true);
    });
  });

  describe('runtime env', () => {
    it('maps thinkingBudget to effort (1:1)', () => {
      const cfg = mapConfig(base({ thinkingBudget: 'xhigh' }));
      expect(cfg.options.effort).toBe('xhigh');
      expect(mapConfig(base()).options.effort).toBeUndefined();
    });

    it('merges bridge env over process.env (SDK replaces child env)', () => {
      const cfg = mapConfig(base(), {
        env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234', ANTHROPIC_API_KEY: 'fake' },
      });
      expect(cfg.options.env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:1234');
      expect(cfg.options.env?.ANTHROPIC_API_KEY).toBe('fake');
      // PATH preserved from process.env so the CLI can still spawn.
      expect(cfg.options.env?.PATH).toBe(process.env.PATH);
      expect(mapConfig(base()).options.env).toBeUndefined();
    });

    it('maps tier models to ANTHROPIC_DEFAULT_* env vars (no defaults shipped)', () => {
      const cfg = mapConfig(base({
        claude: { tierModels: { opus: 'deepseek-v4-pro', sonnet: 'gpt-6-luna' } },
      }));
      expect(cfg.options.env?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('deepseek-v4-pro');
      expect(cfg.options.env?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-6-luna');
      expect(cfg.options.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
    });

    it('maps autoCompact window to SDK settings and pct/context to env', () => {
      const cfg = mapConfig(base({
        claude: { autoCompact: { window: 200000, pctOverride: 80, maxContextTokens: 210000 } },
      }));
      expect(cfg.options.settings).toEqual({ autoCompactWindow: 200000 });
      expect(cfg.options.env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('80');
      expect(cfg.options.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('210000');
      expect(cfg.options.env?.PATH).toBe(process.env.PATH);
    });

    it('caller env wins over claude env defaults', () => {
      const cfg = mapConfig(
        base({ claude: { autoCompact: { maxContextTokens: 1 } } }),
        { env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '42' } },
      );
      expect(cfg.options.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('42');
    });

    it('session-level epoch config does not leak into CLI options', () => {
      const cfg = mapConfig(base({ claude: { epoch: { enabled: false } } }));
      expect(cfg.options.env).toBeUndefined();
      expect(cfg.options.settings).toBeUndefined();
    });
  });
});
