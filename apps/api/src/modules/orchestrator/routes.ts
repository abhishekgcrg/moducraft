import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { AuthVerifier } from "../../auth/types.js";
import { createAuthHook } from "../../auth/middleware.js";
import { withAuthenticatedContext } from "../../db/transaction.js";
import { IdParamSchema, validate } from "../../validation/schemas.js";
import { AgentOrchestratorService } from "./orchestrator.service.js";
import {
  CreateAgentTaskSchema,
  ListAgentTasksQuerySchema,
  RecoverTasksSchema,
} from "./schemas.js";

export function registerAgentTaskRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  authVerifier: AuthVerifier
) {
  const authenticate = createAuthHook(authVerifier, pool);
  const orchestratorService = new AgentOrchestratorService();

  /**
   * POST /api/v1/agent-tasks
   * Create a new agent task, deterministically plan steps, and record initial events.
   */
  app.post(
    "/api/v1/agent-tasks",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const body = validate(CreateAgentTaskSchema, req.body);

      const task = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          return orchestratorService.createTask(tx, user.id, body);
        }
      );

      reply.status(201);
      return {
        data: {
          task,
        },
      };
    }
  );

  /**
   * GET /api/v1/agent-tasks
   * List tasks within caller's authorized tenant scope under forced RLS.
   */
  app.get(
    "/api/v1/agent-tasks",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const query = validate(ListAgentTasksQuerySchema, req.query);

      const result = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          return orchestratorService.listTasks(tx, user.id, query);
        }
      );

      return {
        data: result,
      };
    }
  );

  /**
   * POST /api/v1/agent-tasks/recover
   * Bounded recovery for interrupted tasks in an organization (owner/admin only).
   * Registered before /:id to avoid route collision.
   */
  app.post(
    "/api/v1/agent-tasks/recover",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const body = validate(RecoverTasksSchema, req.body);

      const result = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          return orchestratorService.recoverInterruptedTasks(
            tx,
            body.organizationId,
            user.id,
            body.limit
          );
        }
      );

      return {
        data: result,
      };
    }
  );

  /**
   * GET /api/v1/agent-tasks/:id
   * Retrieve task details, ordered steps, and events under forced RLS.
   */
  app.get(
    "/api/v1/agent-tasks/:id",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { id } = validate(IdParamSchema, req.params);

      const task = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          return orchestratorService.getTask(tx, id);
        }
      );

      return {
        data: {
          task,
        },
      };
    }
  );

  /**
   * POST /api/v1/agent-tasks/:id/run
   * Idempotently execute ready step and transition task states.
   */
  app.post(
    "/api/v1/agent-tasks/:id/run",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { id } = validate(IdParamSchema, req.params);

      const task = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          return orchestratorService.runTask(tx, id, user.id);
        }
      );

      return {
        data: {
          task,
        },
      };
    }
  );

  /**
   * POST /api/v1/agent-tasks/:id/retry
   * Retry a failed task's eligible step under strict max_attempts limits.
   */
  app.post(
    "/api/v1/agent-tasks/:id/retry",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { id } = validate(IdParamSchema, req.params);

      const task = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          return orchestratorService.retryTask(tx, id, user.id);
        }
      );

      return {
        data: {
          task,
        },
      };
    }
  );

  /**
   * POST /api/v1/agent-tasks/:id/cancel
   * Cancel an active or queued task, preventing further step execution.
   */
  app.post(
    "/api/v1/agent-tasks/:id/cancel",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { id } = validate(IdParamSchema, req.params);

      const task = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          return orchestratorService.cancelTask(tx, id, user.id);
        }
      );

      return {
        data: {
          task,
        },
      };
    }
  );

  /**
   * POST /api/v1/agent-tasks/:id/approve
   * Explicit authorization/approval hook for tasks in waiting_for_approval state.
   */
  app.post(
    "/api/v1/agent-tasks/:id/approve",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { id } = validate(IdParamSchema, req.params);

      const task = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          return orchestratorService.approveTask(tx, id, user.id);
        }
      );

      return {
        data: {
          task,
        },
      };
    }
  );
}
