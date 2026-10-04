import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { AuthVerifier } from "../../auth/types.js";
import { createAuthHook } from "../../auth/middleware.js";
import { withAuthenticatedContext } from "../../db/transaction.js";
import { IdParamSchema, validate } from "../../validation/schemas.js";
import { NotFoundError } from "../../errors/app-errors.js";
import { ArtifactsService } from "./artifacts.service.js";
import { ApprovalsService } from "./approvals.service.js";
import { ApprovedPatchService } from "./patch.service.js";
import { ToolGateway } from "./tools/gateway.js";
import { AgentWorkflowService } from "./workflow.service.js";
import {
  ProjectIdParamSchema,
  TaskIdParamSchema,
  CreateArtifactSchema,
  ListArtifactsQuerySchema,
  CreateApprovalRequestSchema,
  DecideApprovalSchema,
  StartWorkflowSchema,
  ExecuteToolSchema,
  JournalIdParamSchema,
  AdminRecoverWorkspaceSchema,
  RecoverInterruptedSchema,
  ListPatchJournalsQuerySchema,
} from "./schemas.js";

export function registerWorkflowRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  authVerifier: AuthVerifier
) {
  const authenticate = createAuthHook(authVerifier, pool);

  const artifactsService = new ArtifactsService();
  const approvalsService = new ApprovalsService();
  const patchService = new ApprovedPatchService(approvalsService, artifactsService);
  const toolGateway = new ToolGateway();
  const workflowService = new AgentWorkflowService(
    undefined,
    artifactsService,
    approvalsService,
    toolGateway
  );

  // ---------------------------------------------------------------------------
  // Artifact Endpoints
  // ---------------------------------------------------------------------------

  /**
   * POST /api/v1/projects/:projectId/artifacts
   * Create an immutable artifact under tenant & project bounds.
   */
  app.post(
    "/api/v1/projects/:projectId/artifacts",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { projectId } = validate(ProjectIdParamSchema, req.params);
      const body = validate(CreateArtifactSchema, req.body);

      const artifact = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          const projRes = await tx.query<{ organization_id: string }>(
            `SELECT organization_id FROM projects WHERE id = $1;`,
            [projectId]
          );
          if (projRes.rowCount === 0) throw new NotFoundError("Project");
          const orgId = projRes.rows[0].organization_id;

          return artifactsService.createArtifact(
            tx,
            user.id,
            orgId,
            {
              ...body,
              projectId,
            }
          );
        }
      );

      reply.status(201);
      return { data: { artifact } };
    }
  );

  /**
   * GET /api/v1/projects/:projectId/artifacts
   * List artifacts for an authorized project under forced RLS.
   */
  app.get(
    "/api/v1/projects/:projectId/artifacts",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { projectId } = validate(ProjectIdParamSchema, req.params);
      const query = validate(ListArtifactsQuerySchema, req.query);

      const result = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          const projCheck = await tx.query<{ id: string }>(
            `SELECT id FROM projects WHERE id = $1;`,
            [projectId]
          );
          if (projCheck.rowCount === 0) {
            throw new NotFoundError("Project not found in authorized organization context");
          }

          return artifactsService.listArtifacts(tx, {
            ...query,
            projectId,
          });
        }
      );

      return { data: result };
    }
  );

  /**
   * GET /api/v1/artifacts/:id
   * Retrieve a specific artifact by ID under forced RLS.
   */
  app.get(
    "/api/v1/artifacts/:id",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { id } = validate(IdParamSchema, req.params);

      const artifact = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          return artifactsService.getArtifact(tx, id);
        }
      );

      return { data: { artifact } };
    }
  );

  // ---------------------------------------------------------------------------
  // Hash-Bound Approval Endpoints
  // ---------------------------------------------------------------------------

  /**
   * POST /api/v1/agent-tasks/:taskId/approvals
   * Request an explicit, hash-bound, single-use approval for an action/patch.
   */
  app.post(
    "/api/v1/agent-tasks/:taskId/approvals",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { taskId } = validate(TaskIdParamSchema, req.params);
      const body = validate(CreateApprovalRequestSchema, req.body);

      const approval = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          const taskRes = await tx.query<{ organization_id: string }>(
            `SELECT organization_id FROM agent_tasks WHERE id = $1;`,
            [taskId]
          );
          if (taskRes.rowCount === 0) throw new NotFoundError("Agent task");
          const orgId = taskRes.rows[0].organization_id;

          return approvalsService.createApprovalRequest(
            tx,
            orgId,
            {
              ...body,
              taskId,
            }
          );
        }
      );

      reply.status(201);
      return { data: { approval } };
    }
  );

  /**
   * GET /api/v1/agent-tasks/:taskId/approvals
   * List approvals for a task under forced RLS.
   */
  app.get(
    "/api/v1/agent-tasks/:taskId/approvals",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { taskId } = validate(TaskIdParamSchema, req.params);

      const approvals = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          return approvalsService.listApprovalsForTask(tx, taskId);
        }
      );

      return { data: { approvals } };
    }
  );

  /**
   * POST /api/v1/approvals/:id/decide
   * Record human decision (approve/reject). Requires owner or admin role.
   */
  app.post(
    "/api/v1/approvals/:id/decide",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { id } = validate(IdParamSchema, req.params);
      const body = validate(DecideApprovalSchema, req.body);

      const approval = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          const appRes = await tx.query<{ organization_id: string }>(
            `SELECT organization_id FROM agent_approvals WHERE id = $1;`,
            [id]
          );
          if (appRes.rowCount === 0) throw new NotFoundError("Agent approval request");
          const orgId = appRes.rows[0].organization_id;

          return approvalsService.decideApproval(
            tx,
            id,
            user.id,
            orgId,
            body
          );
        }
      );

      return { data: { approval } };
    }
  );

  // ---------------------------------------------------------------------------
  // Multi-Agent Workflow Pipeline Endpoints
  // ---------------------------------------------------------------------------

  /**
   * POST /api/v1/workflows/start
   * Start multi-agent pipeline and generate execution plan.
   */
  app.post(
    "/api/v1/workflows/start",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const body = validate(StartWorkflowSchema, req.body);

      const summary = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          const projRes = await tx.query<{ organization_id: string }>(
            `SELECT organization_id FROM projects WHERE id = $1;`,
            [body.projectId]
          );
          if (projRes.rowCount === 0) throw new NotFoundError("Project");
          const orgId = projRes.rows[0].organization_id;

          return workflowService.startWorkflow(
            tx,
            user.id,
            orgId,
            body
          );
        }
      );

      reply.status(201);
      return { data: summary };
    }
  );

  /**
   * POST /api/v1/workflows/:taskId/advance
   * Advance pipeline through coding, testing, review, and pause at approval gate.
   */
  app.post(
    "/api/v1/workflows/:taskId/advance",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { taskId } = validate(TaskIdParamSchema, req.params);

      const summary = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          const taskRes = await tx.query<{ organization_id: string }>(
            `SELECT organization_id FROM agent_tasks WHERE id = $1;`,
            [taskId]
          );
          if (taskRes.rowCount === 0) throw new NotFoundError("Agent task");
          const orgId = taskRes.rows[0].organization_id;

          return workflowService.advanceWorkflow(
            tx,
            taskId,
            user.id,
            orgId
          );
        }
      );

      return { data: summary };
    }
  );

  /**
   * POST /api/v1/workflows/:taskId/complete
   * Finalize pipeline after approval: verify approval hash, generate docs, mark succeeded.
   */
  app.post(
    "/api/v1/workflows/:taskId/complete",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { taskId } = validate(TaskIdParamSchema, req.params);

      const summary = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          const taskRes = await tx.query<{ organization_id: string }>(
            `SELECT organization_id FROM agent_tasks WHERE id = $1;`,
            [taskId]
          );
          if (taskRes.rowCount === 0) throw new NotFoundError("Agent task");
          const orgId = taskRes.rows[0].organization_id;

          return workflowService.completeWorkflowAfterApproval(
            tx,
            taskId,
            user.id,
            orgId
          );
        }
      );

      return { data: summary };
    }
  );

  // ---------------------------------------------------------------------------
  // Controlled Tool Gateway Endpoints
  // ---------------------------------------------------------------------------

  /**
   * GET /api/v1/workflows/tools
   * List allowed tool capabilities, descriptions, and schemas.
   */
  app.get(
    "/api/v1/workflows/tools",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const tools = toolGateway.listTools();
      return { data: { tools } };
    }
  );

  /**
   * POST /api/v1/workflows/tools/execute
   * Invoke an allowlisted tool under strict capability and quota controls.
   */
  app.post(
    "/api/v1/workflows/tools/execute",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const body = validate(ExecuteToolSchema, req.body);

      const response = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          const projRes = await tx.query<{ organization_id: string }>(
            `SELECT organization_id FROM projects WHERE id = $1;`,
            [body.projectId]
          );
          if (projRes.rowCount === 0) throw new NotFoundError("Project");
          const orgId = projRes.rows[0].organization_id;

          return toolGateway.executeTool(tx, {
            toolName: body.toolName,
            organizationId: orgId,
            projectId: body.projectId,
            taskId: body.taskId,
            stepId: body.stepId,
            userId: user.id,
            parameters: body.parameters,
          });
        }
      );

      return { data: response };
    }
  );

  // ---------------------------------------------------------------------------
  // Patch Journal & Workspace Recovery Endpoints
  // ---------------------------------------------------------------------------

  /**
   * GET /api/v1/projects/:projectId/patch-journals
   * List patch application journals for an authorized project under forced RLS.
   */
  app.get(
    "/api/v1/projects/:projectId/patch-journals",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { projectId } = validate(ProjectIdParamSchema, req.params);
      const query = validate(ListPatchJournalsQuerySchema, req.query);

      const journals = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          const projCheck = await tx.query<{ organization_id: string }>(
            `SELECT organization_id FROM projects WHERE id = $1;`,
            [projectId]
          );
          if (projCheck.rowCount === 0) {
            throw new NotFoundError("Project not found in authorized organization context");
          }
          const orgId = projCheck.rows[0].organization_id;

          return patchService.listJournals(tx, orgId, projectId, query);
        }
      );

      return { data: { journals } };
    }
  );

  /**
   * GET /api/v1/projects/:projectId/patch-journals/:journalId
   * Retrieve a specific patch journal entry by ID under forced RLS.
   */
  app.get(
    "/api/v1/projects/:projectId/patch-journals/:journalId",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { projectId, journalId } = validate(JournalIdParamSchema, req.params);

      const journal = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          const projCheck = await tx.query<{ organization_id: string }>(
            `SELECT organization_id FROM projects WHERE id = $1;`,
            [projectId]
          );
          if (projCheck.rowCount === 0) {
            throw new NotFoundError("Project not found in authorized organization context");
          }
          const orgId = projCheck.rows[0].organization_id;

          const res = await patchService.getJournal(tx, orgId, journalId);
          if (!res) {
            throw new NotFoundError("Patch application journal not found in tenant");
          }
          return res;
        }
      );

      return { data: { journal } };
    }
  );

  /**
   * POST /api/v1/projects/:projectId/patch-journals/:journalId/recover
   * Perform administrative recovery on a fenced or stalled workspace.
   * Requires owner or admin role.
   */
  app.post(
    "/api/v1/projects/:projectId/patch-journals/:journalId/recover",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { projectId, journalId } = validate(JournalIdParamSchema, req.params);
      const body = validate(AdminRecoverWorkspaceSchema, req.body);

      const result = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          const projCheck = await tx.query<{ organization_id: string }>(
            `SELECT organization_id FROM projects WHERE id = $1;`,
            [projectId]
          );
          if (projCheck.rowCount === 0) {
            throw new NotFoundError("Project not found in authorized organization context");
          }
          const orgId = projCheck.rows[0].organization_id;

          return patchService.adminRecoverWorkspace(
            tx,
            {
              journalId,
              projectId,
              resolution: body.resolution,
              reason: body.reason,
              force: body.force,
            },
            user.id,
            orgId
          );
        }
      );

      return { data: result };
    }
  );

  /**
   * POST /api/v1/projects/:projectId/recover-interrupted
   * Resumes or recovers an interrupted patch application.
   */
  app.post(
    "/api/v1/projects/:projectId/recover-interrupted",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { projectId } = validate(ProjectIdParamSchema, req.params);
      const body = validate(RecoverInterruptedSchema, req.body);

      const result = await withAuthenticatedContext(
        pool,
        user.id,
        async (tx) => {
          const projCheck = await tx.query<{ organization_id: string }>(
            `SELECT organization_id FROM projects WHERE id = $1;`,
            [projectId]
          );
          if (projCheck.rowCount === 0) {
            throw new NotFoundError("Project not found in authorized organization context");
          }
          const orgId = projCheck.rows[0].organization_id;

          return patchService.recoverInterruptedPatchApplication(
            tx,
            {
              taskId: body.taskId,
              projectId,
              patchArtifactId: body.patchArtifactId,
              expectedHash: body.expectedHash,
            },
            user.id,
            orgId
          );
        }
      );

      return { data: result };
    }
  );
}
