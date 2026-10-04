import type { FastifyInstance } from "fastify";
import type pg from "pg";

export function registerHealthRoutes(app: FastifyInstance, pool: pg.Pool) {
  // Liveness probe: responds immediately without external dependencies
  app.get("/health", async () => ({
    status: "ok",
    service: "moducraft-api",
  }));

  // Readiness probe: verifies restricted database connectivity without leaking credentials or error internals
  app.get("/ready", async (_req, reply) => {
    try {
      await pool.query("SELECT 1;");
      return {
        status: "ready",
        database: "connected",
      };
    } catch {
      reply.status(503).send({
        status: "unavailable",
        database: "unreachable",
      });
    }
  });
}
