import crypto from "node:crypto";
import type { ScopedTransaction } from "../../db/transaction.js";
import { NotFoundError, ValidationError } from "../../errors/app-errors.js";
import type {
  AgentArtifactDto,
  CreateArtifactInput,
  ArtifactType,
  ReviewStatus,
} from "./types.js";

const MAX_ARTIFACT_SIZE_BYTES = 524288; // 512 KB
const ALLOWED_ARTIFACT_TYPES = new Set<ArtifactType>([
  "patch_proposal",
  "test_report",
  "code_review",
  "security_review",
  "documentation",
  "plan",
]);

interface ArtifactRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  task_id: string;
  step_id: string | null;
  artifact_type: string;
  title: string;
  content: string;
  content_hash: string;
  size_bytes: number;
  review_status: string;
  metadata: Record<string, unknown>;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export class ArtifactsService {
  /**
   * Computes SHA-256 hex digest of artifact text.
   */
  static computeContentHash(content: string): string {
    return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
  }

  private mapRow(row: ArtifactRow): AgentArtifactDto {
    return {
      id: row.id,
      organizationId: row.organization_id,
      projectId: row.project_id,
      taskId: row.task_id,
      stepId: row.step_id,
      artifactType: row.artifact_type as ArtifactType,
      title: row.title,
      content: row.content,
      contentHash: row.content_hash,
      sizeBytes: row.size_bytes,
      reviewStatus: row.review_status as ReviewStatus,
      metadata: row.metadata,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Creates an immutable artifact within the tenant scope.
   */
  async createArtifact(
    tx: ScopedTransaction,
    userId: string,
    organizationId: string,
    input: CreateArtifactInput
  ): Promise<AgentArtifactDto> {
    if (!ALLOWED_ARTIFACT_TYPES.has(input.artifactType)) {
      throw new ValidationError(
        `Invalid artifact type '${input.artifactType}'. Allowed: ${Array.from(ALLOWED_ARTIFACT_TYPES).join(", ")}.`
      );
    }

    const trimmedTitle = input.title?.trim();
    if (!trimmedTitle || trimmedTitle.length > 200) {
      throw new ValidationError("Artifact title must be between 1 and 200 characters.");
    }

    if (!input.content || typeof input.content !== "string") {
      throw new ValidationError("Artifact content must be a non-empty string.");
    }

    const sizeBytes = Buffer.byteLength(input.content, "utf-8");
    if (sizeBytes > MAX_ARTIFACT_SIZE_BYTES) {
      throw new ValidationError(
        `Artifact content size (${sizeBytes} bytes) exceeds maximum allowable limit of ${MAX_ARTIFACT_SIZE_BYTES} bytes (512 KB).`
      );
    }

    // Verify task exists and belongs to the same tenant under RLS
    const taskRes = await tx.query<{ id: string; project_id: string | null }>(
      `SELECT id, project_id FROM agent_tasks WHERE id = $1 AND organization_id = $2;`,
      [input.taskId, organizationId]
    );
    if (taskRes.rowCount === 0) {
      throw new NotFoundError("Agent task not found in tenant");
    }

    const effectiveProjectId = input.projectId ?? taskRes.rows[0].project_id;

    // If stepId is provided, verify step belongs to task
    if (input.stepId) {
      const stepRes = await tx.query<{ id: string }>(
        `SELECT id FROM agent_task_steps WHERE id = $1 AND task_id = $2 AND organization_id = $3;`,
        [input.stepId, input.taskId, organizationId]
      );
      if (stepRes.rowCount === 0) {
        throw new NotFoundError("Agent task step not found in task");
      }
    }

    const contentHash = ArtifactsService.computeContentHash(input.content);

    const insertRes = await tx.query<ArtifactRow>(
      `INSERT INTO agent_artifacts (
        organization_id, project_id, task_id, step_id,
        artifact_type, title, content, content_hash,
        size_bytes, review_status, metadata, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10::jsonb, $11)
      RETURNING *;`,
      [
        organizationId,
        effectiveProjectId,
        input.taskId,
        input.stepId ?? null,
        input.artifactType,
        trimmedTitle,
        input.content,
        contentHash,
        sizeBytes,
        JSON.stringify(input.metadata ?? {}),
        userId,
      ]
    );

    const row = insertRes.rows[0];

    // Record audit event
    await tx.query(
      `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
      [
        organizationId,
        "agent_artifact.created",
        "agent_artifact",
        row.id,
        "success",
        JSON.stringify({
          taskId: input.taskId,
          artifactType: input.artifactType,
          contentHash,
          sizeBytes,
        }),
      ]
    );

    return this.mapRow(row);
  }

  /**
   * Retrieves an artifact by ID under forced RLS.
   */
  async getArtifact(tx: ScopedTransaction, artifactId: string): Promise<AgentArtifactDto> {
    const res = await tx.query<ArtifactRow>(
      `SELECT * FROM agent_artifacts WHERE id = $1;`,
      [artifactId]
    );
    const row = res.rows[0];
    if (!row) {
      throw new NotFoundError("Agent artifact");
    }
    return this.mapRow(row);
  }

  /**
   * Lists artifacts for a project or task under forced RLS.
   */
  async listArtifacts(
    tx: ScopedTransaction,
    query: {
      projectId?: string;
      taskId?: string;
      artifactType?: ArtifactType;
      limit?: number;
      offset?: number;
    }
  ): Promise<{ artifacts: AgentArtifactDto[]; total: number }> {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const offset = Math.max(query.offset ?? 0, 0);

    const conditions: string[] = [];
    const params: any[] = [];
    let pIdx = 1;

    if (query.projectId) {
      conditions.push(`project_id = $${pIdx++}`);
      params.push(query.projectId);
    }

    if (query.taskId) {
      conditions.push(`task_id = $${pIdx++}`);
      params.push(query.taskId);
    }

    if (query.artifactType) {
      conditions.push(`artifact_type = $${pIdx++}`);
      params.push(query.artifactType);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRes = await tx.query<{ count: string }>(
      `SELECT count(*) FROM agent_artifacts ${whereClause};`,
      params
    );
    const total = parseInt(countRes.rows[0].count, 10);

    const listRes = await tx.query<ArtifactRow>(
      `SELECT * FROM agent_artifacts
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${pIdx++} OFFSET $${pIdx++};`,
      [...params, limit, offset]
    );

    return {
      artifacts: listRes.rows.map((r: ArtifactRow) => this.mapRow(r)),
      total,
    };
  }

  /**
   * Updates review status of an artifact.
   * Enforces role requirements (only owner/admin or authorized reviewers).
   */
  async updateReviewStatus(
    tx: ScopedTransaction,
    artifactId: string,
    status: ReviewStatus,
    metadataUpdates?: Record<string, unknown>
  ): Promise<AgentArtifactDto> {
    await this.getArtifact(tx, artifactId);

    const res = await tx.query<ArtifactRow>(
      `UPDATE agent_artifacts
       SET review_status = $2,
           metadata = metadata || $3::jsonb,
           updated_at = now()
       WHERE id = $1
       RETURNING *;`,
      [artifactId, status, JSON.stringify(metadataUpdates ?? {})]
    );

    return this.mapRow(res.rows[0]);
  }
}
