import type { ScopedTransaction } from "../../db/transaction.js";
import {
  NotFoundError,
  ForbiddenError,
  ConflictError,
  ValidationError,
} from "../../errors/app-errors.js";
import {
  type AgentTaskDto,
  type AgentTaskStepDto,
  type AgentTaskEventDto,
  type CreateAgentTaskInput,
  type AgentEventType,
} from "./types.js";
import { OrchestratorStateMachine } from "./state-machine.js";
import { DeterministicTaskPlanner } from "./planner.js";
import { SafePlaceholderExecutor, type StepExecutionResult } from "./executor.js";
import { AIProviderService } from "../providers/provider.service.js";

interface TaskRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  provider_config_id: string | null;
  created_by: string;
  task_type: string;
  title: string;
  input_summary: string | null;
  input_data: Record<string, unknown>;
  status: string;
  current_step_key: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
}

interface StepRow {
  id: string;
  task_id: string;
  organization_id: string;
  step_key: string;
  step_type: string;
  position: number;
  status: string;
  input_data: Record<string, unknown>;
  result_data: Record<string, unknown>;
  error_code: string | null;
  error_message: string | null;
  attempt_count: number;
  max_attempts: number;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

interface EventRow {
  id: string;
  task_id: string;
  organization_id: string;
  step_id: string | null;
  event_type: string;
  actor_user_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

interface OrgRoleRow {
  role: "owner" | "admin" | "member" | "viewer";
}

const SENSITIVE_KEY_REGEX = /password|secret|token|apikey|authorization|cookie|jwt|private_key/i;

function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (SENSITIVE_KEY_REGEX.test(key)) {
      sanitized[key] = "[REDACTED]";
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      sanitized[key] = sanitizeMetadata(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export class AgentOrchestratorService {
  constructor(private readonly providerService: AIProviderService = new AIProviderService()) {}

  private mapTask(row: TaskRow, steps?: AgentTaskStepDto[], events?: AgentTaskEventDto[]): AgentTaskDto {
    return {
      id: row.id,
      organizationId: row.organization_id,
      projectId: row.project_id,
      providerConfigId: row.provider_config_id,
      createdBy: row.created_by,
      taskType: row.task_type,
      title: row.title,
      inputSummary: row.input_summary,
      inputData: row.input_data,
      status: row.status as AgentTaskDto["status"],
      currentStepKey: row.current_step_key,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      cancelledAt: row.cancelled_at,
      steps,
      events,
    };
  }

  private mapStep(row: StepRow): AgentTaskStepDto {
    return {
      id: row.id,
      taskId: row.task_id,
      organizationId: row.organization_id,
      stepKey: row.step_key,
      stepType: row.step_type,
      position: row.position,
      status: row.status as AgentTaskStepDto["status"],
      inputData: row.input_data,
      resultData: row.result_data,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  }

  private mapEvent(row: EventRow): AgentTaskEventDto {
    return {
      id: row.id,
      taskId: row.task_id,
      organizationId: row.organization_id,
      stepId: row.step_id,
      eventType: row.event_type as AgentEventType,
      actorUserId: row.actor_user_id,
      metadata: row.metadata,
      createdAt: row.created_at,
    };
  }

  private async assertOrgRole(
    tx: ScopedTransaction,
    orgId: string,
    userId: string,
    allowedRoles: string[]
  ): Promise<OrgRoleRow["role"]> {
    const roleResult = await tx.query<OrgRoleRow>(
      `SELECT role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2;`,
      [orgId, userId]
    );

    const membership = roleResult.rows[0];
    if (!membership) {
      throw new NotFoundError("Organization");
    }

    if (!allowedRoles.includes(membership.role)) {
      throw new ForbiddenError(
        `Action requires one of the following roles: ${allowedRoles.join(", ")}. Current role: '${membership.role}'.`
      );
    }

    return membership.role;
  }

  private async recordEvent(
    tx: ScopedTransaction,
    taskId: string,
    organizationId: string,
    eventType: AgentEventType,
    actorUserId: string | null,
    stepId: string | null = null,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    const cleanMetadata = sanitizeMetadata(metadata);
    await tx.query(
      `INSERT INTO agent_task_events (task_id, organization_id, step_id, event_type, actor_user_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb);`,
      [taskId, organizationId, stepId, eventType, actorUserId, JSON.stringify(cleanMetadata)]
    );
  }

  /**
   * Create a new agent task, deterministically plan ordered steps,
   * record lifecycle events, and record an atomic audit event.
   */
  async createTask(
    tx: ScopedTransaction,
    userId: string,
    input: CreateAgentTaskInput
  ): Promise<AgentTaskDto> {
    // 1. Verify organization authorization (viewer denied)
    await this.assertOrgRole(tx, input.organizationId, userId, ["owner", "admin", "member"]);

    // 2. If projectId provided, verify tenant consistency
    if (input.projectId) {
      const projResult = await tx.query<{ id: string }>(
        `SELECT id FROM projects WHERE id = $1 AND organization_id = $2;`,
        [input.projectId, input.organizationId]
      );
      if (projResult.rows.length === 0) {
        throw new NotFoundError("Project");
      }
    }

    // 2b. If providerConfigId provided, verify tenant consistency and enabled status
    if (input.providerConfigId) {
      const configRes = await tx.query<{ id: string; is_enabled: boolean }>(
        `SELECT id, is_enabled FROM provider_configs WHERE id = $1 AND organization_id = $2;`,
        [input.providerConfigId, input.organizationId]
      );
      if (configRes.rows.length === 0) {
        throw new NotFoundError("Provider configuration");
      }
      if (!configRes.rows[0].is_enabled) {
        throw new ValidationError("Selected provider configuration is disabled.");
      }
    } else if (input.taskType === "ai_text_generation") {
      throw new ValidationError("Task type 'ai_text_generation' requires an explicit, enabled provider configuration.");
    }

    // 3. Generate deterministic plan
    const plan = DeterministicTaskPlanner.plan(input.taskType, input.title, input.inputData ?? {});

    // 4. Insert task record
    const taskInsert = await tx.query<TaskRow>(
      `INSERT INTO agent_tasks (
         organization_id, project_id, provider_config_id, created_by, task_type, title,
         input_summary, input_data, status, current_step_key, version
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'queued', $9, 1)
       RETURNING *;`,
      [
        input.organizationId,
        input.projectId ?? null,
        input.providerConfigId ?? null,
        userId,
        input.taskType,
        input.title,
        plan.summary,
        JSON.stringify(input.inputData ?? {}),
        plan.steps[0]?.stepKey ?? null,
      ]
    );
    const taskRow = taskInsert.rows[0];

    // 5. Insert ordered steps (first step is ready, remaining are pending)
    const stepDtos: AgentTaskStepDto[] = [];
    for (const stepDef of plan.steps) {
      const initialStepStatus = stepDef.position === 1 ? "ready" : "pending";
      const stepInsert = await tx.query<StepRow>(
        `INSERT INTO agent_task_steps (
           task_id, organization_id, step_key, step_type, position,
           status, input_data, result_data, attempt_count, max_attempts
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, '{}'::jsonb, 0, $8)
         RETURNING *;`,
        [
          taskRow.id,
          taskRow.organization_id,
          stepDef.stepKey,
          stepDef.stepType,
          stepDef.position,
          initialStepStatus,
          JSON.stringify(stepDef.inputData),
          stepDef.maxAttempts ?? 3,
        ]
      );
      stepDtos.push(this.mapStep(stepInsert.rows[0]));
    }

    // 6. Record lifecycle events
    await this.recordEvent(tx, taskRow.id, taskRow.organization_id, "task.created", userId, null, {
      taskType: taskRow.task_type,
      title: taskRow.title,
    });

    await this.recordEvent(tx, taskRow.id, taskRow.organization_id, "task.planned", userId, null, {
      stepsCount: plan.steps.length,
      firstStepKey: plan.steps[0]?.stepKey,
    });

    // 7. Record atomic audit event
    await tx.query(
      `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
      [
        taskRow.organization_id,
        "agent_task.created",
        "agent_task",
        taskRow.id,
        "success",
        JSON.stringify({
          taskType: taskRow.task_type,
          title: taskRow.title,
          stepsCount: plan.steps.length,
        }),
      ]
    );

    return this.mapTask(taskRow, stepDtos);
  }

  /**
   * List tasks within caller's authorized tenant scope under forced RLS.
   */
  async listTasks(
    tx: ScopedTransaction,
    _userId: string,
    filter: {
      organizationId?: string;
      projectId?: string;
      status?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<{ tasks: AgentTaskDto[]; pagination: { total: number; limit: number; offset: number } }> {
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);
    const offset = Math.max(filter.offset ?? 0, 0);

    const countRes = await tx.query<{ total: string }>(
      `SELECT count(*)::text AS total
       FROM agent_tasks
       WHERE ($1::uuid IS NULL OR organization_id = $1)
         AND ($2::uuid IS NULL OR project_id = $2)
         AND ($3::text IS NULL OR status = $3);`,
      [filter.organizationId ?? null, filter.projectId ?? null, filter.status ?? null]
    );
    const total = parseInt(countRes.rows[0]?.total ?? "0", 10);

    const listRes = await tx.query<TaskRow>(
      `SELECT *
       FROM agent_tasks
       WHERE ($1::uuid IS NULL OR organization_id = $1)
         AND ($2::uuid IS NULL OR project_id = $2)
         AND ($3::text IS NULL OR status = $3)
       ORDER BY created_at DESC
       LIMIT $4 OFFSET $5;`,
      [filter.organizationId ?? null, filter.projectId ?? null, filter.status ?? null, limit, offset]
    );

    return {
      tasks: listRes.rows.map((row) => this.mapTask(row)),
      pagination: { total, limit, offset },
    };
  }

  /**
   * Retrieve task details, ordered steps, and events under forced RLS.
   */
  async getTask(tx: ScopedTransaction, taskId: string): Promise<AgentTaskDto> {
    const taskRes = await tx.query<TaskRow>(
      `SELECT * FROM agent_tasks WHERE id = $1;`,
      [taskId]
    );
    const taskRow = taskRes.rows[0];
    if (!taskRow) {
      throw new NotFoundError("Agent task");
    }

    const stepsRes = await tx.query<StepRow>(
      `SELECT * FROM agent_task_steps WHERE task_id = $1 ORDER BY position ASC;`,
      [taskId]
    );

    const eventsRes = await tx.query<EventRow>(
      `SELECT * FROM agent_task_events WHERE task_id = $1 ORDER BY created_at ASC;`,
      [taskId]
    );

    return this.mapTask(
      taskRow,
      stepsRes.rows.map((s) => this.mapStep(s)),
      eventsRes.rows.map((e) => this.mapEvent(e))
    );
  }

  /**
   * Execute ready steps idempotently and transition task states.
   * Employs row locking (FOR UPDATE) for concurrency control.
   */
  async runTask(tx: ScopedTransaction, taskId: string, userId: string): Promise<AgentTaskDto> {
    // 1. Lock task row
    const taskRes = await tx.query<TaskRow>(
      `SELECT * FROM agent_tasks WHERE id = $1 FOR UPDATE;`,
      [taskId]
    );
    const task = taskRes.rows[0];
    if (!task) {
      throw new NotFoundError("Agent task");
    }

    // 2. Verify authorization
    await this.assertOrgRole(tx, task.organization_id, userId, ["owner", "admin", "member"]);

    // 3. Check task state
    if (task.status === "succeeded") {
      return this.getTask(tx, taskId); // Idempotent success
    }
    if (task.status === "cancelled") {
      throw new ConflictError("Cannot run a cancelled task.");
    }
    if (task.status === "failed") {
      throw new ConflictError("Task is in failed state. Use the retry endpoint to recover eligible steps.");
    }

    // Transition task to running if queued or planning
    if (task.status === "queued" || task.status === "planning") {
      OrchestratorStateMachine.assertValidTaskTransition(task.status as any, "running");
      await tx.query(
        `UPDATE agent_tasks
         SET status = 'running', started_at = COALESCE(started_at, now()), version = version + 1
         WHERE id = $1;`,
        [taskId]
      );
      await this.recordEvent(tx, taskId, task.organization_id, "task.started", userId);
    }

    // 4. Fetch steps with lock
    const stepsRes = await tx.query<StepRow>(
      `SELECT * FROM agent_task_steps WHERE task_id = $1 ORDER BY position ASC FOR UPDATE;`,
      [taskId]
    );
    const steps = stepsRes.rows;

    // Find first ready step
    const currentStep = steps.find((s) => s.status === "ready");

    if (!currentStep) {
      // Check if all steps succeeded
      const allSucceeded = steps.every((s) => s.status === "succeeded");
      if (allSucceeded && task.status !== "succeeded") {
        await tx.query(
          `UPDATE agent_tasks
           SET status = 'succeeded', completed_at = now(), version = version + 1
           WHERE id = $1;`,
          [taskId]
        );
        await this.recordEvent(tx, taskId, task.organization_id, "task.succeeded", userId);
        await tx.query(
          `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
          [task.organization_id, "agent_task.completed", "agent_task", taskId, "success", "{}" as any]
        );
      }
      return this.getTask(tx, taskId);
    }

    // 4b. Check if step requires explicit approval before running (approval hook)
    const isApproved = (currentStep.result_data as any)?.approved === true;
    if (currentStep.input_data.requiresApproval === true && !isApproved) {
      await tx.query(
        `UPDATE agent_tasks SET status = 'waiting_for_approval', version = version + 1 WHERE id = $1;`,
        [taskId]
      );
      await this.recordEvent(tx, taskId, task.organization_id, "step.started", userId, currentStep.id, {
        stepKey: currentStep.step_key,
        status: "waiting_for_approval",
        reason: "Requires explicit owner/admin approval before execution.",
      });
      return this.getTask(tx, taskId);
    }

    // 5. Mark step as running and record attempt
    await tx.query(
      `UPDATE agent_task_steps
       SET status = 'running', started_at = now(), attempt_count = attempt_count + 1
       WHERE id = $1;`,
      [currentStep.id]
    );
    await this.recordEvent(tx, taskId, task.organization_id, "step.started", userId, currentStep.id, {
      stepKey: currentStep.step_key,
      attempt: currentStep.attempt_count + 1,
    });

    // 6. Execute step via safe local placeholder executor OR AI provider adapter
    let execResult: StepExecutionResult;

    if (currentStep.step_type === "ai_chat_completion") {
      if (!task.provider_config_id) {
        execResult = {
          success: false,
          errorCode: "PROVIDER_CONFIG_REQUIRED",
          errorMessage: "AI step requires an authorized provider configuration attached to the task.",
        };
      } else {
        try {
          const messages = Array.isArray(currentStep.input_data.messages)
            ? (currentStep.input_data.messages as any[])
            : [{ role: "user", content: String(currentStep.input_data.prompt ?? task.title) }];

          const aiResponse = await this.providerService.executeChatCompletion(
            tx,
            task.provider_config_id,
            {
              messages,
              maxTokens: typeof currentStep.input_data.maxTokens === "number" ? currentStep.input_data.maxTokens : undefined,
              temperature: typeof currentStep.input_data.temperature === "number" ? currentStep.input_data.temperature : undefined,
            },
            taskId,
            currentStep.id
          );

          execResult = {
            success: true,
            resultData: {
              content: aiResponse.content,
              model: aiResponse.model,
              usage: aiResponse.usage,
              finishReason: aiResponse.finishReason,
            },
          };
        } catch (err: any) {
          execResult = {
            success: false,
            errorCode: err.code || "AI_EXECUTION_FAILED",
            errorMessage: err.message || "Failed to execute AI provider completion.",
          };
        }
      }
    } else {
      execResult = await SafePlaceholderExecutor.executeStep(
        currentStep.step_type,
        currentStep.step_key,
        currentStep.input_data
      );
    }

    if (execResult.success) {
      // Mark step succeeded
      await tx.query(
        `UPDATE agent_task_steps
         SET status = 'succeeded', result_data = $2::jsonb, completed_at = now()
         WHERE id = $1;`,
        [currentStep.id, JSON.stringify(execResult.resultData ?? {})]
      );
      await this.recordEvent(tx, taskId, task.organization_id, "step.succeeded", userId, currentStep.id, {
        stepKey: currentStep.step_key,
      });

      // Find next step in sequence
      const nextStep = steps.find((s) => s.position === currentStep.position + 1);
      if (nextStep) {
        await tx.query(
          `UPDATE agent_task_steps SET status = 'ready' WHERE id = $1;`,
          [nextStep.id]
        );
        await tx.query(
          `UPDATE agent_tasks SET current_step_key = $2, version = version + 1 WHERE id = $1;`,
          [taskId, nextStep.step_key]
        );
      } else {
        // All steps completed!
        await tx.query(
          `UPDATE agent_tasks
           SET status = 'succeeded', completed_at = now(), current_step_key = null, version = version + 1
           WHERE id = $1;`,
          [taskId]
        );
        await this.recordEvent(tx, taskId, task.organization_id, "task.succeeded", userId);
        await tx.query(
          `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
          [task.organization_id, "agent_task.completed", "agent_task", taskId, "success", "{}" as any]
        );
      }
    } else {
      // Step failed!
      await tx.query(
        `UPDATE agent_task_steps
         SET status = 'failed', error_code = $2, error_message = $3
         WHERE id = $1;`,
        [currentStep.id, execResult.errorCode ?? "STEP_FAILED", execResult.errorMessage ?? "Step execution failed."]
      );
      await this.recordEvent(tx, taskId, task.organization_id, "step.failed", userId, currentStep.id, {
        stepKey: currentStep.step_key,
        errorCode: execResult.errorCode,
        errorMessage: execResult.errorMessage,
      });

      // Mark task failed
      await tx.query(
        `UPDATE agent_tasks
         SET status = 'failed', version = version + 1
         WHERE id = $1;`,
        [taskId]
      );
      await this.recordEvent(tx, taskId, task.organization_id, "task.failed", userId, currentStep.id, {
        failedStepKey: currentStep.step_key,
      });
      await tx.query(
        `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
        [
          task.organization_id,
          "agent_task.failed",
          "agent_task",
          taskId,
          "failure",
          JSON.stringify({ failedStepKey: currentStep.step_key }),
        ]
      );
    }

    return this.getTask(tx, taskId);
  }

  /**
   * Retry a failed task's eligible step under strict max_attempts limits.
   */
  async retryTask(tx: ScopedTransaction, taskId: string, userId: string): Promise<AgentTaskDto> {
    const taskRes = await tx.query<TaskRow>(
      `SELECT * FROM agent_tasks WHERE id = $1 FOR UPDATE;`,
      [taskId]
    );
    const task = taskRes.rows[0];
    if (!task) {
      throw new NotFoundError("Agent task");
    }

    await this.assertOrgRole(tx, task.organization_id, userId, ["owner", "admin", "member"]);

    if (task.status !== "failed") {
      throw new ConflictError(`Only failed tasks can be retried. Current status is '${task.status}'.`);
    }

    const failedStepRes = await tx.query<StepRow>(
      `SELECT * FROM agent_task_steps WHERE task_id = $1 AND status = 'failed' LIMIT 1 FOR UPDATE;`,
      [taskId]
    );
    const failedStep = failedStepRes.rows[0];
    if (!failedStep) {
      throw new ConflictError("No failed step found in this task to retry.");
    }

    if (failedStep.attempt_count >= failedStep.max_attempts) {
      throw new ValidationError(
        `Step '${failedStep.step_key}' has reached its maximum attempt limit (${failedStep.max_attempts}). Cannot retry.`
      );
    }

    // Reset step to ready and clear previous error
    await tx.query(
      `UPDATE agent_task_steps
       SET status = 'ready', error_code = null, error_message = null
       WHERE id = $1;`,
      [failedStep.id]
    );

    // Transition task back to running
    await tx.query(
      `UPDATE agent_tasks
       SET status = 'running', current_step_key = $2, version = version + 1
       WHERE id = $1;`,
      [taskId, failedStep.step_key]
    );

    await this.recordEvent(tx, taskId, task.organization_id, "step.retried", userId, failedStep.id, {
      stepKey: failedStep.step_key,
      attemptsRemaining: failedStep.max_attempts - failedStep.attempt_count,
    });

    await tx.query(
      `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
      [
        task.organization_id,
        "agent_task.retried",
        "agent_task",
        taskId,
        "success",
        JSON.stringify({ retriedStepKey: failedStep.step_key }),
      ]
    );

    return this.getTask(tx, taskId);
  }

  /**
   * Cancel an active or queued task, preventing any further step execution.
   */
  async cancelTask(tx: ScopedTransaction, taskId: string, userId: string): Promise<AgentTaskDto> {
    const taskRes = await tx.query<TaskRow>(
      `SELECT * FROM agent_tasks WHERE id = $1 FOR UPDATE;`,
      [taskId]
    );
    const task = taskRes.rows[0];
    if (!task) {
      throw new NotFoundError("Agent task");
    }

    await this.assertOrgRole(tx, task.organization_id, userId, ["owner", "admin", "member"]);

    if (task.status === "cancelled") {
      return this.getTask(tx, taskId); // Idempotent
    }

    if (task.status === "succeeded") {
      throw new ConflictError("Cannot cancel an already succeeded task.");
    }

    OrchestratorStateMachine.assertValidTaskTransition(task.status as any, "cancelled");

    await tx.query(
      `UPDATE agent_tasks
       SET status = 'cancelled', cancelled_at = now(), version = version + 1
       WHERE id = $1;`,
      [taskId]
    );

    // Cancel pending, ready, or running steps
    await tx.query(
      `UPDATE agent_task_steps
       SET status = 'cancelled'
       WHERE task_id = $1 AND status IN ('pending', 'ready', 'running');`,
      [taskId]
    );

    // Invalidate pending and approved approvals for the cancelled task
    await tx.query(
      `UPDATE agent_approvals
       SET status = 'expired', updated_at = now()
       WHERE task_id = $1 AND status IN ('pending', 'approved');`,
      [taskId]
    );

    await this.recordEvent(tx, taskId, task.organization_id, "task.cancelled", userId);

    await tx.query(
      `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
      [
        task.organization_id,
        "agent_task.cancelled",
        "agent_task",
        taskId,
        "success",
        "{}" as any,
      ]
    );

    return this.getTask(tx, taskId);
  }

  /**
   * Bounded recovery mechanism for tasks interrupted during execution.
   * Resets interrupted steps back to ready (if attempts remain) or failed.
   */
  async recoverInterruptedTasks(
    tx: ScopedTransaction,
    organizationId: string,
    userId: string,
    limit = 50
  ): Promise<{ recoveredCount: number }> {
    await this.assertOrgRole(tx, organizationId, userId, ["owner", "admin"]);
    const boundedLimit = Math.min(Math.max(limit, 1), 100);

    const tasksRes = await tx.query<{ id: string }>(
      `SELECT id FROM agent_tasks
       WHERE organization_id = $1 AND status IN ('planning', 'running')
       ORDER BY updated_at ASC
       LIMIT $2
       FOR UPDATE;`,
      [organizationId, boundedLimit]
    );

    let recovered = 0;
    for (const t of tasksRes.rows) {
      const runningStepsRes = await tx.query<StepRow>(
        `SELECT * FROM agent_task_steps WHERE task_id = $1 AND status = 'running' FOR UPDATE;`,
        [t.id]
      );

      let versionBumped = false;
      for (const step of runningStepsRes.rows) {
        if (step.attempt_count < step.max_attempts) {
          await tx.query(
            `UPDATE agent_task_steps SET status = 'ready' WHERE id = $1;`,
            [step.id]
          );
          if (!versionBumped) {
            await tx.query(
              `UPDATE agent_tasks SET version = version + 1 WHERE id = $1;`,
              [t.id]
            );
            versionBumped = true;
          }
        } else {
          await tx.query(
            `UPDATE agent_task_steps
             SET status = 'failed', error_code = 'INTERRUPTED_EXHAUSTED', error_message = 'Task interrupted and max attempts reached'
             WHERE id = $1;`,
            [step.id]
          );
          await tx.query(
            `UPDATE agent_tasks SET status = 'failed', version = version + 1 WHERE id = $1;`,
            [t.id]
          );
          versionBumped = true;
        }
      }

      await this.recordEvent(tx, t.id, organizationId, "task.recovered", userId, null, {
        recoveredAt: new Date().toISOString(),
      });
      recovered++;
    }

    if (recovered > 0) {
      await tx.query(
        `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
        [
          organizationId,
          "agent_tasks.recovered",
          "agent_tasks",
          organizationId,
          "success",
          JSON.stringify({ recoveredCount: recovered }),
        ]
      );
    }

    return { recoveredCount: recovered };
  }

  /**
   * Explicit approval hook for tasks in waiting_for_approval state.
   * Requires owner or admin role. Transitions task to running and marks step approved.
   */
  async approveTask(
    tx: ScopedTransaction,
    taskId: string,
    userId: string
  ): Promise<AgentTaskDto> {
    const lockResult = await tx.query<TaskRow>(
      `SELECT * FROM agent_tasks WHERE id = $1 FOR UPDATE;`,
      [taskId]
    );
    const task = lockResult.rows[0];
    if (!task) {
      throw new NotFoundError("Agent task");
    }

    await this.assertOrgRole(tx, task.organization_id, userId, ["owner", "admin"]);

    if (task.status !== "waiting_for_approval") {
      throw new ConflictError(
        `Cannot approve task in '${task.status}' state. Only 'waiting_for_approval' tasks can be approved.`
      );
    }

    OrchestratorStateMachine.assertValidTaskTransition("waiting_for_approval", "running");

    await tx.query(
      `UPDATE agent_tasks SET status = 'running', version = version + 1 WHERE id = $1;`,
      [taskId]
    );

    if (task.current_step_key) {
      await tx.query(
        `UPDATE agent_task_steps
         SET result_data = result_data || jsonb_build_object('approved', true, 'approvedBy', $2::text, 'approvedAt', now()::text)
         WHERE task_id = $1 AND step_key = $3;`,
        [taskId, userId, task.current_step_key]
      );
    }

    await this.recordEvent(tx, taskId, task.organization_id, "task.started", userId, null, {
      approvedBy: userId,
      resumedAt: new Date().toISOString(),
    });

    await tx.query(
      `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
      [
        task.organization_id,
        "agent_task.approved",
        "agent_task",
        taskId,
        "success",
        JSON.stringify({ approvedBy: userId }),
      ]
    );

    return this.getTask(tx, taskId);
  }
}
