import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

export * from './schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface DatabaseConfig {
  dbPath: string;
  runMigrations?: boolean;
}

export interface DatabaseInstance {
  db: ReturnType<typeof drizzle>;
  sqlite: Database.Database;
  close: () => void;
}

/**
 * Initialize the SQLite database with Drizzle ORM
 */
export function initDatabase(config: DatabaseConfig): DatabaseInstance {
  const { dbPath, runMigrations = true } = config;

  // Ensure directory exists
  const dbDir = dirname(dbPath);
  if (dbDir && !existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  // Create SQLite connection
  const sqlite = new Database(dbPath);

  // Enable WAL mode for better concurrent access
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  // Create Drizzle instance
  const db = drizzle(sqlite, { schema });

  // Run migrations if enabled
  if (runMigrations) {
    const migrationsFolder = join(__dirname, 'migrations');
    if (existsSync(migrationsFolder)) {
      migrate(db, { migrationsFolder });
    }

    // Add agentSessionId column if it doesn't exist (for existing databases)
    try {
      sqlite.exec(`ALTER TABLE sessions ADD COLUMN agent_session_id TEXT`);
    } catch {
      // Column already exists, ignore
    }

    // Add approval_mode column if it doesn't exist (for existing databases)
    try {
      sqlite.exec(`ALTER TABLE sessions ADD COLUMN approval_mode TEXT NOT NULL DEFAULT 'manual'`);
    } catch {
      // Column already exists, ignore
    }
  }

  return {
    db,
    sqlite,
    close: () => sqlite.close(),
  };
}

/**
 * Create an in-memory database (useful for testing)
 */
export function createInMemoryDatabase(): DatabaseInstance {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema });

  // For in-memory, we need to create tables manually since migrations won't exist
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      connector_type TEXT NOT NULL,
      work_dir TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      approval_mode TEXT NOT NULL DEFAULT 'manual',
      agent_session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions(status);

    CREATE TABLE IF NOT EXISTS execution_processes (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'running',
      prompt TEXT NOT NULL,
      exit_code INTEGER,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS exec_proc_session_idx ON execution_processes(session_id);
    CREATE INDEX IF NOT EXISTS exec_proc_status_idx ON execution_processes(status);

    CREATE TABLE IF NOT EXISTS process_logs (
      id TEXT PRIMARY KEY,
      process_id TEXT NOT NULL REFERENCES execution_processes(id) ON DELETE CASCADE,
      log_type TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS proc_logs_process_idx ON process_logs(process_id);
    CREATE INDEX IF NOT EXISTS proc_logs_timestamp_idx ON process_logs(timestamp);
  `);

  return {
    db,
    sqlite,
    close: () => sqlite.close(),
  };
}
