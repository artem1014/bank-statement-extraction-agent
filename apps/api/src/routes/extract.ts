import { Hono } from 'hono';

export const extractRoute = new Hono().post('/', (c) =>
  c.json(
    {
      code: 'EXTRACTION_FAILED',
      message: 'The extraction pipeline is not wired up yet (see tasks T060-T064).',
    },
    501,
  ),
);
