import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

export function registerHealthRoutes(app: FastifyInstance, pool: pg.Pool): void {
  // Liveness: process is up and able to answer HTTP at all. No dependency
  // checks — a flapping dependency must not cause a liveness-probe restart
  // loop; that is what readiness is for.
  app.get('/healthz', async () => ({ status: 'ok' }));

  // Readiness: can this instance actually serve permit/trip traffic right
  // now? A store outage must flip this to unready so a load balancer stops
  // routing here, without killing the process.
  app.get('/readyz', async (_request, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ready' };
    } catch (err) {
      app.log.warn({ err }, 'readiness check failed: store unreachable');
      return reply.code(503).send({ status: 'not-ready', reason: 'store_unavailable' });
    }
  });
}
