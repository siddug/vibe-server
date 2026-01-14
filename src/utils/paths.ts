import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

/**
 * Get the vibe-server data directory
 */
export function getDataDir(dev = process.env.NODE_ENV === 'development'): string {
  let dataDir = join(homedir(), '.vibe-server');

  if (dev) {
    dataDir = join(dataDir, 'dev');
  }

  return dataDir;
}

/**
 * Ensure a directory exists, creating it if necessary
 */
export function ensureDir(path: string): string {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
  return path;
}

/**
 * Get the sessions directory
 */
export function getSessionsDir(namespace: string, dev?: boolean): string {
  const dataDir = getDataDir(dev);
  return ensureDir(join(dataDir, namespace));
}

/**
 * Get the database path
 */
export function getDatabasePath(filename = 'vibe-server.db', dev?: boolean): string {
  const dataDir = ensureDir(getDataDir(dev));
  return join(dataDir, filename);
}

/**
 * Resolve a path relative to the current working directory
 */
export function resolvePath(path: string): string {
  if (isAbsolute(path)) {
    return path;
  }
  return resolve(process.cwd(), path);
}

/**
 * Expand ~ in paths to home directory
 */
export function expandHome(path: string): string {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  if (path === '~') {
    return homedir();
  }
  return path;
}

/**
 * Normalize and resolve a path (expand ~ and resolve relative paths)
 */
export function normalizePath(path: string): string {
  return resolvePath(expandHome(path));
}
