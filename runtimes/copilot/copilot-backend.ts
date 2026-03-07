/**
 * CopilotBackend interface -- the abstraction over how we talk to copilot CLI.
 *
 * Three implementations planned:
 * - SubprocessBackend: Proven, works today (child_process.spawn)
 * - AcpBackend: Structured events via ACP protocol (copilot --acp)
 * - SdkBackend: Future, when @github/copilot-sdk stabilizes
 *
 * The orchestrator depends on this interface, not on any implementation.
 */

export interface SessionConfig {
  /** Model to use: "claude-opus-4.6", "gpt-5.4", etc. */
  readonly model: string;
  /** Thinking budget level for extended thinking models */
  readonly thinkingBudget?: 'low' | 'medium' | 'high' | 'xhigh';
  /** Working directory for the agent (repo root) */
  readonly cwd: string;
  /** Additional directories the agent can access. [] = isolation (step 2a) */
  readonly addDirs: readonly string[];
  /** Hard timeout -- kill after this many seconds */
  readonly timeout: number;
  /** Heartbeat timeout -- kill if no output for this many seconds */
  readonly heartbeatTimeout: number;
}

export interface CopilotSession {
  /** Subprocess PID (if applicable) for kill operations */
  readonly pid: number | null;

  /** Send a prompt to the agent. Agent begins working. */
  send(prompt: string): void;

  /** Subscribe to streaming text output from the agent */
  on(event: 'text', handler: (text: string) => void): void;
  /** Subscribe to tool execution start (file read, bash, Kusto, etc.) */
  on(event: 'tool_start', handler: (tool: string, input: string) => void): void;
  /** Subscribe to tool execution completion */
  on(event: 'tool_complete', handler: (tool: string, output: string) => void): void;
  /** Agent finished all work */
  on(event: 'idle', handler: () => void): void;
  /** Agent encountered an error */
  on(event: 'error', handler: (err: Error) => void): void;
  /** Subscribe to reasoning/thinking token output from the agent */
  on(event: 'reasoning', handler: (text: string) => void): void;

  /** Abort the session -- kill the agent process */
  abort(): Promise<void>;
}

export interface CopilotBackend {
  /** Create a new agent session with the given configuration */
  createSession(config: SessionConfig): Promise<CopilotSession>;

  /** Check if copilot CLI is available */
  isAvailable(): Promise<boolean>;

  /** Get the backend type name (for logging) */
  readonly name: string;
}
