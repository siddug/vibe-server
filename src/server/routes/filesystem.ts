import { FastifyPluginAsync } from 'fastify';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome } from '../../utils/paths.js';

const filesystemRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/filesystem/list', async (request, reply) => {
    const { path: rawPath, showHidden } = request.query as {
      path?: string;
      showHidden?: string;
    };

    if (!rawPath) {
      return reply.status(400).send({ error: 'path query parameter is required' });
    }

    const resolvedPath = expandHome(rawPath);

    if (!existsSync(resolvedPath)) {
      return reply.status(400).send({ error: `Path does not exist: ${rawPath}` });
    }

    let stat;
    try {
      stat = statSync(resolvedPath);
    } catch {
      return reply.status(400).send({ error: `Cannot access path: ${rawPath}` });
    }

    if (!stat.isDirectory()) {
      return reply.status(400).send({ error: `Path is not a directory: ${rawPath}` });
    }

    const includeHidden = showHidden === 'true';

    try {
      const dirEntries = readdirSync(resolvedPath, { withFileTypes: true });

      const entries = dirEntries
        .filter((entry) => {
          if (!includeHidden && entry.name.startsWith('.')) return false;
          return true;
        })
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? ('directory' as const) : ('file' as const),
          path: join(resolvedPath, entry.name),
        }))
        .sort((a, b) => {
          // Directories first, then files, alphabetical within each group
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      return { path: resolvedPath, entries };
    } catch (err) {
      return reply.status(403).send({
        error: `Permission denied: ${rawPath}`,
      });
    }
  });
};

export default filesystemRoutes;
