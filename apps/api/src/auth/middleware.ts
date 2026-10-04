import type { FastifyRequest, FastifyReply } from "fastify";
import type pg from "pg";
import {
  type AuthVerifier,
  type ResolvedUser,
  AuthenticationError,
} from "./types.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: ResolvedUser;
  }
}

export function createAuthHook(authVerifier: AuthVerifier, pool: pg.Pool) {
  return async function authenticateRequest(
    req: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      reply.status(401).send({
        error: {
          code: "MISSING_TOKEN",
          message: "Authorization header with Bearer token is required.",
        },
      });
      return;
    }

    if (!authHeader.startsWith("Bearer ")) {
      reply.status(401).send({
        error: {
          code: "INVALID_HEADER",
          message: "Authorization header must use 'Bearer <token>' format.",
        },
      });
      return;
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      reply.status(401).send({
        error: {
          code: "MISSING_TOKEN",
          message: "Bearer token must not be empty.",
        },
      });
      return;
    }

    // Fail-closed if verifier is not configured with an authentic provider
    if (!authVerifier.isConfigured()) {
      reply.status(401).send({
        error: {
          code: "AUTH_NOT_CONFIGURED",
          message:
            "Authentication provider is not configured. Protected endpoints are disabled.",
        },
      });
      return;
    }

    let claims;
    try {
      claims = await authVerifier.verifyToken(token);
    } catch (err: any) {
      const code = err instanceof AuthenticationError ? err.code : "INVALID_TOKEN";
      const message = err?.message ?? "Invalid authentication token.";
      reply.status(401).send({
        error: {
          code,
          message,
        },
      });
      return;
    }

    // Resolve verified (issuer, subject) strictly against internal app_users
    // We intentionally query using parameters to prevent SQL injection
    try {
      const result = await pool.query<{
        id: string;
        identity_issuer: string;
        identity_subject: string;
        email: string | null;
        display_name: string | null;
        created_at: Date;
      }>(
        `SELECT id, identity_issuer, identity_subject, email, display_name, created_at
         FROM moducraft_resolve_identity($1, $2);`,
        [claims.issuer, claims.subject]
      );

      if (result.rows.length === 0) {
        reply.status(401).send({
          error: {
            code: "USER_NOT_PROVISIONED",
            message:
              "Verified identity is not provisioned in the application database.",
          },
        });
        return;
      }

      const row = result.rows[0];
      req.user = {
        id: row.id,
        identityIssuer: row.identity_issuer,
        identitySubject: row.identity_subject,
        email: row.email,
        displayName: row.display_name,
        createdAt: row.created_at,
      };
    } catch (dbError: any) {
      req.log.error({ err: dbError.message }, "Database error during identity resolution");
      reply.status(500).send({
        error: {
          code: "INTERNAL_ERROR",
          message: "Internal server error resolving user identity.",
        },
      });
    }
  };
}
