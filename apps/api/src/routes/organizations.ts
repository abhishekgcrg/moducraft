import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { AuthVerifier } from "../auth/types.js";
import { createAuthHook } from "../auth/middleware.js";
import { withAuthenticatedContext } from "../db/transaction.js";
import { OrganizationService } from "../services/organization.service.js";
import { IdParamSchema, validate } from "../validation/schemas.js";

export function registerOrganizationRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  authVerifier: AuthVerifier
) {
  const authenticate = createAuthHook(authVerifier, pool);
  const organizationService = new OrganizationService();

  /**
   * GET /api/v1/organizations
   * List organizations in which the authenticated user has an active membership,
   * including the user's role.
   */
  app.get(
    "/api/v1/organizations",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;

      const organizations = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          return organizationService.listUserOrganizations(tx, user.id);
        }
      );

      return {
        data: {
          organizations,
        },
      };
    }
  );

  /**
   * GET /api/v1/organizations/:id
   * Retrieve a specific organization by ID. Returns 404 if user has no membership,
   * preventing cross-tenant existence enumeration.
   */
  app.get(
    "/api/v1/organizations/:id",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { id } = validate(IdParamSchema, req.params);

      const organization = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          return organizationService.getOrganization(tx, id, user.id);
        }
      );

      return {
        data: {
          organization,
        },
      };
    }
  );
}
