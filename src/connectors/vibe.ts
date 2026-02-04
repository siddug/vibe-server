import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { nanoid } from 'nanoid';
import {
  AbstractConnector,
  type AvailabilityInfo,
  type ConnectorConfig,
  type SpawnOptions,
  type SpawnedSession,
  type SessionEvents,
  commandExists,
  getCommandVersion,
} from './base.js';
import { MsgStore } from '../streaming/msg-store.js';
import { ApprovalService } from '../acp/approval-service.js';
import { TypedEventEmitter, createDeferred } from '../streaming/event-emitter.js';
import { VibeProtocolPeer, type ConversationMessage } from '../acp/vibe-protocol-peer.js';
import type { AcpEvent } from '../acp/types.js';

/**
 * Mistral Vibe specific configuration
 */
export interface VibeConnectorConfig extends ConnectorConfig {
  /** Use auto-approve mode (bypasses tool confirmations) */
  autoApprove?: boolean;

  /** Enable interactive approval flow for tool calls */
  enableApprovals?: boolean;
}

/**
 * Mistral Vibe Connector
 *
 * Implements the BaseConnector interface for Mistral Vibe (Mistral's CLI agent).
 * Spawns vibe-acp and manages the ACP communication using JSON-RPC 2.0 protocol.
 */
export class VibeConnector extends AbstractConnector {
  readonly name = 'vibe';
  readonly displayName = 'Mistral Vibe';

  private vibeConfig: VibeConnectorConfig;

  /** Store conversation history by agent session ID for context preservation */
  private sessionHistories: Map<string, ConversationMessage[]> = new Map();

  /** Track active protocol peers by our session ID for history extraction */
  private activePeers: Map<string, VibeProtocolPeer> = new Map();

  constructor(config: VibeConnectorConfig = {}) {
    super(config);
    this.vibeConfig = config;
  }

  async checkAvailability(): Promise<AvailabilityInfo> {
    // Check if vibe-acp command exists
    if (!(await commandExists('vibe-acp'))) {
      // Try vibe command as fallback (older versions)
      if (!(await commandExists('vibe'))) {
        return {
          status: 'not_installed',
          message: 'Mistral Vibe is not installed. Install with: pip install mistral-vibe',
        };
      }
    }

    // Try to get version
    try {
      const version = await getCommandVersion('vibe', '--version');
      if (version) {
        return {
          status: 'available',
          version,
          path: 'vibe-acp',
        };
      }
    } catch {
      // Continue without version
    }

    // Check for API key
    const hasApiKey = !!process.env.MISTRAL_API_KEY || this.hasVibeConfig();
    if (!hasApiKey) {
      return {
        status: 'not_configured',
        message: 'MISTRAL_API_KEY environment variable not set',
        path: 'vibe-acp',
      };
    }

    return {
      status: 'available',
      message: 'Mistral Vibe is available',
      path: 'vibe-acp',
    };
  }

  async spawn(options: SpawnOptions): Promise<SpawnedSession> {
    const { workDir, prompt, env, startupTimeout = 30000, enableApprovals, agentMode } = options;

    const id = nanoid();
    const msgStore = new MsgStore();
    const events = new TypedEventEmitter<SessionEvents>();
    let currentSessionId: string | null = null;

    // Add default error handler to prevent unhandled 'error' events from crashing the process
    events.on('error', (error) => {
      console.error('[VibeConnector] Session error:', error.message);
      msgStore.pushStderr(`Error: ${error.message}`);
    });

    // Create approval service - default to enabling approvals like Claude
    const useApprovals = enableApprovals ?? this.vibeConfig.enableApprovals ?? true;
    const autoApprove = this.vibeConfig.autoApprove ?? false;
    // Always create approval service unless explicitly auto-approving
    const approvalService = autoApprove ? undefined : new ApprovalService();

    // Merge environment
    const processEnv = {
      ...process.env,
      ...this.config.env,
      ...env,
    };

    // Spawn vibe-acp process with agent flag if plan mode is requested
    // Vibe uses --agent flag to select different agent profiles at startup
    const command = this.vibeConfig.command || 'vibe-acp';
    let actualCommand = command;
    let actualArgs: string[] = [];

    // Add --agent flag for plan mode
    if (agentMode === 'plan') {
      actualArgs.push('--agent', 'plan');
    }

    if (process.platform !== 'win32' && !command.startsWith('/')) {
      actualCommand = '/usr/bin/env';
      actualArgs = [command, ...actualArgs];
    }

    const child = spawn(actualCommand, actualArgs, {
      cwd: workDir,
      env: processEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Create a promise that rejects on spawn error
    const spawnErrorPromise = new Promise<never>((_, reject) => {
      child.on('error', (error) => {
        console.log('[VibeConnector] Process error:', error.message);
        events.emit('error', error);
        msgStore.pushStderr(`Process error: ${error.message}`);
        reject(error);
      });
    });

    console.log('[VibeConnector] Spawned vibe-acp process, pid:', child.pid);

    // Give the spawn a moment to fail if it's going to
    await Promise.race([
      new Promise<void>((resolve) => setTimeout(resolve, 100)),
      spawnErrorPromise,
    ]).catch((error) => {
      throw new Error(`Failed to spawn process: ${error.message}`);
    });

    // Create protocol peer for Vibe's JSON-RPC protocol
    const protocolPeer = new VibeProtocolPeer({
      stdin: child.stdin!,
      stdout: child.stdout!,
      stderr: child.stderr!,
      msgStore,
      approvalService: approvalService || new ApprovalService(),
      cwd: workDir,
      autoApprove,
    });

    // Track the protocol peer for history extraction
    this.activePeers.set(id, protocolPeer);

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

    // Forward approval requests if approval service is provided
    if (approvalService) {
      approvalService.on('approvalRequest', (request) => {
        events.emit('approvalRequest', request);
      });
    }

    // Handle process exit
    const exitDeferred = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();

    // Track stdio close events
    child.stdout?.on('close', () => {
      console.log('[VibeConnector] stdout stream closed');
    });

    child.stdin?.on('close', () => {
      console.log('[VibeConnector] stdin stream closed');
    });

    child.stdin?.on('error', (err) => {
      console.log('[VibeConnector] stdin error:', err.message);
    });

    child.on('close', (code, signal) => {
      console.log('[VibeConnector] Process close event, code:', code, 'signal:', signal);
    });

    child.on('exit', (code, signal) => {
      console.log('[VibeConnector] Process exited, code:', code, 'signal:', signal);

      // Save conversation history for potential follow-ups
      if (currentSessionId) {
        const history = protocolPeer.getConversationHistory();
        if (history.length > 0) {
          console.log('[VibeConnector] Saving conversation history for session:', currentSessionId, 'messages:', history.length);
          this.sessionHistories.set(currentSessionId, history);
        }
      }

      // Clean up the active peer reference
      this.activePeers.delete(id);

      msgStore.pushFinished();
      if (approvalService) {
        approvalService.cancelAll('Process exited');
      }
      events.emit('exit', code, signal);
      exitDeferred.resolve({ code, signal });
    });

    // Initialize the ACP protocol
    try {
      await protocolPeer.initialize();
      await protocolPeer.newSession();

      // Set auto-approve mode if configured
      if (autoApprove) {
        await protocolPeer.setMode('auto_approve');
      }

      // Set plan mode if configured
      if (agentMode === 'plan') {
        await protocolPeer.setMode('plan');
      }

      // Send the initial prompt
      if (prompt) {
        // Don't await - let it run in the background
        protocolPeer.sendPrompt(prompt).catch((error) => {
          events.emit('error', new Error(`Failed to send prompt: ${error.message}`));
        });
      }
    } catch (error) {
      child.kill();
      throw new Error(`Failed to initialize Vibe session: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Create the spawned session interface
    const spawnedSession: SpawnedSession = {
      id,
      get agentSessionId() {
        return currentSessionId;
      },
      connectorType: this.name,
      process: child,
      msgStore,
      events,
      workDir,
      approvalService,

      sendInput(input: string) {
        console.log('[VibeConnector] sendInput called, input length:', input.length);
        protocolPeer.sendPrompt(input).catch((e) => {
          const errorMsg = e.message || 'Unknown error';
          console.error('[VibeConnector] sendInput error:', errorMsg);

          // Check if it's a concurrent prompt error - this is expected when sending follow-up too quickly
          if (errorMsg.includes('Concurrent prompts')) {
            msgStore.pushStderr('Please wait for the agent to finish before sending another message.');
          } else {
            msgStore.pushStderr(`Error: ${errorMsg}`);
          }

          // Emit error event for any listeners (we have a default handler now)
          events.emit('error', new Error(`Failed to send input: ${errorMsg}`));
        });
      },

      async interrupt() {
        try {
          await protocolPeer.cancel();
        } catch {
          // Fall back to SIGINT
          child.kill('SIGINT');
        }
      },

      async kill() {
        child.kill('SIGKILL');
        await exitDeferred.promise;
      },

      waitForExit() {
        return exitDeferred.promise;
      },

      async *[Symbol.asyncIterator](): AsyncGenerator<AcpEvent, void, undefined> {
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

    return spawnedSession;
  }

  async spawnFollowUp(
    options: SpawnOptions & { sessionId: string }
  ): Promise<SpawnedSession> {
    const { sessionId, prompt, ...restOptions } = options;

    // Vibe doesn't support native session resume, so we need to inject conversation history
    // into the new prompt to maintain context
    const previousHistory = this.sessionHistories.get(sessionId);

    if (previousHistory && previousHistory.length > 0) {
      console.log('[VibeConnector] spawnFollowUp with history, sessionId:', sessionId, 'history messages:', previousHistory.length);

      // Build a context-aware prompt that includes the conversation history
      const contextPrompt = this.buildContextAwarePrompt(previousHistory, prompt);

      // Spawn with the context-aware prompt
      return this.spawn({
        ...restOptions,
        prompt: contextPrompt,
      });
    }

    console.log('[VibeConnector] spawnFollowUp without history, sessionId:', sessionId);
    // No history available, just spawn with the original prompt
    return this.spawn(options);
  }

  /**
   * Build a prompt that includes conversation history for context
   */
  private buildContextAwarePrompt(history: ConversationMessage[], newPrompt: string): string {
    // Format the conversation history
    const historyText = history
      .map((msg) => {
        const role = msg.role === 'user' ? 'User' : 'Assistant';
        return `${role}: ${msg.content}`;
      })
      .join('\n\n');

    // Combine history with the new prompt
    return `Here is the previous conversation for context:

${historyText}

---

Now, please respond to this new message:
User: ${newPrompt}`;
  }

  /**
   * Clear stored conversation history for a session
   * Call this when you want to start fresh or to free memory
   */
  clearSessionHistory(sessionId: string): void {
    this.sessionHistories.delete(sessionId);
  }

  /**
   * Clear all stored conversation histories
   */
  clearAllHistories(): void {
    this.sessionHistories.clear();
  }

  getMcpConfigPath(): string | null {
    // Mistral Vibe uses ~/.vibe/config.toml
    const configPaths = [
      join(homedir(), '.vibe', 'config.toml'),
      join(process.cwd(), '.vibe', 'config.toml'),
    ];

    for (const path of configPaths) {
      if (existsSync(path)) {
        return path;
      }
    }

    return null;
  }

  getSetupInstructions(): string {
    return `
Mistral Vibe Setup Instructions:

1. Install Mistral Vibe:
   pip install mistral-vibe
   # or
   uv tool install mistral-vibe

2. Set your API key:
   export MISTRAL_API_KEY="your_key"

3. Verify installation:
   vibe --version

For more information, visit: https://github.com/mistralai/mistral-vibe
    `.trim();
  }

  /**
   * Check if vibe config exists with API key
   */
  private hasVibeConfig(): boolean {
    const envPath = join(homedir(), '.vibe', '.env');
    return existsSync(envPath);
  }
}

/**
 * Create a new Vibe connector
 */
export function createVibeConnector(
  config: VibeConnectorConfig = {}
): VibeConnector {
  return new VibeConnector(config);
}
