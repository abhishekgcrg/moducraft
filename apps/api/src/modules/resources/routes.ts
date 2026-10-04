import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { AuthVerifier } from "../../auth/types.js";
import { createAuthHook } from "../../auth/middleware.js";
import { withAuthenticatedContext } from "../../db/transaction.js";
import { validate } from "../../validation/schemas.js";
import { ProjectService } from "../../services/project.service.js";
import { ResourceService } from "./resource.service.js";
import {
  ProjectIdParamSchema,
  ResourceParamsSchema,
  CreateResourceBodySchema,
  ListResourcesQuerySchema,
  RotateCredentialBodySchema,
} from "./schemas.js";

export function registerResourceRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  authVerifier: AuthVerifier
) {
  const authenticate = createAuthHook(authVerifier, pool);
  const projectService = new ProjectService();
  const resourceService = new ResourceService();

  /**
   * POST /api/v1/projects/:projectId/resources
   * Provisions a new cloud resource under project scope.
   * Validates configuration against sensitive keys recursively (SEC-5.2-01).
   * Generates public DTO response without exposing secrets.
   */
  app.post(
    "/api/v1/projects/:projectId/resources",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { projectId } = validate(ProjectIdParamSchema, req.params);
      const body = validate(CreateResourceBodySchema, req.body);

      const resource = await withAuthenticatedContext(pool, user.id, async (tx) => {
        const project = await projectService.getProject(tx, projectId);
        await resourceService.assertOrgRole(tx, project.organizationId, user.id, [
          "owner",
          "admin",
          "member",
        ]);

        const created = await resourceService.createResource(
          tx,
          {
            organizationId: project.organizationId,
            projectId,
            providerId: body.providerId,
            resourceType: body.resourceType,
            name: body.name,
            configuration: body.configuration,
            endpoint: body.endpoint,
          },
          user.id
        );

        if (body.initialPassword) {
          await resourceService.createResourceCredential(
            tx,
            {
              organizationId: project.organizationId,
              projectId,
              resourceId: created.id,
              username: body.username ?? "admin",
              password: body.initialPassword,
              connectionStringTemplate:
                body.connectionStringTemplate ??
                "postgresql://{username}:{password}@127.0.0.1:5432/db",
            },
            user.id
          );
        }

        return created;
      });

      reply.status(201);
      return {
        data: {
          resource,
        },
      };
    }
  );

  /**
   * GET /api/v1/projects/:projectId/resources
   * Lists project resources filtered by optional status/type under forced RLS.
   */
  app.get(
    "/api/v1/projects/:projectId/resources",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { projectId } = validate(ProjectIdParamSchema, req.params);
      const query = validate(ListResourcesQuerySchema, req.query);

      const resources = await withAuthenticatedContext(pool, user.id, async (tx) => {
        const project = await projectService.getProject(tx, projectId);
        return resourceService.listResources(tx, project.organizationId, projectId, query);
      });

      return {
        data: {
          resources,
        },
      };
    }
  );

  /**
   * GET /api/v1/projects/:projectId/resources/:id
   * Retrieves single resource details under forced RLS.
   */
  app.get(
    "/api/v1/projects/:projectId/resources/:id",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { projectId, id } = validate(ResourceParamsSchema, req.params);

      const resource = await withAuthenticatedContext(pool, user.id, async (tx) => {
        const project = await projectService.getProject(tx, projectId);
        return resourceService.getResource(tx, project.organizationId, projectId, id);
      });

      return {
        data: {
          resource,
        },
      };
    }
  );

  /**
   * GET /api/v1/projects/:projectId/resources/:id/credentials
   * Reveals decrypted credential material for an authorized owner/admin.
   * Employs Autonomous Audit Pattern: denied attempts are audited even on rollback.
   */
  app.get(
    "/api/v1/projects/:projectId/resources/:id/credentials",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { projectId, id } = validate(ResourceParamsSchema, req.params);

      // Verify project exists and caller has access under RLS
      let organizationId: string;
      try {
        const project = await withAuthenticatedContext(pool, user.id, async (tx) => {
          return projectService.getProject(tx, projectId);
        });
        organizationId = project.organizationId;
      } catch (err: any) {
        // SEC-5.2-02: Structured security log emitted on cross-tenant probe
        req.log.warn({
          event: "security.cross_tenant_access_attempt",
          actorId: user.id,
          targetProjectId: projectId,
          targetResourceId: id,
          action: "reveal_credentials",
        });
        throw err;
      }

      const credentials = await resourceService.revealResourceCredential(
        pool,
        {
          organizationId,
          projectId,
          resourceId: id,
        },
        user.id
      );

      return {
        data: {
          credentials,
        },
      };
    }
  );

  /**
   * POST /api/v1/projects/:projectId/resources/:id/rotate
   * Atomically rotates credentials using parent row lock and single-active partial unique index.
   */
  app.post(
    "/api/v1/projects/:projectId/resources/:id/rotate",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { projectId, id } = validate(ResourceParamsSchema, req.params);
      const body = validate(RotateCredentialBodySchema, req.body);

      const credential = await withAuthenticatedContext(pool, user.id, async (tx) => {
        const project = await projectService.getProject(tx, projectId);
        return resourceService.rotateResourceCredential(
          tx,
          {
            organizationId: project.organizationId,
            projectId,
            resourceId: id,
            newPassword: body.newPassword,
            username: body.username,
            connectionStringTemplate: body.connectionStringTemplate,
          },
          user.id
        );
      });

      return {
        data: {
          credential,
        },
      };
    }
  );

  /**
   * DELETE /api/v1/projects/:projectId/resources/:id
   * Deprovisions a resource and revokes its active credentials.
   */
  app.delete(
    "/api/v1/projects/:projectId/resources/:id",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { projectId, id } = validate(ResourceParamsSchema, req.params);

      const resource = await withAuthenticatedContext(pool, user.id, async (tx) => {
        const project = await projectService.getProject(tx, projectId);
        return resourceService.deprovisionResource(
          tx,
          {
            organizationId: project.organizationId,
            projectId,
            resourceId: id,
          },
          user.id
        );
      });

      return {
        data: {
          resource,
        },
      };
    }
  );
}
