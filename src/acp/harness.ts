import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { nanoid } from 'nanoid';
import { MsgStore } from '../streaming/msg-store.js';
import { type AcpEvent, parseAcpLine } from './types.js';
import { TypedEventEmitter, createDeferred } from '../streaming/event-emitter.js';
import { ProtocolPeer } from './protocol-peer.js';
import { ApprovalService } from './approval-service.js';
import type { PermissionMode, ApprovalRequest } from './control-protocol.js';

/**
 * Events emitted by the ACP harness
 */
export interface HarnessEvents {
  event: (event: AcpEvent) => void;
  sessionId: (sessionId: string) => void;
  stdout: (data: string) => void;
  stderr: (data: string) => void;
  exit: (code: number | null, signal: NodeJS.Signals | null) => void;
  error: (error: Error) => void;
  approvalRequest: (request: ApprovalRequest) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: (...args: any[]) => void;
}

/**
 * Options for spawning an agent process
 */
export interface SpawnOptions {
  /** Working directory for the process */
  cwd: string;

  /** Command to execute */
  command: string;

  /** Command arguments */
  args?: string[];

  /** Environment variables */
  env?: Record<string, string>;

  /** Initial prompt to send */
  prompt?: string;

  /** Session ID for follow-up (resume existing session) */
  sessionId?: string;

  /** Timeout for process startup in ms (default: 30000) */
  startupTimeout?: number;

  /** Use interactive mode with control protocol (enables approvals) */
  interactive?: boolean;

  /** Permission mode for interactive mode */
  permissionMode?: PermissionMode;

  /** Hooks configuration for interactive mode */
  hooks?: unknown;

  /** Approval service for interactive mode */
  approvalService?: ApprovalService;
}

/**
 * Result of spawning a process
 */
export interface SpawnedProcess {
  /** Unique ID for this process instance */
  id: string;

  /** Session ID (may be set after spawn) */
  sessionId: string | null;

  /** The underlying child process */
  process: ChildProcess;

  /** Message store for this process */
  msgStore: MsgStore;

  /** Event emitter for typed events */
  events: TypedEventEmitter<HarnessEvents>;

  /** Send input to the process stdin */
  sendInput: (input: string) => void;

  /** Interrupt the process (graceful stop) */
  interrupt: () => Promise<void>;

  /** Kill the process (force stop) */
  kill: () => Promise<void>;

  /** Wait for the process to exit */
  waitForExit: () => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  /** Async iterator for ACP events */
  [Symbol.asyncIterator]: () => AsyncGenerator<AcpEvent, void, undefined>;
}

/**
 * ACP Agent Harness - Spawns and manages agent processes
 *
 * TypeScript port of vibe-kanban's AcpAgentHarness. Handles:
 * - Process spawning with piped I/O
 * - ACP event parsing from stdout
 * - Message store integration
 * - Graceful shutdown
 */
export class AcpHarness {
  private sessionNamespace: string;
  private model?: string;
  private mode?: string;

  constructor(options: { sessionNamespace?: string; model?: string; mode?: string } = {}) {
    this.sessionNamespace = options.sessionNamespace || 'default_sessions';
    this.model = options.model;
    this.mode = options.mode;
  }

  /**
   * Spawn a new agent process
   */
  async spawn(options: SpawnOptions): Promise<SpawnedProcess> {
    const {
      cwd,
      command,
      args = [],
      env = {},
      prompt,
      sessionId,
      startupTimeout = 30000,
      interactive = false,
      permissionMode,
      hooks,
      approvalService,
    } = options;

    // Use interactive mode if requested
    if (interactive) {
      return this.spawnInteractive(options);
    }

    const id = nanoid();
    const msgStore = new MsgStore();
    const events = new TypedEventEmitter<HarnessEvents>();
    let currentSessionId: string | null = sessionId || null;

    // Merge environment
    const processEnv = {
      ...process.env,
      NODE_NO_WARNINGS: '1',
      ...env,
    };

    // Spawn the process
    // Use /usr/bin/env to properly resolve commands from PATH on Unix systems
    let actualCommand = command;
    let actualArgs = args;
    if (process.platform !== 'win32' && !command.startsWith('/')) {
      actualCommand = '/usr/bin/env';
      actualArgs = [command, ...args];
    }

    // Use 'ignore' for stdin as some CLIs (like claude-code) hang when stdin is piped
    // We don't need stdin for --print mode anyway
    const child = spawn(actualCommand, actualArgs, {
      cwd,
      env: processEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Create a promise that rejects on spawn error
    const spawnErrorPromise = new Promise<never>((_, reject) => {
      child.on('error', (error) => {
        events.emit('error', error);
        msgStore.pushStderr(`Process error: ${error.message}`);
        reject(error);
      });
    });

    // Give the spawn a moment to fail if it's going to
    // This catches immediate errors like ENOENT
    await Promise.race([
      new Promise<void>((resolve) => setTimeout(resolve, 100)),
      spawnErrorPromise,
    ]).catch((error) => {
      throw new Error(`Failed to spawn process: ${error.message}`);
    });

    // Process stdout - parse ACP events
    const stdoutRl = createInterface({
      input: child.stdout!,
      crlfDelay: Infinity,
    });

    stdoutRl.on('line', (line) => {
      // Push raw line to stdout
      msgStore.pushStdout(line);
      events.emit('stdout', line);

      // Try to parse as ACP event
      const acpEvent = parseAcpLine(line);
      if (acpEvent) {
        events.emit('event', acpEvent);

        // Handle session ID
        if (acpEvent.type === 'sessionStart') {
          currentSessionId = acpEvent.sessionId;
          events.emit('sessionId', acpEvent.sessionId);
          msgStore.pushSessionId(acpEvent.sessionId);
        }
      }
    });

    // Process stderr
    const stderrRl = createInterface({
      input: child.stderr!,
      crlfDelay: Infinity,
    });

    stderrRl.on('line', (line) => {
      msgStore.pushStderr(line);
      events.emit('stderr', line);
    });

    // Handle process exit
    const exitDeferred = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();

    child.on('exit', (code, signal) => {
      msgStore.pushFinished();
      events.emit('exit', code, signal);
      exitDeferred.resolve({ code, signal });
    });

    // Note: prompt is passed via command line args, not stdin
    // stdin is ignored in print mode

    // Wait for process to be ready (or timeout)
    const readyPromise = new Promise<void>((resolve) => {
      // Consider ready once we get any stdout
      const handler = () => {
        events.off('stdout', handler);
        resolve();
      };
      events.on('stdout', handler);

      // Also resolve immediately if process is already running
      setTimeout(resolve, 100);
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Process startup timeout')), startupTimeout);
    });

    try {
      await Promise.race([readyPromise, timeoutPromise]);
    } catch (error) {
      child.kill();
      throw error;
    }

    // Create the spawned process interface
    const spawnedProcess: SpawnedProcess = {
      id,
      get sessionId() {
        return currentSessionId;
      },
      process: child,
      msgStore,
      events,

      sendInput(_input: string) {
        // stdin is ignored in print mode - follow-ups should spawn a new process
        throw new Error('sendInput not supported in print mode - use spawnFollowUp instead');
      },

      async interrupt() {
        // Send interrupt signal (SIGINT)
        child.kill('SIGINT');

        // Wait up to 5 seconds for graceful exit
        const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));
        const exit = exitDeferred.promise.then(() => {});

        await Promise.race([exit, timeout]);

        // Force kill if still running
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      },

      async kill() {
        child.kill('SIGKILL');
        await exitDeferred.promise;
      },

      waitForExit() {
        return exitDeferred.promise;
      },

      async *[Symbol.asyncIterator]() {
        const queue: AcpEvent[] = [];
        let resolve: (() => void) | null = null;
        let done = false;

        const eventHandler = (event: AcpEvent) => {
          queue.push(event);
          if (resolve) {
            resolve();
            resolve = null;
          }
        };

        const exitHandler = () => {
          done = true;
          if (resolve) {
            resolve();
            resolve = null;
          }
        };

        events.on('event', eventHandler);
        events.on('exit', exitHandler);

        try {
          while (!done || queue.length > 0) {
            if (queue.length > 0) {
              yield queue.shift()!;
            } else if (!done) {
              await new Promise<void>((r) => {
                resolve = r;
              });
            }
          }
        } finally {
          events.off('event', eventHandler);
          events.off('exit', exitHandler);
        }
      },
    };

    return spawnedProcess;
  }

  /**
   * Spawn a follow-up process (resume existing session)
   */
  async spawnFollowUp(
    options: Omit<SpawnOptions, 'sessionId'> & { sessionId: string }
  ): Promise<SpawnedProcess> {
    return this.spawn(options);
  }

  /**
   * Spawn a process in interactive mode with control protocol
   * This enables bidirectional communication for approvals
   */
  private async spawnInteractive(options: SpawnOptions): Promise<SpawnedProcess> {
    const {
      cwd,
      command,
      args = [],
      env = {},
      prompt,
      sessionId,
      startupTimeout = 30000,
      permissionMode = 'default',
      hooks,
      approvalService = new ApprovalService(),
    } = options;

    const id = nanoid();
    const msgStore = new MsgStore();
    const events = new TypedEventEmitter<HarnessEvents>();
    let currentSessionId: string | null = sessionId || null;

    // Merge environment
    const processEnv = {
      ...process.env,
      NODE_NO_WARNINGS: '1',
      ...env,
    };

    // Spawn the process with piped stdin for bidirectional communication
    let actualCommand = command;
    let actualArgs = args;
    if (process.platform !== 'win32' && !command.startsWith('/')) {
      actualCommand = '/usr/bin/env';
      actualArgs = [command, ...args];
    }

    // Use piped stdin for interactive mode
    const child = spawn(actualCommand, actualArgs, {
      cwd,
      env: processEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Create a promise that rejects on spawn error
    const spawnErrorPromise = new Promise<never>((_, reject) => {
      child.on('error', (error) => {
        events.emit('error', error);
        msgStore.pushStderr(`Process error: ${error.message}`);
        reject(error);
      });
    });

    // Give the spawn a moment to fail if it's going to
    await Promise.race([
      new Promise<void>((resolve) => setTimeout(resolve, 100)),
      spawnErrorPromise,
    ]).catch((error) => {
      throw new Error(`Failed to spawn process: ${error.message}`);
    });

    // Create protocol peer for bidirectional communication
    const protocolPeer = new ProtocolPeer({
      stdin: child.stdin!,
      stdout: child.stdout!,
      stderr: child.stderr!,
      msgStore,
      approvalService,
      autoApprove: false,
      permissionMode,
      hooks,
    });

    // Forward events from protocol peer
    protocolPeer.on('event', (event) => {
      events.emit('event', event);
    });

    protocolPeer.on('sessionId', (sessId) => {
      currentSessionId = sessId;
      events.emit('sessionId', sessId);
    });

    protocolPeer.on('stdout', (data) => {
      events.emit('stdout', data);
    });

    protocolPeer.on('stderr', (data) => {
      events.emit('stderr', data);
    });

    // Forward approval requests
    approvalService.on('approvalRequest', (request) => {
      events.emit('approvalRequest', request);
    });

    // Handle process exit
    const exitDeferred = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();

    child.on('exit', (code, signal) => {
      msgStore.pushFinished();
      approvalService.cancelAll('Process exited');
      events.emit('exit', code, signal);
      exitDeferred.resolve({ code, signal });
    });

    // Wait for process to be ready (give it some time to start up)
    const readyPromise = new Promise<void>((resolve) => {
      // Give the process time to initialize
      setTimeout(resolve, 500);
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Process startup timeout')), startupTimeout);
    });

    try {
      await Promise.race([readyPromise, timeoutPromise]);
    } catch (error) {
      child.kill();
      throw error;
    }

    // Initialize the control protocol with proper sequencing
    // This must happen before sending any user messages
    // permissionMode 'default' enables approval flow
    await protocolPeer.initializeProtocol({
      hooks,
      permissionMode: permissionMode === 'bypassPermissions' ? 'default' : permissionMode,
    });

    // Send initial user message if prompt provided
    if (prompt) {
      await protocolPeer.sendUserMessage(prompt);
    }

    // Create the spawned process interface
    const spawnedProcess: SpawnedProcess = {
      id,
      get sessionId() {
        return currentSessionId;
      },
      process: child,
      msgStore,
      events,

      sendInput(input: string) {
        // In interactive mode, we can send input via the protocol peer
        // Re-set permission mode before each message to ensure approvals work after interrupts
        const sendWithPermissionMode = async () => {
          await protocolPeer.setPermissionMode('default');
          // Small delay to ensure Claude processes the permission mode change
          await new Promise((resolve) => setTimeout(resolve, 50));
          await protocolPeer.sendUserMessage(input);
        };
        sendWithPermissionMode().catch((e) => {
          events.emit('error', new Error(`Failed to send input: ${e.message}`));
        });
      },

      async interrupt() {
        // In interactive mode, interrupt just stops the current task
        // The process stays alive to accept follow-up messages
        try {
          await protocolPeer.interrupt();
        } catch {
          // Fall back to SIGINT (this stops the current task, not the process)
          child.kill('SIGINT');
        }
        // Don't wait for exit or kill - keep process alive for follow-ups
      },

      async kill() {
        child.kill('SIGKILL');
        await exitDeferred.promise;
      },

      waitForExit() {
        return exitDeferred.promise;
      },

      async *[Symbol.asyncIterator]() {
        const queue: AcpEvent[] = [];
        let resolve: (() => void) | null = null;
        let done = false;

        const eventHandler = (event: AcpEvent) => {
          queue.push(event);
          if (resolve) {
            resolve();
            resolve = null;
          }
        };

        const exitHandler = () => {
          done = true;
          if (resolve) {
            resolve();
            resolve = null;
          }
        };

        events.on('event', eventHandler);
        events.on('exit', exitHandler);

        try {
          while (!done || queue.length > 0) {
            if (queue.length > 0) {
              yield queue.shift()!;
            } else if (!done) {
              await new Promise<void>((r) => {
                resolve = r;
              });
            }
          }
        } finally {
          events.off('event', eventHandler);
          events.off('exit', exitHandler);
        }
      },
    };

    return spawnedProcess;
  }
}

/**
 * Create a new ACP harness instance
 */
export function createHarness(
  options: { sessionNamespace?: string; model?: string; mode?: string } = {}
): AcpHarness {
  return new AcpHarness(options);
}
