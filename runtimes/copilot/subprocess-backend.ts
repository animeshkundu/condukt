import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import type { ChildProcess } from 'child_process';
import type { CopilotBackend, CopilotSession, SessionConfig, UsageData, ContentBlock, PermissionInfo } from './copilot-backend';
import { killProcessTree } from './process-killer';

type CommandFactory = (config: SessionConfig) => readonly [string, readonly string[]];

/**
 * Dynamically resolve directories for tools that agents need on PATH.
 * Uses `where` (Windows) or `which` to find each tool, then extracts
 * the directory. Cached after first call — tool locations don't change
 * within a server session.
 */
// Generic tools every agent subprocess needs for basic operation.
// Domain-specific tools (az, dotnet, etc.) are passed via pathTools option.
const GENERIC_PATH_TOOLS = ['cmd', 'pwsh', 'powershell', 'git', 'node', 'npm'];

let _cachedToolDirs: Map<string, string[]> = new Map();
function resolveToolDirs(tools: readonly string[]): string[] {
  const key = tools.join(',');
  if (_cachedToolDirs.has(key)) return _cachedToolDirs.get(key)!;

  const locate = process.platform === 'win32' ? 'where' : 'which';
  const dirs = new Set<string>();

  for (const tool of tools) {
    try {
      const result = cp.spawnSync(locate, [tool], { stdio: 'pipe', encoding: 'utf-8', timeout: 3000 });
      if (result.status === 0 && result.stdout) {
        const toolPath = result.stdout.trim().split(/\r?\n/)[0];
        if (toolPath) dirs.add(path.dirname(toolPath));
      }
    } catch {
      // Tool not installed — skip
    }
  }

  const resolved = [...dirs];
  _cachedToolDirs.set(key, resolved);
  return resolved;
}

export interface SubprocessBackendOptions {
  commandFactory?: CommandFactory;
  /** Extra directories to add to PATH (e.g. .tools/bin, Kusto CLI). */
  extraPathDirs?: readonly string[];
  /** Additional tool names to resolve and add to PATH (e.g. ['az', 'dotnet']). */
  pathTools?: readonly string[];
  /** Path to MCP config file. If provided and exists, passed via --additional-mcp-config. */
  mcpConfigPath?: string;
}

/**
 * Resolve the absolute path to the copilot CLI binary.
 * Priority: COPILOT_PATH env var > WinGet Links > PATH resolution.
 * Cached after first call.
 */
let _cachedCopilotPath: string | null = null;
function resolveCopilotPath(): string {
  if (_cachedCopilotPath) return _cachedCopilotPath;

  // 1. Explicit env var override
  if (process.env.COPILOT_PATH) {
    _cachedCopilotPath = process.env.COPILOT_PATH;
    return _cachedCopilotPath;
  }

  // 2. Check the WinGet links directory (where winget installs copilot on Windows)
  if (process.platform === 'win32') {
    const wingetPath = path.join(
      process.env.LOCALAPPDATA ?? '',
      'Microsoft', 'WinGet', 'Links', 'copilot.exe'
    );
    if (fs.existsSync(wingetPath)) {
      _cachedCopilotPath = wingetPath;
      return _cachedCopilotPath;
    }
  }

  // 3. Fall back to bare 'copilot' (PATH resolution by the OS)
  _cachedCopilotPath = 'copilot';
  return _cachedCopilotPath;
}

/**
 * Default command factory: spawns `copilot` CLI with the configured model.
 */
function createDefaultCommandFactory(options: SubprocessBackendOptions): CommandFactory {
  return (config: SessionConfig): readonly [string, readonly string[]] => {
    const args: string[] = [
      '--model', config.model,
      '--output-format', 'json',
      '--allow-all',          // Auto-approve all tool permissions (file, bash, URLs)
      '--no-ask-user',        // Agent works autonomously, never asks the user questions
      '--autopilot',          // Multi-turn: agent keeps working until task is complete
      '--experimental',       // Enable experimental features (extended thinking, etc.)
      '--no-alt-screen',      // Don't use alternate screen buffer (we capture stdout)
    ];

    if (config.addDirs.length === 0) {
      // Isolation mode: no extra directories
    } else {
      for (const dir of config.addDirs) {
        args.push('--add-dir', dir);
      }
    }

    // Load MCP config if provided and exists
    if (options.mcpConfigPath && fs.existsSync(options.mcpConfigPath)) {
      args.push('--additional-mcp-config', `@${options.mcpConfigPath}`);
    }

    const copilotPath = resolveCopilotPath();
    return [copilotPath, args] as const;
  };
}

/**
 * CopilotBackend implementation using child_process.spawn.
 * Spawns the copilot CLI as a subprocess and communicates via stdin/stdout.
 */
export class SubprocessBackend implements CopilotBackend {
  readonly name = 'subprocess';
  private readonly commandFactory: CommandFactory;
  private readonly extraPathDirs: readonly string[];
  private readonly pathTools: readonly string[];

  constructor(options: SubprocessBackendOptions = {}) {
    this.commandFactory = options.commandFactory ?? createDefaultCommandFactory(options);
    this.extraPathDirs = options.extraPathDirs ?? [];
    this.pathTools = options.pathTools ?? [];
  }

  async isAvailable(): Promise<boolean> {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = cp.spawnSync(cmd, ['copilot'], { stdio: 'pipe' });
    return result.status === 0;
  }

  async createSession(config: SessionConfig): Promise<CopilotSession> {
    return new SubprocessSession(config, this.commandFactory, this.extraPathDirs, this.pathTools);
  }
}

type EventHandler =
  | { event: 'text'; handler: (text: string) => void }
  | { event: 'reasoning'; handler: (text: string) => void }
  | { event: 'tool_start'; handler: (tool: string, input: string, args: Record<string, unknown>) => void }
  | { event: 'tool_complete'; handler: (tool: string, output: string) => void }
  | { event: 'tool_output'; handler: (tool: string, output: string) => void }
  | { event: 'idle'; handler: () => void }
  | { event: 'error'; handler: (err: Error) => void };

/** Extract human-readable summary from tool arguments object. */
function extractArgSummary(args: Record<string, unknown>): string {
  for (const key of ['description', 'intent', 'summary', 'command', 'query',
                      'path', 'pattern', 'glob', 'url', 'file_text']) {
    const val = args[key];
    if (typeof val === 'string' && val.length > 0) return val;
  }
  const firstStr = Object.values(args).find(v => typeof v === 'string' && (v as string).length > 0);
  if (typeof firstStr === 'string') return firstStr;
  return '';
}

class SubprocessSession implements CopilotSession {
  private child: ChildProcess | null = null;
  private handlers: EventHandler[] = [];
  private readonly config: SessionConfig;
  private readonly commandFactory: CommandFactory;
  private readonly extraPathDirs: readonly string[];
  private readonly pathTools: readonly string[];
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private aborted = false;
  private _toolCallNames = new Map<string, string>();
  private _pendingPartials = new Map<string, string[]>();

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  constructor(config: SessionConfig, commandFactory: CommandFactory, extraPathDirs: readonly string[], pathTools: readonly string[]) {
    this.config = config;
    this.commandFactory = commandFactory;
    this.extraPathDirs = extraPathDirs;
    this.pathTools = pathTools;
  }

  send(prompt: string): void {
    const [cmd, args] = this.commandFactory(this.config);

    // Strip NODE_OPTIONS from environment to prevent --no-warnings
    // (and other Node flags) from leaking into the copilot CLI subprocess
    const env = { ...process.env };
    delete env.NODE_OPTIONS;

    // Build PATH with extra directories
    const pathSep = process.platform === 'win32' ? ';' : ':';
    const extraPaths = [...this.extraPathDirs];

    // Ensure all required executables are on PATH.
    // PATH can get lost or rewritten in deep subprocess chains
    // (Node.js → copilot CLI → agent → bash → tool).
    // Detect each tool's directory dynamically via the OS locate command.
    // Resolve generic tools + composition-specific tools
    for (const dir of resolveToolDirs([...GENERIC_PATH_TOOLS, ...this.pathTools])) {
      if (!env.PATH?.includes(dir)) extraPaths.push(dir);
    }

    env.PATH = `${env.PATH ?? ''}${pathSep}${extraPaths.join(pathSep)}`;

    this.child = spawn(cmd, [...args], {
      cwd: this.config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    // Write prompt to stdin and close it
    if (this.child.stdin) {
      this.child.stdin.write(prompt);
      this.child.stdin.end();
    }

    // Set up hard timeout
    this.timeoutTimer = setTimeout(() => {
      this.emitError(new Error(`Session timed out after ${this.config.timeout}s`));
      this.abort();
    }, this.config.timeout * 1000);

    // Set up heartbeat timeout
    this.resetHeartbeat();

    // Stream stdout LINE BY LINE using readline, parsing JSONL events.
    // (raw 'data' events split at arbitrary byte boundaries, breaking words mid-line)
    if (this.child.stdout) {
      const rl = createInterface({ input: this.child.stdout });
      rl.on('line', (line: string) => {
        this.resetHeartbeat();

        if (line.trim() === '') return;

        let parsed: Record<string, unknown> | null = null;
        try {
          if (line.startsWith('{')) {
            parsed = JSON.parse(line);
          }
        } catch {
          // Not valid JSON — fall through to text
        }

        if (parsed && typeof parsed.type === 'string') {
          switch (parsed.type) {
            // --- Agent text response ---
            case 'assistant.message': {
              const data = parsed.data as Record<string, unknown> | undefined;
              const content = typeof data?.content === 'string' ? data.content : '';
              if (content) this.emit('text', content);
              // Pre-seed _toolCallNames from tool requests so tool.execution_complete
              // can resolve names even if tool.execution_start lacks a toolCallId.
              // Do NOT emit tool_start here — tool.execution_start handles that.
              const toolRequests = Array.isArray(data?.toolRequests) ? data.toolRequests : [];
              for (const req of toolRequests) {
                const r = req as Record<string, unknown>;
                const name = String(r.name ?? '');
                const callId = String(r.toolCallId ?? '');
                if (callId && name) this._toolCallNames.set(callId, name);
              }
              break;
            }
            case 'assistant.message_delta':
              this.emit('text', String(parsed.content ?? ''));
              break;

            // --- Reasoning ---
            case 'assistant.reasoning': {
              const data = parsed.data as Record<string, unknown> | undefined;
              const content = typeof data?.content === 'string' ? data.content : '';
              if (content) this.emit('reasoning', content);
              break;
            }
            case 'assistant.reasoning_delta':
              if (parsed.content) this.emit('reasoning', String(parsed.content));
              break;

            // --- Tool execution ---
            case 'tool.execution_start': {
              const data = parsed.data as Record<string, unknown> | undefined;
              const toolName = String(data?.toolName ?? '');
              const args = data?.arguments as Record<string, unknown> | undefined;
              const summary = args ? extractArgSummary(args) : '';
              // Track toolCallId → toolName for completion matching
              const callId = String(data?.toolCallId ?? '');
              if (callId && toolName) {
                this._toolCallNames.set(callId, toolName);
                // Flush any partials that arrived before this start event
                const buffered = this._pendingPartials.get(callId);
                if (buffered) {
                  for (const p of buffered) this.emit('tool_output', toolName, p);
                  this._pendingPartials.delete(callId);
                }
              }
              if (toolName) this.emit('tool_start', toolName, summary, args ?? {});
              break;
            }
            case 'tool.execution_complete': {
              const data = parsed.data as Record<string, unknown> | undefined;
              const callId = String(data?.toolCallId ?? '');
              let toolName = String(data?.toolName ?? '');
              // Resolve tool name from start event if not in completion
              if (!toolName && callId) toolName = this._toolCallNames.get(callId) ?? '';
              this._toolCallNames.delete(callId);
              const result = data?.result as Record<string, unknown> | undefined;
              const output = typeof result?.content === 'string'
                ? result.content
                : typeof result?.detailedContent === 'string'
                  ? result.detailedContent : '';
              this.emit('tool_complete', toolName, output);
              break;
            }
            case 'tool.execution_partial_result': {
              const data = parsed.data as Record<string, unknown> | undefined;
              const partial = typeof data?.partialOutput === 'string' ? data.partialOutput : '';
              if (!partial) break;
              const callId = String(data?.toolCallId ?? '');
              const toolName = (callId && this._toolCallNames.get(callId)) || '';
              if (toolName) {
                this.emit('tool_output', toolName, partial);
              } else if (callId) {
                // Buffer until tool.execution_start arrives with this callId
                const buf = this._pendingPartials.get(callId) ?? [];
                buf.push(partial);
                this._pendingPartials.set(callId, buf);
              } else {
                // No callId at all — truly unattributable output
                this.emit('text', partial);
              }
              break;
            }
            // Legacy tool event formats
            case 'assistant.tool_start':
              this.emit('tool_start', String(parsed.tool ?? ''), String(parsed.input ?? ''), {});
              break;
            case 'assistant.tool_complete':
              this.emit('tool_complete', String(parsed.tool ?? ''), String(parsed.output ?? ''));
              break;

            // --- Subagent lifecycle (mapped to tool events) ---
            case 'subagent.started': {
              const data = parsed.data as Record<string, unknown> | undefined;
              const name = String(data?.agentDisplayName ?? data?.agentName ?? 'agent');
              this.emit('tool_start', `subagent:${name}`, '', {});
              break;
            }
            case 'subagent.completed': {
              const data = parsed.data as Record<string, unknown> | undefined;
              const name = String(data?.agentDisplayName ?? data?.agentName ?? 'agent');
              this.emit('tool_complete', `subagent:${name}`, '');
              break;
            }

            // --- Lifecycle events (silently consumed) ---
            case 'user.message':
            case 'assistant.turn_start':
            case 'assistant.turn_end':
            case 'session.info':
            case 'result':
              break;

            default:
              this.emit('text', line);
          }
        } else {
          // Non-JSON lines: filter internal CLI markers
          if (line.includes('__BEGIN___COMMAND_DONE_MARKER') || line.includes('__END___COMMAND_DONE_MARKER')) return;
          this.emit('text', line);
        }
      });
    }

    // Stream stderr line by line, filtering known noise
    if (this.child.stderr) {
      const rlErr = createInterface({ input: this.child.stderr });
      rlErr.on('line', (line: string) => {
        this.resetHeartbeat();
        // Filter out Node.js --no-warnings noise that leaks from the parent
        // environment. These are not real errors from copilot.
        if (line.includes("unknown option '--no-warnings'") ||
            line.includes("Try 'copilot --help' for more information")) {
          return; // Swallow silently -- not actionable, not from copilot
        }
        // Skip empty stderr lines (copilot emits blank lines on stderr between warnings)
        if (line.trim() === '') return;
        this.emit('text', `[stderr] ${line}`);
      });
    }

    // Process exit
    this.child.on('close', (code) => {
      this.clearTimers();
      if (this.aborted) return;

      if (code === 0 || code === null) {
        this.emit('idle');
      } else {
        this.emitError(new Error(`Process exited with code ${code}`));
      }
    });

    this.child.on('error', (err) => {
      this.clearTimers();
      if (!this.aborted) {
        this.emitError(err);
      }
    });
  }

  // Overloads match CopilotSession interface exactly.
  on(event: 'text', handler: (text: string) => void): void;
  on(event: 'tool_start', handler: (tool: string, input: string, args: Record<string, unknown>, callId?: string) => void): void;
  on(event: 'tool_complete', handler: (tool: string, output: string, callId?: string) => void): void;
  on(event: 'tool_output', handler: (tool: string, output: string) => void): void;
  on(event: 'idle', handler: () => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
  on(event: 'reasoning', handler: (text: string) => void): void;
  // Rich events: accepted but never fired by SubprocessBackend.
  on(event: 'intent', handler: (intent: string) => void): void;
  on(event: 'usage', handler: (data: UsageData) => void): void;
  on(event: 'tool_complete_rich', handler: (tool: string, contents: ReadonlyArray<ContentBlock>, callId?: string) => void): void;
  on(event: 'subagent_start', handler: (name: string, data: Record<string, unknown>) => void): void;
  on(event: 'subagent_end', handler: (name: string, data: Record<string, unknown>) => void): void;
  on(event: 'permission', handler: (data: PermissionInfo) => void): void;
  on(event: string, handler: (...args: never[]) => void): void {
    this.handlers.push({ event, handler } as EventHandler);
  }

  async abort(): Promise<void> {
    if (this.aborted) return; // Prevent double-abort
    this.clearTimers();
    this.emitError(new Error('Session aborted')); // Resolve step-executor Promise FIRST
    this.aborted = true; // THEN mark as aborted so close handler skips

    if (this.child) {
      // Try to kill via Node first
      try {
        this.child.kill('SIGKILL');
      } catch {
        // May fail if already dead
      }
      // Then use platform-specific tree kill for any child processes
      if (this.child.pid) {
        await killProcessTree(this.child.pid);
      }
    }
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const h of this.handlers) {
      if (h.event === event) {
        (h.handler as (...a: unknown[]) => void)(...args);
      }
    }
  }

  private emitError(err: Error): void {
    this.emit('error', err);
  }

  private resetHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
    }
    this.heartbeatTimer = setTimeout(() => {
      this.emitError(new Error(`No output for ${this.config.heartbeatTimeout}s (heartbeat timeout)`));
      this.abort();
    }, this.config.heartbeatTimeout * 1000);
  }

  private clearTimers(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
