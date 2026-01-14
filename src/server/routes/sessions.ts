import type { FastifyPluginAsync } from 'fastify';
import type { SocketStream } from '@fastify/websocket';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { sessions, executionProcesses, processLogs, type SessionStatus } from '../../db/schema.js';
import type { ApprovalRequest, ApprovalResponse, ApprovalStatus } from '../../acp/control-protocol.js';

/**
 * Expand ~ to home directory
 */
function expandTilde(path: string): string {
  if (path.startsWith('~/')) {
    return path.replace('~', homedir());
  }
  if (path === '~') {
    return homedir();
  }
  return path;
}

/**
 * Request body schemas
 */
const createSessionSchema = z.object({
  connector: z.string().min(1),
  workDir: z.string().min(1),
  prompt: z.string().min(1),
  env: z.record(z.string()).optional(),
  enableApprovals: z.boolean().optional(),
});

const followUpSchema = z.object({
  prompt: z.string().min(1),
});

const approvalResponseSchema = z.object({
  requestId: z.string().min(1),
  status: z.enum(['approved', 'denied']),
  reason: z.string().optional(),
});

// Track current process ID for each active session (for log routing)
const sessionProcessMap = new Map<string, { currentProcessId: string }>();

/**
 * Sessions routes
 */
export const sessionsRoutes: FastifyPluginAsync = async (server) => {
  const { db, registry, sessions: activeSessions } = server.state;

  /**
   * GET /api/sessions
   * List all sessions
   */
  server.get('/sessions', async (_request, reply) => {
    const allSessions = db.db.select().from(sessions).all();

    return reply.send({
      sessions: allSessions,
      total: allSessions.length,
    });
  });

  /**
   * GET /api/sessions/:id
   * Get session details
   */
  server.get<{ Params: { id: string } }>('/sessions/:id', async (request, reply) => {
    const { id } = request.params;

    const session = db.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, id))
      .get();

    if (!session) {
      return reply.status(404).send({
        error: 'Session not found',
      });
    }

    // Get execution processes for this session
    const processes = db.db
      .select()
      .from(executionProcesses)
      .where(eq(executionProcesses.sessionId, id))
      .all();

    // Check if session is active
    const isActive = activeSessions.has(id);

    return reply.send({
      ...session,
      isActive,
      processes,
    });
  });

  /**
   * POST /api/sessions
   * Create a new session
   */
  server.post('/sessions', async (request, reply) => {
    const body = createSessionSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({
        error: 'Invalid request body',
        details: body.error.issues,
      });
    }

    const { connector: connectorName, workDir: rawWorkDir, prompt, env, enableApprovals } = body.data;
    const workDir = expandTilde(rawWorkDir);

    // Get the connector
    const connector = registry.get(connectorName);
    if (!connector) {
      return reply.status(400).send({
        error: `Unknown connector: ${connectorName}`,
        available: registry.names(),
      });
    }

    // Validate working directory exists
    if (!existsSync(workDir)) {
      return reply.status(400).send({
        error: `Working directory does not exist: ${workDir}`,
      });
    }

    // Check availability
    const availability = await connector.checkAvailability();
    if (availability.status !== 'available') {
      return reply.status(503).send({
        error: `Connector ${connectorName} is not available`,
        status: availability.status,
        message: availability.message,
        setupInstructions: connector.getSetupInstructions(),
      });
    }

    // Create session ID
    const sessionId = nanoid();
    const now = new Date();

    // Insert session record
    db.db.insert(sessions).values({
      id: sessionId,
      connectorType: connectorName,
      workDir,
      status: 'running' as SessionStatus,
      createdAt: now,
      updatedAt: now,
    }).run();

    try {
      // Spawn the session
      server.log.info({ workDir, prompt, enableApprovals }, 'Spawning session');
      const spawned = await connector.spawn({
        workDir,
        prompt,
        env,
        enableApprovals,
      });
      server.log.info({ sessionId, processId: spawned.id }, 'Session spawned');

      // Track the active session
      activeSessions.set(sessionId, spawned);

      // Create execution process record
      const processId = nanoid();
      db.db.insert(executionProcesses).values({
        id: processId,
        sessionId,
        status: 'running',
        prompt,
        createdAt: now,
      }).run();

      // Track current process ID for log routing (mutable so follow-ups work)
      const processState = { currentProcessId: processId };
      sessionProcessMap.set(sessionId, processState);

      // Check if agent session ID was already captured during spawn
      if (spawned.agentSessionId) {
        server.log.info({ sessionId, agentSessionId: spawned.agentSessionId }, 'Captured agent session ID from spawn');
        db.db.update(sessions)
          .set({ agentSessionId: spawned.agentSessionId, updatedAt: new Date() })
          .where(eq(sessions.id, sessionId))
          .run();
      }

      // Also subscribe to event for session IDs that arrive later
      spawned.events.on('sessionId', (agentSessId) => {
        server.log.info({ sessionId, agentSessionId: agentSessId }, 'Captured agent session ID from event');
        db.db.update(sessions)
          .set({ agentSessionId: agentSessId, updatedAt: new Date() })
          .where(eq(sessions.id, sessionId))
          .run();
      });

      // Listen for task completion (done event) in interactive mode
      // This happens when Claude sends a 'result' message
      spawned.events.on('event', (event) => {
        if (event.type === 'done') {
          const currentProcessId = processState.currentProcessId;
          server.log.info({ sessionId, processId: currentProcessId, reason: (event as any).reason }, 'Task completed (done event)');
          const completedAt = new Date();

          // Update process status to completed
          db.db.update(executionProcesses)
            .set({
              status: 'completed',
              exitCode: 0,
              completedAt,
            })
            .where(eq(executionProcesses.id, currentProcessId))
            .run();

          // Update session status to completed (allows follow-ups)
          db.db.update(sessions)
            .set({ status: 'completed' as SessionStatus, updatedAt: completedAt })
            .where(eq(sessions.id, sessionId))
            .run();

          // Note: We don't remove from activeSessions because the process is still alive
          // and can accept follow-up messages in interactive mode
        }
      });

      // Subscribe to MsgStore to persist logs to database
      // Uses processState.currentProcessId so follow-up logs go to the correct process
      const unsubscribeLogs = spawned.msgStore.subscribe((msg) => {
        try {
          // Map MsgStore types to database LogType
          let logType: 'stdout' | 'stderr' | 'event';
          let content: string;

          switch (msg.type) {
            case 'stdout':
              logType = 'stdout';
              content = msg.content;
              break;
            case 'stderr':
              logType = 'stderr';
              content = msg.content;
              break;
            case 'jsonPatch':
              logType = 'event';
              content = JSON.stringify({ type: 'jsonPatch', patch: msg.patch });
              break;
            case 'sessionId':
              logType = 'event';
              content = JSON.stringify({ type: 'sessionId', sessionId: msg.sessionId });
              break;
            case 'ready':
              logType = 'event';
              content = JSON.stringify({ type: 'ready' });
              break;
            case 'finished':
              logType = 'event';
              content = JSON.stringify({ type: 'finished' });
              break;
          }

          db.db.insert(processLogs).values({
            id: nanoid(),
            processId: processState.currentProcessId,
            logType,
            content,
            timestamp: new Date(),
          }).run();
        } catch {
          // Ignore persistence errors for now
        }
      });

      // Handle session exit
      spawned.waitForExit().then(({ code, signal }) => {
        // Unsubscribe from log persistence
        unsubscribeLogs();

        const completedAt = new Date();
        const currentProcessId = processState.currentProcessId;

        // Check current session status before updating
        // Don't change 'completed' to 'failed' just because the process was killed
        // (This happens during server shutdown when interactive mode keeps processes alive)
        const currentSession = db.db
          .select()
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .get();

        const currentStatus = currentSession?.status;
        const shouldPreserveStatus = currentStatus === 'completed' || currentStatus === 'killed';

        // Determine new status based on exit code, unless we should preserve current status
        const newSessionStatus: SessionStatus = shouldPreserveStatus
          ? currentStatus as SessionStatus
          : (code === 0 ? 'completed' : 'failed');

        // Update session status (only if not preserving)
        if (!shouldPreserveStatus) {
          db.db.update(sessions)
            .set({ status: newSessionStatus, updatedAt: completedAt })
            .where(eq(sessions.id, sessionId))
            .run();
        }

        // Update process status - check current process status too
        const currentProcess = db.db
          .select()
          .from(executionProcesses)
          .where(eq(executionProcesses.id, currentProcessId))
          .get();

        const processAlreadyCompleted = currentProcess?.status === 'completed' || currentProcess?.status === 'killed';

        if (!processAlreadyCompleted) {
          db.db.update(executionProcesses)
            .set({
              status: code === 0 ? 'completed' : 'failed',
              exitCode: code,
              completedAt,
            })
            .where(eq(executionProcesses.id, currentProcessId))
            .run();
        }

        // Remove from active sessions and process map
        activeSessions.delete(sessionId);
        sessionProcessMap.delete(sessionId);

        server.log.info(`Session ${sessionId} exited with code ${code}, signal ${signal}`);
      });

      return reply.status(201).send({
        id: sessionId,
        processId,
        connectorType: connectorName,
        workDir,
        status: 'running',
        createdAt: now.toISOString(),
      });
    } catch (error) {
      // Update session status to failed
      db.db.update(sessions)
        .set({ status: 'failed' as SessionStatus, updatedAt: new Date() })
        .where(eq(sessions.id, sessionId))
        .run();

      return reply.status(500).send({
        error: 'Failed to spawn session',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * POST /api/sessions/:id/follow-up
   * Send a follow-up message to an existing session
   */
  server.post<{ Params: { id: string } }>('/sessions/:id/follow-up', async (request, reply) => {
    const { id } = request.params;

    const body = followUpSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({
        error: 'Invalid request body',
        details: body.error.issues,
      });
    }

    const { prompt } = body.data;

    // Get the session
    const session = db.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, id))
      .get();

    if (!session) {
      return reply.status(404).send({
        error: 'Session not found',
      });
    }

    // Check if session is active (process still running)
    const activeSession = activeSessions.get(id);
    if (activeSession) {
      // Send input to active session (interactive mode)
      try {
        // Create a new execution process record for this follow-up
        const newProcessId = nanoid();
        const now = new Date();

        db.db.insert(executionProcesses).values({
          id: newProcessId,
          sessionId: id,
          status: 'running',
          prompt,
          createdAt: now,
        }).run();

        // Update the process state so logs go to the new process
        const processState = sessionProcessMap.get(id);
        if (processState) {
          processState.currentProcessId = newProcessId;
        }

        // Clear the MsgStore to prevent old logs from being streamed to the new process
        // This is critical for interactive mode where the process stays alive across follow-ups
        activeSession.msgStore.clear();

        // Update session status back to running
        db.db.update(sessions)
          .set({ status: 'running' as SessionStatus, updatedAt: now })
          .where(eq(sessions.id, id))
          .run();

        // Send the input (the existing event listener will handle completion)
        activeSession.sendInput(prompt);

        return reply.send({
          status: 'sent',
          sessionId: id,
          processId: newProcessId,
        });
      } catch (error) {
        return reply.status(500).send({
          error: 'Failed to send input',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    // Session not active, spawn follow-up
    const connector = registry.get(session.connectorType);
    if (!connector) {
      return reply.status(500).send({
        error: `Connector ${session.connectorType} no longer available`,
      });
    }

    // Check if we have an agent session ID for resume
    if (!session.agentSessionId) {
      return reply.status(400).send({
        error: 'Cannot resume session: no agent session ID available',
        message: 'The original session may not have completed successfully or the agent did not provide a session ID',
      });
    }

    try {
      const spawned = await connector.spawnFollowUp({
        workDir: session.workDir,
        prompt,
        sessionId: session.agentSessionId, // Use agent's session ID, not our internal ID
      });

      // Track the new active session
      activeSessions.set(id, spawned);

      // Create execution process record
      const processId = nanoid();
      const now = new Date();

      db.db.insert(executionProcesses).values({
        id: processId,
        sessionId: id,
        status: 'running',
        prompt,
        createdAt: now,
      }).run();

      // Update session status
      db.db.update(sessions)
        .set({ status: 'running' as SessionStatus, updatedAt: now })
        .where(eq(sessions.id, id))
        .run();

      // Subscribe to MsgStore to persist logs to database
      const unsubscribeLogs = spawned.msgStore.subscribe((msg) => {
        try {
          // Map MsgStore types to database LogType
          let logType: 'stdout' | 'stderr' | 'event';
          let content: string;

          switch (msg.type) {
            case 'stdout':
              logType = 'stdout';
              content = msg.content;
              break;
            case 'stderr':
              logType = 'stderr';
              content = msg.content;
              break;
            case 'jsonPatch':
              logType = 'event';
              content = JSON.stringify({ type: 'jsonPatch', patch: msg.patch });
              break;
            case 'sessionId':
              logType = 'event';
              content = JSON.stringify({ type: 'sessionId', sessionId: msg.sessionId });
              break;
            case 'ready':
              logType = 'event';
              content = JSON.stringify({ type: 'ready' });
              break;
            case 'finished':
              logType = 'event';
              content = JSON.stringify({ type: 'finished' });
              break;
          }

          db.db.insert(processLogs).values({
            id: nanoid(),
            processId,
            logType,
            content,
            timestamp: new Date(),
          }).run();
        } catch {
          // Ignore persistence errors for now
        }
      });

      // Handle exit
      spawned.waitForExit().then(({ code }) => {
        // Unsubscribe from log persistence
        unsubscribeLogs();

        const completedAt = new Date();

        // Check current session status before updating
        // Don't change 'completed' to 'failed' just because the process was killed
        const currentSession = db.db
          .select()
          .from(sessions)
          .where(eq(sessions.id, id))
          .get();

        const currentStatus = currentSession?.status;
        const shouldPreserveStatus = currentStatus === 'completed' || currentStatus === 'killed';

        if (!shouldPreserveStatus) {
          const status: SessionStatus = code === 0 ? 'completed' : 'failed';
          db.db.update(sessions)
            .set({ status, updatedAt: completedAt })
            .where(eq(sessions.id, id))
            .run();
        }

        // Check current process status too
        const currentProcess = db.db
          .select()
          .from(executionProcesses)
          .where(eq(executionProcesses.id, processId))
          .get();

        const processAlreadyCompleted = currentProcess?.status === 'completed' || currentProcess?.status === 'killed';

        if (!processAlreadyCompleted) {
          db.db.update(executionProcesses)
            .set({
              status: code === 0 ? 'completed' : 'failed',
              exitCode: code,
              completedAt,
            })
            .where(eq(executionProcesses.id, processId))
            .run();
        }

        activeSessions.delete(id);
      });

      return reply.status(201).send({
        sessionId: id,
        processId,
        status: 'running',
      });
    } catch (error) {
      return reply.status(500).send({
        error: 'Failed to spawn follow-up',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * DELETE /api/sessions/:id
   * Kill/stop a session
   */
  server.delete<{ Params: { id: string } }>('/sessions/:id', async (request, reply) => {
    const { id } = request.params;

    // Check if session exists in DB first
    const session = db.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, id))
      .get();

    if (!session) {
      return reply.status(404).send({
        error: 'Session not found',
      });
    }

    const activeSession = activeSessions.get(id);
    if (!activeSession) {
      // Session not active - update DB status if still showing as running
      if (session.status === 'running') {
        db.db.update(sessions)
          .set({ status: 'killed' as SessionStatus, updatedAt: new Date() })
          .where(eq(sessions.id, id))
          .run();

        // Also update any running processes for this session
        db.db.update(executionProcesses)
          .set({ status: 'killed', completedAt: new Date() })
          .where(eq(executionProcesses.sessionId, id))
          .run();

        return reply.send({
          status: 'killed',
          sessionId: id,
        });
      }

      return reply.send({
        status: 'already_stopped',
        sessionId: id,
      });
    }

    try {
      await activeSession.kill();

      // Update session status
      db.db.update(sessions)
        .set({ status: 'killed' as SessionStatus, updatedAt: new Date() })
        .where(eq(sessions.id, id))
        .run();

      // Update execution processes
      db.db.update(executionProcesses)
        .set({ status: 'killed', completedAt: new Date() })
        .where(eq(executionProcesses.sessionId, id))
        .run();

      activeSessions.delete(id);

      return reply.send({
        status: 'killed',
        sessionId: id,
      });
    } catch (error) {
      return reply.status(500).send({
        error: 'Failed to kill session',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * POST /api/sessions/:id/interrupt
   * Gracefully interrupt a session (stops current task but keeps process alive for follow-ups)
   */
  server.post<{ Params: { id: string } }>('/sessions/:id/interrupt', async (request, reply) => {
    const { id } = request.params;

    const activeSession = activeSessions.get(id);
    if (!activeSession) {
      return reply.status(404).send({
        error: 'No active session found',
      });
    }

    try {
      await activeSession.interrupt();

      const now = new Date();

      // Update current process status to completed (interrupted)
      const processState = sessionProcessMap.get(id);
      if (processState) {
        db.db.update(executionProcesses)
          .set({
            status: 'completed',
            exitCode: -1, // Use -1 to indicate interrupted
            completedAt: now,
          })
          .where(eq(executionProcesses.id, processState.currentProcessId))
          .run();
      }

      // Update session status to completed so follow-ups can be sent
      // Note: We keep the session in activeSessions since the process is still alive
      db.db.update(sessions)
        .set({ status: 'completed' as SessionStatus, updatedAt: now })
        .where(eq(sessions.id, id))
        .run();

      return reply.send({
        status: 'interrupted',
        sessionId: id,
      });
    } catch (error) {
      return reply.status(500).send({
        error: 'Failed to interrupt session',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * GET /api/sessions/:id/approvals
   * Get pending approval requests for a session
   */
  server.get<{ Params: { id: string } }>('/sessions/:id/approvals', async (request, reply) => {
    const { id } = request.params;

    const activeSession = activeSessions.get(id);
    if (!activeSession) {
      return reply.status(404).send({
        error: 'No active session found',
      });
    }

    const approvalService = activeSession.approvalService;
    if (!approvalService) {
      return reply.send({
        approvals: [],
        message: 'Approval mode not enabled for this session',
      });
    }

    return reply.send({
      approvals: approvalService.getPendingApprovals(),
    });
  });

  /**
   * POST /api/sessions/:id/approvals/respond
   * Respond to an approval request
   */
  server.post<{ Params: { id: string } }>('/sessions/:id/approvals/respond', async (request, reply) => {
    const { id } = request.params;

    const body = approvalResponseSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({
        error: 'Invalid request body',
        details: body.error.issues,
      });
    }

    const { requestId, status, reason } = body.data;

    const activeSession = activeSessions.get(id);
    if (!activeSession) {
      return reply.status(404).send({
        error: 'No active session found',
      });
    }

    const approvalService = activeSession.approvalService;
    if (!approvalService) {
      return reply.status(400).send({
        error: 'Approval mode not enabled for this session',
      });
    }

    const handled = approvalService.handleResponse({
      requestId,
      status: status as ApprovalStatus,
      reason,
    });

    if (!handled) {
      return reply.status(404).send({
        error: 'Approval request not found or already handled',
      });
    }

    return reply.send({
      status: 'responded',
      requestId,
      response: status,
    });
  });

  /**
   * WebSocket: GET /api/sessions/:id/approvals/stream
   * Stream approval requests for a session in real-time
   */
  server.get<{ Params: { id: string } }>(
    '/sessions/:id/approvals/stream',
    { websocket: true } as any,
    async (connection: SocketStream, request: any) => {
      const { id } = request.params;
      const socket = connection.socket;

      const activeSession = activeSessions.get(id);

      if (!activeSession) {
        socket.send(JSON.stringify({ error: 'No active session found' }));
        socket.close();
        return;
      }

      const approvalService = activeSession.approvalService;
      if (!approvalService) {
        socket.send(JSON.stringify({ error: 'Approval mode not enabled for this session' }));
        socket.close();
        return;
      }

      // Send any pending approvals first
      const pending = approvalService.getPendingApprovals();
      for (const approval of pending) {
        socket.send(JSON.stringify({
          type: 'approvalRequest',
          data: approval,
        }));
      }

      // Subscribe to new approval requests
      const handleApprovalRequest = (req: ApprovalRequest) => {
        try {
          socket.send(JSON.stringify({
            type: 'approvalRequest',
            data: req,
          }));
        } catch {
          // Socket closed
        }
      };

      const handleApprovalResponse = (resp: ApprovalResponse) => {
        try {
          socket.send(JSON.stringify({
            type: 'approvalResponse',
            data: resp,
          }));
        } catch {
          // Socket closed
        }
      };

      approvalService.on('approvalRequest', handleApprovalRequest);
      approvalService.on('approvalResponse', handleApprovalResponse);

      // Handle incoming messages (approval responses from client)
      socket.on('message', (data: Buffer | string) => {
        try {
          const message = JSON.parse(typeof data === 'string' ? data : data.toString());
          if (message.type === 'approvalResponse') {
            const { requestId, status, reason } = message.data;
            approvalService.handleResponse({
              requestId,
              status,
              reason,
            });
          }
        } catch {
          // Invalid message format, ignore
        }
      });

      // Handle socket close
      socket.on('close', () => {
        approvalService.off('approvalRequest', handleApprovalRequest);
        approvalService.off('approvalResponse', handleApprovalResponse);
      });

      socket.on('error', () => {
        approvalService.off('approvalRequest', handleApprovalRequest);
        approvalService.off('approvalResponse', handleApprovalResponse);
      });

      // Handle session exit
      activeSession.events.on('exit', () => {
        socket.send(JSON.stringify({ type: 'sessionEnded' }));
        socket.close();
      });
    }
  );
};
