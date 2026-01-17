import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';

/**
 * Configuration schema
 */
const configSchema = z.object({
  server: z
    .object({
      port: z.number().default(3000),
      host: z.string().default('localhost'),
    })
    .default({}),
  database: z
    .object({
      path: z.string().default('./vibe-server.db'),
    })
    .default({}),
  connectors: z
    .object({
      default: z.string().optional(),
      claude: z
        .object({
          enabled: z.boolean().default(true),
          model: z.string().optional(),
          dangerouslySkipPermissions: z.boolean().default(false),
        })
        .default({}),
    })
    .default({}),
  logging: z
    .object({
      level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
      pretty: z.boolean().default(true),
    })
    .default({}),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Default configuration
 */
export const defaultConfig: Config = configSchema.parse({});

/**
 * Get the default config file path
 */
export function getConfigPath(): string {
  // Check if running in Electron environment
  const isElectronEnv = process.versions.electron !== undefined;
  
  if (isElectronEnv && process.env.ELECTRON_USER_DATA) {
    // Use Electron's user data directory
    const configDir = join(process.env.ELECTRON_USER_DATA, '.vibe-server');
    return join(configDir, 'config.json');
  } else {
    // Use default home directory
    const configDir = join(homedir(), '.vibe-server');
    return join(configDir, 'config.json');
  }
}

/**
 * Load configuration from file
 */
export function loadConfig(configPath?: string): Config {
  const path = configPath || getConfigPath();

  if (!existsSync(path)) {
    return defaultConfig;
  }

  try {
    const content = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(content);
    return configSchema.parse(parsed);
  } catch (error) {
    console.warn(`Failed to load config from ${path}:`, error);
    return defaultConfig;
  }
}

/**
 * Save configuration to file
 */
export function saveConfig(config: Config, configPath?: string): void {
  const path = configPath || getConfigPath();
  const dir = dirname(path);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(path, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Merge partial config with defaults
 */
export function mergeConfig(partial: Partial<Config>): Config {
  return configSchema.parse(partial);
}
