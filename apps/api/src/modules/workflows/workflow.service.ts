import type { ScopedTransaction } from "../../db/transaction.js";
import {
  NotFoundError,
  ValidationError,
  ConflictError,
} from "../../errors/app-errors.js";
import type { AgentTaskDto } from "../orchestrator/types.js";
import { AgentOrchestratorService } from "../orchestrator/orchestrator.service.js";
import { ArtifactsService } from "./artifacts.service.js";
import { ApprovalsService } from "./approvals.service.js";
import { ToolGateway } from "./tools/gateway.js";
import {
  PlannerAgent,
  CodingAgent,
  TestingAgent,
  CodeReviewAgent,
  SecurityReviewAgent,
  DocumentationAgent,
} from "./agents/index.js";
import type {
  AgentArtifactDto,
  AgentApprovalDto,
} from "./types.js";

import { ApprovedPatchService } from "./patch.service.js";

export interface StartWorkflowInput {
  projectId: string;
  title: string;
  requirements: string[];
  providerConfigId?: string;
}

export interface WorkflowExecutionSummary {
  task: AgentTaskDto;
  artifacts: AgentArtifactDto[];
  approvals: AgentApprovalDto[];
  status: string;
  currentStep?: string;
  requiresApproval: boolean;
}

export class AgentWorkflowService {
  constructor(
    private readonly orchestratorService = new AgentOrchestratorService(),
    private readonly artifactsService = new ArtifactsService(),
    private readonly approvalsService = new ApprovalsService(),
    private readonly toolGateway = new ToolGateway(),
    private readonly patchService = new ApprovedPatchService(approvalsService, artifactsService),
    private readonly plannerAgent = new PlannerAgent(),
    private readonly codingAgent = new CodingAgent(),
    private readonly testingAgent = new TestingAgent(),
    private readonly codeReviewAgent = new CodeReviewAgent(),
    private readonly securityReviewAgent = new SecurityReviewAgent(),
    private readonly documentationAgent = new DocumentationAgent()
  ) {}

  /**
   * Initializes a multi-agent workflow pipeline task and creates ordered steps.
   */
  async startWorkflow(
    tx: ScopedTransaction,
    userId: string,
    organizationId: string,
    input: StartWorkflowInput
  ): Promise<WorkflowExecutionSummary> {
    if (!input.title || input.title.trim().length === 0) {
      throw new ValidationError("Workflow title is required.");
    }
    if (!input.requirements || input.requirements.length === 0) {
      throw new ValidationError("At least one workflow requirement is required.");
    }

    // 1. Verify project exists in caller's tenant
    const projectRes = await tx.query<{ id: string; name: string }>(
      `SELECT id, name FROM projects WHERE id = $1 AND organization_id = $2;`,
      [input.projectId, organizationId]
    );
    if (projectRes.rowCount === 0) {
      throw new NotFoundError("Project not found in authorized organization context");
    }

    // 2. Create underlying agent_task using orchestrator
    const task = await this.orchestratorService.createTask(tx, userId, {
      organizationId,
      projectId: input.projectId,
      providerConfigId: input.providerConfigId,
      taskType: "implementation_plan",
      title: input.title,
      inputData: {
        requirements: input.requirements,
        inputSummary: `Multi-agent workflow for: ${input.title}`,
        workflowPipeline: "planner->coding->testing->code_review->security_review->approval->docs",
      },
    });

    // 3. Run Planner Agent to produce plan artifact
    const planResult = await this.plannerAgent.execute(
      {
        title: input.title,
        requirements: input.requirements,
      },
      {
        organizationId,
        projectId: input.projectId,
        taskId: task.id,
        userId,
        providerConfigId: input.providerConfigId,
      }
    );

    let planArtifact: AgentArtifactDto | undefined;
    if (planResult.artifactsGenerated && planResult.artifactsGenerated.length > 0) {
      const artInput = planResult.artifactsGenerated[0];
      planArtifact = await this.artifactsService.createArtifact(tx, userId, organizationId, artInput);
    }

    return {
      task,
      artifacts: planArtifact ? [planArtifact] : [],
      approvals: [],
      status: task.status,
      currentStep: task.currentStepKey ?? undefined,
      requiresApproval: false,
    };
  }

  /**
   * Advances the workflow through agent execution:
   * Coding -> Testing -> Code Review -> Security Review -> Approval Gate.
   */
  async advanceWorkflow(
    tx: ScopedTransaction,
    taskId: string,
    userId: string,
    organizationId: string
  ): Promise<WorkflowExecutionSummary> {
    // 1. Fetch current task state under exclusive row lock (FOR UPDATE)
    const taskRes = await tx.query<{
      id: string;
      organization_id: string;
      project_id: string | null;
      status: string;
      title: string;
      input_summary: string | null;
      current_step_key: string | null;
      provider_config_id: string | null;
      version: number;
    }>(
      `SELECT id, organization_id, project_id, status, title, input_summary, current_step_key, provider_config_id, version
       FROM agent_tasks
       WHERE id = $1 AND organization_id = $2
       FOR UPDATE;`,
      [taskId, organizationId]
    );

    const taskRow = taskRes.rows[0];
    if (!taskRow) {
      throw new NotFoundError("Agent task not found in tenant");
    }

    if (taskRow.status === "succeeded" || taskRow.status === "cancelled") {
      const task = await this.orchestratorService.getTask(tx, taskId);
      const artifactsRes = await this.artifactsService.listArtifacts(tx, { taskId });
      const approvals = await this.approvalsService.listApprovalsForTask(tx, taskId);
      return {
        task,
        artifacts: artifactsRes.artifacts,
        approvals,
        status: task.status,
        requiresApproval: false,
      };
    }

    // 2. Check if waiting for approval or already has a pending approval request
    const existingApprovals = await this.approvalsService.listApprovalsForTask(tx, taskId);
    const pendingApproval = existingApprovals.find((a) => a.status === "pending");

    if (taskRow.status === "waiting_for_approval" || pendingApproval) {
      const task = await this.orchestratorService.getTask(tx, taskId);
      const artifactsRes = await this.artifactsService.listArtifacts(tx, { taskId });

      return {
        task,
        artifacts: artifactsRes.artifacts,
        approvals: existingApprovals,
        status: task.status,
        currentStep: task.currentStepKey ?? undefined,
        requiresApproval: pendingApproval !== undefined,
      };
    }

    const projectId = taskRow.project_id!;
    const context = {
      organizationId,
      projectId,
      taskId: taskRow.id,
      userId,
      providerConfigId: taskRow.provider_config_id ?? undefined,
    };

    const artifactsGenerated: AgentArtifactDto[] = [];

    // Step A: Coding Agent generates patch proposal
    const codingResult = await this.codingAgent.execute(
      {
        stepKey: "generate_code_changes",
        instructions: taskRow.input_summary ?? taskRow.title,
        targetFiles: ["src/index.ts"],
      },
      context
    );

    let patchArtifact: AgentArtifactDto | undefined;
    if (codingResult.artifactsGenerated && codingResult.artifactsGenerated.length > 0) {
      patchArtifact = await this.artifactsService.createArtifact(
        tx,
        userId,
        organizationId,
        codingResult.artifactsGenerated[0]
      );
      artifactsGenerated.push(patchArtifact);
    }

    // Step B: Testing Agent runs tests in workspace sandbox
    const testingResult = await this.testingAgent.execute(
      {
        testCommand: "test",
        patchArtifactId: patchArtifact?.id,
      },
      context
    );
    if (testingResult.artifactsGenerated && testingResult.artifactsGenerated.length > 0) {
      const testArt = await this.artifactsService.createArtifact(
        tx,
        userId,
        organizationId,
        testingResult.artifactsGenerated[0]
      );
      artifactsGenerated.push(testArt);
    }

    // Step C: Code Review Agent evaluates patch
    const codeReviewResult = await this.codeReviewAgent.execute(
      {
        patchArtifactId: patchArtifact?.id ?? "",
        patchContent: patchArtifact?.content ?? "",
        reviewFocus: "quality",
      },
      context
    );
    if (codeReviewResult.artifactsGenerated && codeReviewResult.artifactsGenerated.length > 0) {
      const crArt = await this.artifactsService.createArtifact(
        tx,
        userId,
        organizationId,
        codeReviewResult.artifactsGenerated[0]
      );
      artifactsGenerated.push(crArt);
    }

    // Step D: Security Review Agent evaluates patch
    const securityReviewResult = await this.securityReviewAgent.execute(
      {
        patchArtifactId: patchArtifact?.id ?? "",
        patchContent: patchArtifact?.content ?? "",
        reviewFocus: "security",
      },
      context
    );
    if (securityReviewResult.artifactsGenerated && securityReviewResult.artifactsGenerated.length > 0) {
      const srArt = await this.artifactsService.createArtifact(
        tx,
        userId,
        organizationId,
        securityReviewResult.artifactsGenerated[0]
      );
      artifactsGenerated.push(srArt);
    }

    // Step E: Create Hash-Bound Approval Request for patch application
    let approvalRequest: AgentApprovalDto | undefined;
    if (patchArtifact) {
      approvalRequest = await this.approvalsService.createApprovalRequest(tx, organizationId, {
        taskId: taskRow.id,
        artifactId: patchArtifact.id,
        action: "apply_patch",
        targetContentHash: patchArtifact.contentHash,
        requiredRole: "admin",
        expiresInSeconds: 86400, // 24 hours
        metadata: {
          title: patchArtifact.title,
          securityApproved: securityReviewResult.data?.approved,
          codeReviewScore: codeReviewResult.data?.score,
        },
      });
    }

    // Fetch updated task and all artifacts
    const updatedTask = await this.orchestratorService.getTask(tx, taskId);
    const allArtifacts = await this.artifactsService.listArtifacts(tx, { taskId });
    const allApprovals = await this.approvalsService.listApprovalsForTask(tx, taskId);

    return {
      task: updatedTask,
      artifacts: allArtifacts.artifacts,
      approvals: allApprovals,
      status: updatedTask.status,
      currentStep: updatedTask.currentStepKey ?? undefined,
      requiresApproval: true,
    };
  }

  /**
   * Finalizes workflow after patch application approval:
   * Verifies approval hash, runs documentation agent, transitions task to succeeded.
   */
  async completeWorkflowAfterApproval(
    tx: ScopedTransaction,
    taskId: string,
    userId: string,
    organizationId: string
  ): Promise<WorkflowExecutionSummary> {
    // 1. Acquire exclusive row lock on task
    const taskRes = await tx.query<{
      id: string;
      organization_id: string;
      project_id: string | null;
      status: string;
      title: string;
      version: number;
    }>(
      `SELECT id, organization_id, project_id, status, title, version
       FROM agent_tasks
       WHERE id = $1 AND organization_id = $2
       FOR UPDATE;`,
      [taskId, organizationId]
    );

    const taskRow = taskRes.rows[0];
    if (!taskRow) {
      throw new NotFoundError("Agent task not found in tenant");
    }

    if (taskRow.status === "succeeded") {
      throw new ConflictError("Agent workflow has already been completed.");
    }

    if (taskRow.status !== "running" && taskRow.status !== "waiting_for_approval") {
      throw new ConflictError(
        `Cannot complete workflow: Task status is '${taskRow.status}', expected 'running' or 'waiting_for_approval'.`
      );
    }

    // 2. Fetch patch proposal artifact
    const artifactsRes = await this.artifactsService.listArtifacts(tx, {
      taskId,
      artifactType: "patch_proposal",
    });
    const patchArtifact = artifactsRes.artifacts[0];
    if (!patchArtifact) {
      throw new NotFoundError("Patch proposal artifact not found for task");
    }

    // 3. Cryptographically verify, atomically consume single-use approval, and apply patch
    await this.patchService.applyApprovedPatch(
      tx,
      {
        taskId,
        projectId: taskRow.project_id!,
        patchArtifactId: patchArtifact.id,
        expectedHash: patchArtifact.contentHash,
      },
      userId,
      organizationId
    );

    const task = await this.orchestratorService.getTask(tx, taskId);

    // 3. Documentation Agent generates documentation artifact
    const docResult = await this.documentationAgent.execute(
      {
        taskTitle: task.title,
        completedSteps: [
          "Planner: Requirements Breakdown",
          "Coding: Unified Patch Proposal",
          "Testing: Automated Sandbox Validation",
          "Review: Code Quality & Security Audit",
          "Approval: Authorized Human Signature Verified",
        ],
        patchSummaries: [patchArtifact.title],
      },
      {
        organizationId,
        projectId: task.projectId!,
        taskId,
        userId,
      }
    );

    if (docResult.artifactsGenerated && docResult.artifactsGenerated.length > 0) {
      await this.artifactsService.createArtifact(
        tx,
        userId,
        organizationId,
        docResult.artifactsGenerated[0]
      );
    }

    // 4. Mark task succeeded
    await tx.query(
      `UPDATE agent_tasks
       SET status = 'succeeded', completed_at = now(), version = version + 1
       WHERE id = $1;`,
      [taskId]
    );

    // Record audit event
    await tx.query(
      `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
      [
        organizationId,
        "agent_workflow.completed",
        "agent_task",
        taskId,
        "success",
        JSON.stringify({
          patchArtifactId: patchArtifact.id,
          patchContentHash: patchArtifact.contentHash,
        }),
      ]
    );

    const completedTask = await this.orchestratorService.getTask(tx, taskId);
    const finalArtifacts = await this.artifactsService.listArtifacts(tx, { taskId });
    const finalApprovals = await this.approvalsService.listApprovalsForTask(tx, taskId);

    return {
      task: completedTask,
      artifacts: finalArtifacts.artifacts,
      approvals: finalApprovals,
      status: completedTask.status,
      requiresApproval: false,
    };
  }
}
