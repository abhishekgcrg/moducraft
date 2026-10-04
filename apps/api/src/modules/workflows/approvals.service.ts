import type { ScopedTransaction } from "../../db/transaction.js";
import {
  NotFoundError,
  ValidationError,
  ForbiddenError,
  ConflictError,
} from "../../errors/app-errors.js";
import type {
  AgentApprovalDto,
  CreateApprovalInput,
  DecideApprovalInput,
  ApprovalStatus,
  ApprovalAction,
} from "./types.js";
import { ArtifactsService } from "./artifacts.service.js";

const DEFAULT_EXPIRATION_SECONDS = 86400; // 24 hours

interface ApprovalRow {
  id: string;
  organization_id: string;
  task_id: string;
  step_id: string | null;
  artifact_id: string | null;
  action: string;
  target_content_hash: string;
  status: string;
  required_role: string;
  expires_at: Date;
  approved_by: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export class ApprovalsService {
  constructor(private readonly artifactsService = new ArtifactsService()) {}

  private mapRow(row: ApprovalRow): AgentApprovalDto {
    return {
      id: row.id,
      organizationId: row.organization_id,
      taskId: row.task_id,
      stepId: row.step_id,
      artifactId: row.artifact_id,
      action: row.action as ApprovalAction,
      targetContentHash: row.target_content_hash,
      status: row.status as ApprovalStatus,
      requiredRole: row.required_role as "owner" | "admin",
      expiresAt: row.expires_at,
      approvedBy: row.approved_by,
      decidedAt: row.decided_at,
      decisionReason: row.decision_reason,
      metadata: row.metadata,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Asserts caller has required organization role.
   */
  private async assertOrgRole(
    tx: ScopedTransaction,
    orgId: string,
    userId: string,
    allowedRoles: string[]
  ): Promise<void> {
    const roleRes = await tx.query<{ role: string }>(
      `SELECT role FROM organization_memberships
       WHERE organization_id = $1 AND user_id = $2;`,
      [orgId, userId]
    );
    const userRole = roleRes.rows[0]?.role;
    if (!userRole || !allowedRoles.includes(userRole)) {
      throw new ForbiddenError(
        `Insufficient permissions. Requires one of [${allowedRoles.join(", ")}], but user role is '${userRole ?? "none"}'.`
      );
    }
  }

  /**
   * Creates a scoped, single-use, hash-bound approval request.
   */
  async createApprovalRequest(
    tx: ScopedTransaction,
    organizationId: string,
    input: CreateApprovalInput
  ): Promise<AgentApprovalDto> {
    if (!input.targetContentHash || input.targetContentHash.length !== 64) {
      throw new ValidationError("Target content hash must be a valid 64-character SHA-256 hex string.");
    }

    // Verify task exists in tenant
    const taskRes = await tx.query<{ id: string }>(
      `SELECT id FROM agent_tasks WHERE id = $1 AND organization_id = $2;`,
      [input.taskId, organizationId]
    );
    if (taskRes.rowCount === 0) {
      throw new NotFoundError("Agent task not found in tenant");
    }

    // If artifactId is specified, verify it matches targetContentHash
    if (input.artifactId) {
      const artifact = await this.artifactsService.getArtifact(tx, input.artifactId);
      if (artifact.contentHash !== input.targetContentHash) {
        throw new ConflictError(
          `Artifact content hash mismatch. Expected '${input.targetContentHash}', but artifact has '${artifact.contentHash}'.`
        );
      }
    }

    const expiresInSec = input.expiresInSeconds ?? DEFAULT_EXPIRATION_SECONDS;
    const expiresAt = new Date(Date.now() + expiresInSec * 1000);
    const requiredRole = input.requiredRole ?? "admin";

    const insertRes = await tx.query<ApprovalRow>(
      `INSERT INTO agent_approvals (
        organization_id, task_id, step_id, artifact_id,
        action, target_content_hash, status, required_role,
        expires_at, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9::jsonb)
      RETURNING *;`,
      [
        organizationId,
        input.taskId,
        input.stepId ?? null,
        input.artifactId ?? null,
        input.action,
        input.targetContentHash,
        requiredRole,
        expiresAt,
        JSON.stringify(input.metadata ?? {}),
      ]
    );

    const row = insertRes.rows[0];

    // Transition task status to waiting_for_approval if not already
    await tx.query(
      `UPDATE agent_tasks
       SET status = 'waiting_for_approval', version = version + 1
       WHERE id = $1 AND status != 'waiting_for_approval';`,
      [input.taskId]
    );

    // Record audit event
    await tx.query(
      `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
      [
        organizationId,
        "agent_approval.requested",
        "agent_approval",
        row.id,
        "success",
        JSON.stringify({
          taskId: input.taskId,
          action: input.action,
          targetContentHash: input.targetContentHash,
          expiresAt: expiresAt.toISOString(),
        }),
      ]
    );

    return this.mapRow(row);
  }

  /**
   * Retrieves an approval by ID under forced RLS.
   */
  async getApproval(tx: ScopedTransaction, approvalId: string): Promise<AgentApprovalDto> {
    const res = await tx.query<ApprovalRow>(
      `SELECT * FROM agent_approvals WHERE id = $1;`,
      [approvalId]
    );
    const row = res.rows[0];
    if (!row) {
      throw new NotFoundError("Agent approval request");
    }
    return this.mapRow(row);
  }

  /**
   * Lists approvals for a task.
   */
  async listApprovalsForTask(
    tx: ScopedTransaction,
    taskId: string
  ): Promise<AgentApprovalDto[]> {
    const res = await tx.query<ApprovalRow>(
      `SELECT * FROM agent_approvals
       WHERE task_id = $1
       ORDER BY created_at DESC;`,
      [taskId]
    );
    return res.rows.map((r: ApprovalRow) => this.mapRow(r));
  }

  /**
   * Records human decision (approve or reject) on an approval request.
   * Enforces role requirements, expiration, replay prevention, and hash consistency.
   */
  async decideApproval(
    tx: ScopedTransaction,
    approvalId: string,
    userId: string,
    organizationId: string,
    input: DecideApprovalInput
  ): Promise<AgentApprovalDto> {
    // 1. Lock approval row for update
    const lockRes = await tx.query<ApprovalRow>(
      `SELECT * FROM agent_approvals WHERE id = $1 AND organization_id = $2 FOR UPDATE;`,
      [approvalId, organizationId]
    );
    const approval = lockRes.rows[0];
    if (!approval) {
      throw new NotFoundError("Agent approval request");
    }

    // 2. Enforce authorization role (owner or admin)
    const allowedRoles = approval.required_role === "owner" ? ["owner"] : ["owner", "admin"];
    await this.assertOrgRole(tx, organizationId, userId, allowedRoles);

    // 3. Check for expiration
    const now = new Date();
    if (approval.expires_at < now) {
      if (approval.status === "pending") {
        await tx.query(
          `UPDATE agent_approvals SET status = 'expired' WHERE id = $1;`,
          [approvalId]
        );
      }
      throw new ConflictError(
        `Approval request expired at ${approval.expires_at.toISOString()}. Decision rejected.`
      );
    }

    // 4. Reject replay or modifying decided approvals
    if (approval.status !== "pending") {
      throw new ConflictError(
        `Cannot decide approval request with status '${approval.status}'. Approvals are single-use.`
      );
    }

    // 5. If artifact is linked, re-verify hash has not mutated
    if (approval.artifact_id) {
      const artifact = await this.artifactsService.getArtifact(tx, approval.artifact_id);
      if (artifact.contentHash !== approval.target_content_hash) {
        throw new ConflictError(
          `Security violation: Artifact content was modified after approval was requested. Hash mismatch.`
        );
      }

      // Update artifact review status
      await this.artifactsService.updateReviewStatus(
        tx,
        approval.artifact_id,
        input.decision === "approved" ? "approved" : "rejected",
        {
          decidedBy: userId,
          decidedAt: now.toISOString(),
          decisionReason: input.reason,
        }
      );
    }

    // 6. Update approval row
    const updateRes = await tx.query<ApprovalRow>(
      `UPDATE agent_approvals
       SET status = $2,
           approved_by = $3,
           decided_at = now(),
           decision_reason = $4,
           updated_at = now()
       WHERE id = $1
       RETURNING *;`,
      [approvalId, input.decision, userId, input.reason ?? null]
    );

    const updatedApproval = updateRes.rows[0];

    // If approved, resume task execution to running
    if (input.decision === "approved") {
      await tx.query(
        `UPDATE agent_tasks
         SET status = 'running', version = version + 1
         WHERE id = $1 AND status = 'waiting_for_approval';`,
        [approval.task_id]
      );
    }

    // Record audit event
    await tx.query(
      `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
      [
        organizationId,
        `agent_approval.${input.decision}`,
        "agent_approval",
        approvalId,
        "success",
        JSON.stringify({
          taskId: approval.task_id,
          decision: input.decision,
          targetContentHash: approval.target_content_hash,
          approvedBy: userId,
        }),
      ]
    );

    return this.mapRow(updatedApproval);
  }

  /**
   * Verifies that an approved, non-expired, single-use approval exists for the given action and hash,
   * and atomically consumes it (setting status = 'consumed') under database-backed row locking.
   * Throws ConflictError if approval is missing, expired, already consumed, or hash does not match.
   */
  async verifyAndConsumeApproval(
    tx: ScopedTransaction,
    organizationId: string,
    taskId: string,
    action: ApprovalAction,
    currentContentHash: string
  ): Promise<AgentApprovalDto> {
    // 0. Verify task status: cannot consume approval for a cancelled or terminal task
    const taskRes = await tx.query<{ status: string }>(
      `SELECT status FROM agent_tasks WHERE id = $1 AND organization_id = $2 FOR UPDATE;`,
      [taskId, organizationId]
    );
    const taskRow = taskRes.rows[0];
    if (taskRow) {
      if (taskRow.status === "cancelled") {
        throw new ConflictError(`Cannot consume approval: Task '${taskId}' has been cancelled.`);
      }
      if (taskRow.status === "succeeded") {
        throw new ConflictError(`Cannot consume approval: Task '${taskId}' has already completed.`);
      }
      if (taskRow.status === "failed") {
        throw new ConflictError(`Cannot consume approval: Task '${taskId}' is in failed state.`);
      }
    }

    // 1. Atomically lock and update the approved approval row to 'consumed'
    const updateRes = await tx.query<ApprovalRow>(
      `UPDATE agent_approvals
       SET status = 'consumed', updated_at = now()
       WHERE id = (
         SELECT id FROM agent_approvals
         WHERE organization_id = $1
           AND task_id = $2
           AND action = $3
           AND target_content_hash = $4
           AND status = 'approved'
           AND expires_at > now()
         ORDER BY decided_at DESC
         LIMIT 1
         FOR UPDATE
       )
       RETURNING *;`,
      [organizationId, taskId, action, currentContentHash]
    );

    const approval = updateRes.rows[0];
    if (approval) {
      return this.mapRow(approval);
    }

    // 2. If no active approved row was consumed, inspect why to provide an actionable, unambiguous security error
    const inspectionRes = await tx.query<ApprovalRow>(
      `SELECT status, expires_at, target_content_hash FROM agent_approvals
       WHERE organization_id = $1
         AND task_id = $2
         AND action = $3
       ORDER BY created_at DESC
       LIMIT 1;`,
      [organizationId, taskId, action]
    );

    const existing = inspectionRes.rows[0];
    if (!existing) {
      throw new ConflictError(
        `No approval request found for task '${taskId}' and action '${action}'. Explicit human approval is required.`
      );
    }

    if (existing.status === "consumed") {
      throw new ConflictError(
        `Approval for action '${action}' has already been consumed. Approvals are single-use and cannot be replayed.`
      );
    }

    if (existing.expires_at < new Date()) {
      throw new ConflictError(
        `Approval for action '${action}' expired at ${existing.expires_at.toISOString()}. A new approval must be requested.`
      );
    }

    if (existing.target_content_hash !== currentContentHash) {
      throw new ConflictError(
        `Security violation: Target content hash mismatch. Approved hash '${existing.target_content_hash}', but current content has hash '${currentContentHash}'.`
      );
    }

    throw new ConflictError(
      `Action '${action}' requires an approved approval, but current approval status is '${existing.status}'.`
    );
  }
}
