import { Hono } from 'hono';

const VERSION = '0.1.0';

export const healthRoute = new Hono().get('/', (c) => c.json({ ok: true, version: VERSION }));
