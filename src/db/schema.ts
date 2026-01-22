import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

// Session status enum
export type SessionStatus = 'running' | 'completed' | 'failed' | 'killed';

// Approval mode enum
export type ApprovalMode = 'manual' | 'auto';

// Execution process status enum
export type ExecutionProcessStatus = 'running' | 'completed' | 'failed' | 'killed';

// Log type enum
export type LogType = 'stdout' | 'stderr' | 'event';

/**
 * Sessions table - represents a coding session with an AI agent
 */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    connectorType: text('connector_type').notNull(),
    workDir: text('work_dir').notNull(),
    status: text('status').$type<SessionStatus>().notNull().default('running'),
    // Approval mode: 'manual' requires user approval, 'auto' auto-approves all tool calls
    approvalMode: text('approval_mode').$type<ApprovalMode>().notNull().default('manual'),
    // Agent's own session ID (e.g., Claude's UUID) used for --resume
    agentSessionId: text('agent_session_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    sessionsStatusIdx: index('sessions_status_idx').on(table.status),
  })
);

/**
 * Execution processes table - represents individual agent execution runs
 */
export const executionProcesses = sqliteTable(
  'execution_processes',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .references(() => sessions.id, { onDelete: 'cascade' })
      .notNull(),
    status: text('status').$type<ExecutionProcessStatus>().notNull().default('running'),
    prompt: text('prompt').notNull(),
    exitCode: integer('exit_code'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
  },
  (table) => ({
    execProcSessionIdx: index('exec_proc_session_idx').on(table.sessionId),
    execProcStatusIdx: index('exec_proc_status_idx').on(table.status),
  })
);

/**
 * Process logs table - stores stdout, stderr, and ACP events
 */
export const processLogs = sqliteTable(
  'process_logs',
  {
    id: text('id').primaryKey(),
    processId: text('process_id')
      .references(() => executionProcesses.id, { onDelete: 'cascade' })
      .notNull(),
    logType: text('log_type').$type<LogType>().notNull(),
    content: text('content').notNull(),
    timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    procLogsProcessIdx: index('proc_logs_process_idx').on(table.processId),
    procLogsTimestampIdx: index('proc_logs_timestamp_idx').on(table.timestamp),
  })
);

// Type exports for use in application code
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type ExecutionProcess = typeof executionProcesses.$inferSelect;
export type NewExecutionProcess = typeof executionProcesses.$inferInsert;
export type ProcessLog = typeof processLogs.$inferSelect;
export type NewProcessLog = typeof processLogs.$inferInsert;
