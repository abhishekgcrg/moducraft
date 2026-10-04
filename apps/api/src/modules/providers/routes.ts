import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { AuthVerifier } from "../../auth/types.js";
import { createAuthHook } from "../../auth/middleware.js";
import { withAuthenticatedContext } from "../../db/transaction.js";
import { IdParamSchema, validate } from "../../validation/schemas.js";
import { AIProviderService } from "./provider.service.js";
import {
  CreateProviderConfigSchema,
  UpdateProviderConfigSchema,
  ListProviderConfigsQuerySchema,
} from "./schemas.js";

export function registerProviderConfigRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  authVerifier: AuthVerifier
) {
  const authenticate = createAuthHook(authVerifier, pool);
  const providerService = new AIProviderService();

  /**
   * POST /api/v1/provider-configs
   * Create a new AI provider configuration with an encrypted secret.
   */
  app.post(
    "/api/v1/provider-configs",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const body = validate(CreateProviderConfigSchema, req.body);

      const config = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          return providerService.createProviderConfig(tx, user.id, body);
        }
      );

      reply.status(201);
      return {
        data: {
          providerConfig: config,
        },
      };
    }
  );

  /**
   * GET /api/v1/provider-configs
   * List provider configurations for caller's organization under forced RLS.
   */
  app.get(
    "/api/v1/provider-configs",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const query = validate(ListProviderConfigsQuerySchema, req.query);

      const configs = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          return providerService.listProviderConfigs(tx, query.organizationId, user.id);
        }
      );

      return {
        data: {
          providerConfigs: configs,
        },
      };
    }
  );

  /**
   * GET /api/v1/provider-configs/:id
   * Retrieve a single provider configuration under forced RLS.
   */
  app.get(
    "/api/v1/provider-configs/:id",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { id } = validate(IdParamSchema, req.params);

      const config = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          return providerService.getProviderConfig(tx, id, user.id);
        }
      );

      return {
        data: {
          providerConfig: config,
        },
      };
    }
  );

  /**
   * PATCH /api/v1/provider-configs/:id
   * Update configuration fields with optional secret key rotation.
   */
  app.patch(
    "/api/v1/provider-configs/:id",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { id } = validate(IdParamSchema, req.params);
      const body = validate(UpdateProviderConfigSchema, req.body);

      const config = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          return providerService.updateProviderConfig(tx, id, user.id, body);
        }
      );

      return {
        data: {
          providerConfig: config,
        },
      };
    }
  );

  /**
   * DELETE /api/v1/provider-configs/:id
   * Revoke and delete a provider configuration.
   */
  app.delete(
    "/api/v1/provider-configs/:id",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { id } = validate(IdParamSchema, req.params);

      const result = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          return providerService.deleteProviderConfig(tx, id, user.id);
        }
      );

      return {
        data: result,
      };
    }
  );

  /**
   * POST /api/v1/provider-configs/:id/test-connection
   * Test connection to provider without leaking secrets.
   */
  app.post(
    "/api/v1/provider-configs/:id/test-connection",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { id } = validate(IdParamSchema, req.params);

      const result = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          return providerService.testConnection(tx, id, user.id);
        }
      );

      return {
        data: { testResult: result },
      };
    }
  );
}
