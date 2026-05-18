import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { config } from './config.js';
import { extractRoute } from './routes/extract.js';
import { healthRoute } from './routes/health.js';
import { logger } from './utils/logger.js';

const app = new Hono();
const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIST = resolve(HERE, '..', '..', 'web', 'dist');
const SERVE_WEB = existsSync(WEB_DIST);

app.use(
  '*',
  cors({
    origin: config.CORS_ORIGIN,
    allowMethods: ['POST', 'GET', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Accept'],
    credentials: false,
    maxAge: 86400,
  }),
);

app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  logger.info(
    {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration_ms: Date.now() - start,
    },
    'request',
  );
});

app.route('/api/health', healthRoute);
app.route('/api/extract', extractRoute);

if (SERVE_WEB) {
  app.use('/assets/*', serveStatic({ root: WEB_DIST, rewriteRequestPath: (p) => p }));
  app.get('*', serveStatic({ path: `${WEB_DIST}/index.html` }));
  logger.info({ webDist: WEB_DIST }, 'serving-web-static');
}

app.notFound((c) => c.json({ code: 'BAD_FILE', message: 'Not found' }, 404));

app.onError((err, c) => {
  logger.error({ err: { name: err.name, message: err.message } }, 'unhandled-error');
  return c.json(
    {
      code: 'EXTRACTION_FAILED',
      message: 'Something went wrong. Please try again.',
    },
    500,
  );
});

if (process.env.SKIP_LISTEN !== 'true') {
  serve({ fetch: app.fetch, port: config.PORT }, ({ port }) => {
    logger.info({ port, env: config.NODE_ENV }, 'api-listening');
  });
}

export { app };
