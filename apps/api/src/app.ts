import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { type AppConfig, loadConfig } from "./config/env.js";
import { createDatabasePool, assertRestrictedRole } from "./db/pool.js";
import type { AuthVerifier } from "./auth/types.js";
import { JoseJwtVerifier } from "./auth/verifier.js";
import { AppError } from "./errors/app-errors.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerIdentityRoutes } from "./routes/identity.js";
import { registerOrganizationRoutes } from "./routes/organizations.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerAgentTaskRoutes } from "./modules/orchestrator/index.js";
import { registerProviderConfigRoutes } from "./modules/providers/index.js";
import { registerMemoryRoutes } from "./modules/memory/index.js";
import { registerWorkflowRoutes } from "./modules/workflows/index.js";
import { registerResourceRoutes } from "./modules/resources/index.js";

export interface BuildAppOptions {
  config?: AppConfig;
  pool?: pg.Pool;
  authVerifier?: AuthVerifier;
  enforceRestrictedRoleCheck?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();

  const app = Fastify({
    logger: {
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "password",
        "token",
        "apiKey",
        "secret",
        "databaseUrl",
      ],
    },
  });

  const pool = options.pool ?? createDatabasePool(config.databaseUrl);
  const ownsPool = !options.pool;

  // Enforce that application connection uses restricted unprivileged role
  if (options.enforceRestrictedRoleCheck !== false) {
    try {
      await assertRestrictedRole(pool);
    } catch (err: any) {
      if (ownsPool) {
        await pool.end();
      }
      throw err;
    }
  }

  const authVerifier =
    options.authVerifier ??
    new JoseJwtVerifier({
      issuer: config.auth.issuer,
      audience: config.auth.audience,
      jwksUri: config.auth.jwksUri,
      publicKey: config.auth.publicKey,
      secret: config.auth.secret,
    });

  // Global error handler: sanitize errors and return structured format without leaking internals
  app.setErrorHandler((error: any, request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      });
      return;
    }

    if (error.validation) {
      reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: error.message,
          details: error.validation,
        },
      });
      return;
    }

    request.log.error(error);
    const statusCode =
      typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500
        ? error.statusCode
        : 500;

    reply.status(statusCode).send({
      error: {
        code: statusCode === 500 ? "INTERNAL_SERVER_ERROR" : "REQUEST_FAILED",
        message:
          statusCode === 500
            ? "An internal server error occurred."
            : error.message || "Request failed.",
      },
    });
  });

  // Register routes
  registerHealthRoutes(app, pool);
  registerIdentityRoutes(app, pool, authVerifier);
  registerOrganizationRoutes(app, pool, authVerifier);
  registerProjectRoutes(app, pool, authVerifier);
  registerAgentTaskRoutes(app, pool, authVerifier);
  registerProviderConfigRoutes(app, pool, authVerifier);
  registerMemoryRoutes(app, pool, authVerifier);
  registerWorkflowRoutes(app, pool, authVerifier);
  registerResourceRoutes(app, pool, authVerifier);

  // Clean shutdown hook
  app.addHook("onClose", async () => {
    if (ownsPool) {
      await pool.end();
    }
  });

  return app;
}
