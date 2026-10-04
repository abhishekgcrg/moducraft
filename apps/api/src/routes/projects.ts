import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { AuthVerifier } from "../auth/types.js";
import { createAuthHook } from "../auth/middleware.js";
import { withAuthenticatedContext } from "../db/transaction.js";
import { ProjectService } from "../services/project.service.js";
import {
  IdParamSchema,
  CreateProjectSchema,
  UpdateProjectSchema,
  ListProjectsQuerySchema,
  validate,
} from "../validation/schemas.js";

export function registerProjectRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  authVerifier: AuthVerifier
) {
  const authenticate = createAuthHook(authVerifier, pool);
  const projectService = new ProjectService();

  /**
   * POST /api/v1/projects
   * Create a new project within a specified organization.
   * Enforces role (owner, admin, member), derives created_by from verified identity,
   * checks slug uniqueness, and atomically records an audit event.
   */
  app.post(
    "/api/v1/projects",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const body = validate(CreateProjectSchema, req.body);

      const project = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          return projectService.createProject(tx, user.id, body);
        }
      );

      reply.status(201);
      return {
        data: {
          project,
        },
      };
    }
  );

  /**
   * GET /api/v1/projects
   * List accessible projects under forced RLS.
   * Supports optional organizationId filter and limit/offset pagination.
   */
  app.get(
    "/api/v1/projects",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const query = validate(ListProjectsQuerySchema, req.query);

      const result = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          return projectService.listProjects(tx, user.id, query);
        }
      );

      return {
        data: result,
      };
    }
  );

  /**
   * GET /api/v1/projects/:id
   * Retrieve a single project by ID under forced RLS.
   * Returns 404 for nonexistent or cross-tenant projects.
   */
  app.get(
    "/api/v1/projects/:id",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { id } = validate(IdParamSchema, req.params);

      const project = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          return projectService.getProject(tx, id);
        }
      );

      return {
        data: {
          project,
        },
      };
    }
  );

  /**
   * PATCH /api/v1/projects/:id
   * Update editable fields (name, slug, description) of a project.
   * Enforces role (owner, admin, member), disallows immutable field changes,
   * validates slug uniqueness, and atomically records an audit event.
   */
  app.patch(
    "/api/v1/projects/:id",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { id } = validate(IdParamSchema, req.params);
      const body = validate(UpdateProjectSchema, req.body);

      const project = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          return projectService.updateProject(tx, id, user.id, body);
        }
      );

      return {
        data: {
          project,
        },
      };
    }
  );

  /**
   * DELETE /api/v1/projects/:id
   * Delete a project.
   * Enforces owner/admin role restrictions (members/viewers forbidden)
   * and atomically records an audit event before deletion.
   */
  app.delete(
    "/api/v1/projects/:id",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { id } = validate(IdParamSchema, req.params);

      const result = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          return projectService.deleteProject(tx, id, user.id);
        }
      );

      return {
        data: result,
      };
    }
  );
}
