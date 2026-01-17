#!/usr/bin/env node
/**
 * vibe-server CLI entry point
 *
 * Starts the vibe-server with default configuration and Claude connector.
 */

import { VibeServer, ClaudeConnector, VibeConnector } from '../index.js';

const PORT = parseInt(process.env.PORT || '3456', 10);
const HOST = process.env.HOST || 'localhost';

async function main() {
  console.log('Starting vibe-server...');

  const server = new VibeServer({
    port: PORT,
    host: HOST,
    dbPath: './vibe-server.db',
    logging: true,
  });

  // Register connectors
  const claude = new ClaudeConnector({
    dangerouslySkipPermissions: false,
  });

  const vibe = new VibeConnector({
    autoApprove: false,
  });

  // We need to start the server first to access the registry
  await server.listen();

  // Register connectors after server starts
  if (server.registry) {
    server.registry.register(claude);
    server.registry.register(vibe);
    console.log('Registered connectors:', server.registry.names());
  }

  console.log(`
╔════════════════════════════════════════════════════════════╗
║                    vibe-server started                      ║
╠════════════════════════════════════════════════════════════╣
║  Server:     http://${HOST}:${PORT.toString().padEnd(4)}                           ║
║  Health:     http://${HOST}:${PORT}/api/health                 ║
║  Connectors: http://${HOST}:${PORT}/api/health/connectors      ║
╚════════════════════════════════════════════════════════════╝

Available endpoints:
  GET  /api/health              - Health check
  GET  /api/health/connectors   - Check connector availability
  GET  /api/sessions            - List sessions
  POST /api/sessions            - Create session
  GET  /api/sessions/:id        - Get session details
  POST /api/sessions/:id/follow-up - Send follow-up
  DELETE /api/sessions/:id      - Kill session
  GET  /api/processes/:id/stream (WS) - Stream logs

Press Ctrl+C to stop.
  `);
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
