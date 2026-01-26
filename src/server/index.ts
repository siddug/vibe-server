import Fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import websocket from '@fastify/websocket';
import { initDatabase, type DatabaseInstance } from '../db/index.js';
import { ConnectorRegistry, createConnectorRegistry } from '../connectors/registry.js';
import type { BaseConnector, SpawnedSession } from '../connectors/base.js';
import { healthRoutes } from './routes/health.js';
import { sessionsRoutes } from './routes/sessions.js';
import { processesRoutes } from './routes/processes.js';
import { apiKeysRoutes } from './routes/api-keys.js';

/**
 * Server configuration options
 */
export interface ServerConfig {
  /** Port to listen on (default: 3000) */
  port?: number;

  /** Host to bind to (default: localhost) */
  host?: string;

  /** Database file path (default: ./vibe-server.db) */
  dbPath?: string;

  /** Enable request logging (default: true in dev) */
  logging?: boolean;

  /** Enable CORS (default: true) */
  cors?: boolean;
}

/**
 * Server state accessible to routes
 */
export interface ServerState {
  db: DatabaseInstance;
  registry: ConnectorRegistry;
  sessions: Map<string, SpawnedSession>;
}

/**
 * Extend Fastify with our server state
 */
declare module 'fastify' {
  interface FastifyInstance {
    state: ServerState;
  }
}

/**
 * Create and configure the Fastify server
 */
export async function createServer(config: ServerConfig = {}): Promise<FastifyInstance> {
  const {
    port = 3000,
    host = 'localhost',
    dbPath = './vibe-server.db',
    logging = process.env.NODE_ENV !== 'production',
    cors = true,
  } = config;

  // Create Fastify instance
  const server = Fastify({
    logger: logging
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              translateTime: 'HH:MM:ss Z',
              ignore: 'pid,hostname',
            },
          },
        }
      : false,
  });

  // Initialize database
  const db = initDatabase({ dbPath });

  // Create connector registry
  const registry = createConnectorRegistry();

  // Create sessions map for tracking active sessions
  const sessions = new Map<string, SpawnedSession>();

  // Decorate server with state
  server.decorate('state', {
    db,
    registry,
    sessions,
  } satisfies ServerState);

  // Register WebSocket support
  await server.register(websocket);

  // CORS handling (simple implementation)
  if (cors) {
    server.addHook('onRequest', async (request, reply) => {
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (request.method === 'OPTIONS') {
        return reply.status(204).send();
      }
    });
  }

  // Register routes
  await server.register(healthRoutes, { prefix: '/api' });
  await server.register(sessionsRoutes, { prefix: '/api' });
  await server.register(processesRoutes, { prefix: '/api' });
  await server.register(apiKeysRoutes, { prefix: '/api' });

  // Graceful shutdown
  const shutdown = async () => {
    server.log.info('Shutting down server...');

    // Kill all active sessions
    for (const [id, session] of sessions) {
      try {
        await session.kill();
        server.log.info(`Killed session ${id}`);
      } catch (error) {
        server.log.error(`Error killing session ${id}: ${error}`);
      }
    }

    // Close database
    db.close();

    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}

/**
 * Start the server and listen for connections
 */
export async function startServer(
  config: ServerConfig = {}
): Promise<FastifyInstance> {
  const server = await createServer(config);

  const port = config.port || 3000;
  const host = config.host || 'localhost';

  await server.listen({ port, host });

  server.log.info(`Vibe Server listening on http://${host}:${port}`);

  return server;
}

/**
 * VibeServer class - Main entry point for the server
 */
export class VibeServer {
  private server: FastifyInstance | null = null;
  private config: ServerConfig;

  constructor(config: ServerConfig = {}) {
    this.config = config;
  }

  /**
   * Register a connector
   */
  registerConnector(name: string, connector: BaseConnector): this {
    if (this.server) {
      this.server.state.registry.register(connector);
    }
    return this;
  }

  /**
   * Get the connector registry
   */
  get registry(): ConnectorRegistry | null {
    return this.server?.state.registry || null;
  }

  /**
   * Get the database instance
   */
  get db(): DatabaseInstance | null {
    return this.server?.state.db || null;
  }

  /**
   * Start the server
   */
  async listen(): Promise<void> {
    this.server = await startServer(this.config);
  }

  /**
   * Stop the server
   */
  async close(): Promise<void> {
    if (this.server) {
      await this.server.close();
      this.server = null;
    }
  }

  /**
   * Get the underlying Fastify instance
   */
  get fastify(): FastifyInstance | null {
    return this.server;
  }
}

/**
 * Create a new VibeServer instance
 */
export function createVibeServer(config: ServerConfig = {}): VibeServer {
  return new VibeServer(config);
}
