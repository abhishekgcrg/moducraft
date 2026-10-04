import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { AuthVerifier } from "../auth/types.js";
import { createAuthHook } from "../auth/middleware.js";
import { withAuthenticatedContext } from "../db/transaction.js";

export function registerIdentityRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  authVerifier: AuthVerifier
) {
  const authenticate = createAuthHook(authVerifier, pool);

  app.get(
    "/api/v1/identity/me",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user;
      if (!user) {
        reply.status(401).send({
          error: {
            code: "UNAUTHORIZED",
            message: "Missing authenticated user context.",
          },
        });
        return;
      }

      // Execute protected query strictly inside transaction-scoped identity context
      const record = await withAuthenticatedContext(pool, user.id, async (tx) => {
        // forced RLS policy app_users_select_self ensures id = moducraft_current_user_id()
        const result = await tx.query<{
          id: string;
          identity_issuer: string;
          identity_subject: string;
          email: string | null;
          display_name: string | null;
          created_at: Date;
        }>(
          `SELECT id, identity_issuer, identity_subject, email, display_name, created_at
           FROM app_users
           WHERE id = $1;`,
          [user.id]
        );

        return result.rows[0] ?? null;
      });

      if (!record) {
        reply.status(404).send({
          error: {
            code: "USER_NOT_FOUND",
            message: "User record could not be found under current security context.",
          },
        });
        return;
      }

      return {
        data: {
          user: {
            id: record.id,
            identityIssuer: record.identity_issuer,
            identitySubject: record.identity_subject,
            email: record.email,
            displayName: record.display_name,
            createdAt: record.created_at,
          },
        },
      };
    }
  );
}
