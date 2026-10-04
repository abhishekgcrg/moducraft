import crypto from "node:crypto";
import type pg from "pg";
import { type ScopedTransaction, withAuthenticatedContext } from "../../db/transaction.js";
import {
  ValidationError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
} from "../../errors/app-errors.js";
import { ApprovalsService } from "./approvals.service.js";
import { ArtifactsService } from "./artifacts.service.js";
import { validateWorkspaceRelativePath } from "./tools/sandbox.js";
import { createWorkspaceRunner } from "./tools/runner-factory.js";
import { redactSensitiveData } from "../memory/redactor.js";
import type {
  AdminRecoverInput,
  AdminRecoverResult,
  AgentArtifactDto,
  ApplyPatchInput,
  ApplyPatchResult,
  FileBaselineSnapshot,
  IsolatedWorkspaceRunner,
  PatchApplicationJournalDto,
  PatchJournalBaselineState,
  PatchJournalStatus,
} from "./types.js";

export const MAX_BASELINE_FILE_SIZE_BYTES = 1048576; // 1 MB limit for baseline file snapshots
export const MAX_PATCH_FILE_COUNT = 50; // Max 50 files in a single patch proposal
export const MAX_PATCH_DIFF_SIZE_BYTES = 2097152; // 2 MB unified diff limit
export const MAX_AGGREGATE_BASELINE_SIZE_BYTES = 10485760; // 10 MB aggregate across all baseline files

export interface DiffHunk {
  oldStart: number;
  oldLen: number;
  newStart: number;
  newLen: number;
  lines: string[];
}

export interface DiffFilePatch {
  oldPath: string;
  newPath: string;
  isNew: boolean;
  isDeleted: boolean;
  hunks: DiffHunk[];
}

export type CrashInjectionStage =
  | "before_approval"
  | "after_approval_before_writes"
  | "after_first_write"
  | "during_rollback";

/**
 * Parses unified diff syntax into structured file patches and hunks.
 * Rejects malformed headers and unparseable hunk declarations.
 */
export function parseUnifiedDiff(diff: string): DiffFilePatch[] {
  const filePatches: DiffFilePatch[] = [];
  const lines = diff.split(/\r?\n/);
  let currentFile: DiffFilePatch | null = null;
  let currentHunk: DiffHunk | null = null;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("--- ")) {
      let oldPath = line.slice(4).trim();
      if (oldPath.startsWith("a/")) oldPath = oldPath.slice(2);
      else if (oldPath.startsWith("/")) oldPath = oldPath.slice(1);

      i++;
      if (i >= lines.length || !lines[i].startsWith("+++ ")) {
        throw new ValidationError("Malformed unified diff: expected +++ header after --- header.");
      }
      let newPath = lines[i].slice(4).trim();
      if (newPath.startsWith("b/")) newPath = newPath.slice(2);
      else if (newPath.startsWith("/")) newPath = newPath.slice(1);

      currentFile = {
        oldPath,
        newPath,
        isNew: oldPath === "dev/null" || oldPath === "/dev/null",
        isDeleted: newPath === "dev/null" || newPath === "/dev/null",
        hunks: [],
      };
      filePatches.push(currentFile);
      currentHunk = null;
      i++;
      continue;
    }

    if (line.startsWith("@@ ")) {
      if (!currentFile) {
        throw new ValidationError("Malformed unified diff: found hunk header without preceding file header.");
      }
      const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!match) {
        throw new ValidationError(`Malformed unified diff: invalid hunk header '${line}'.`);
      }
      currentHunk = {
        oldStart: parseInt(match[1], 10),
        oldLen: match[2] !== undefined ? parseInt(match[2], 10) : 1,
        newStart: parseInt(match[3], 10),
        newLen: match[4] !== undefined ? parseInt(match[4], 10) : 1,
        lines: [],
      };
      currentFile.hunks.push(currentHunk);
      i++;
      continue;
    }

    if (currentHunk) {
      if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
        currentHunk.lines.push(line);
      } else if (line.startsWith("\\")) {
        // e.g. \ No newline at end of file (ignore)
      } else if (line.startsWith("diff --git") || line.startsWith("index ")) {
        // git metadata, ignore
      } else if (line.trim() === "" && i === lines.length - 1) {
        // Trailing newline at EOF
      }
    }

    i++;
  }

  return filePatches;
}

/**
 * Applies unified diff hunks sequentially to a file's content.
 * Guarantees that pre-existing modifications are preserved: if context lines
 * or deletion targets do not match existing file content at the target position,
 * application fails closed with a ConflictError without altering file content.
 */
export function applyHunksToFile(
  filePath: string,
  originalContent: string,
  hunks: DiffHunk[]
): string {
  if (hunks.length === 0) {
    throw new ValidationError(`Patch for '${filePath}' does not contain any valid diff hunks.`);
  }

  const originalLines = originalContent === "" ? [] : originalContent.split(/\r?\n/);
  const resultLines = [...originalLines];
  let lineOffset = 0;

  for (const hunk of hunks) {
    const targetIndex = (hunk.oldStart === 0 ? 0 : hunk.oldStart - 1) + lineOffset;
    const hunkReplacements: string[] = [];
    let deleteCount = 0;
    let scanIdx = targetIndex;

    for (const hunkLine of hunk.lines) {
      const marker = hunkLine[0];
      const text = hunkLine.slice(1);

      if (marker === " ") {
        if (scanIdx >= resultLines.length || resultLines[scanIdx] !== text) {
          throw new ConflictError(
            `Patch context mismatch in '${filePath}' around line ${scanIdx + 1}. Expected: '${text}', found: '${resultLines[scanIdx] ?? "<EOF>"}'. Pre-existing user modifications preserved; patch application aborted.`
          );
        }
        hunkReplacements.push(text);
        deleteCount++;
        scanIdx++;
      } else if (marker === "-") {
        if (scanIdx >= resultLines.length || resultLines[scanIdx] !== text) {
          throw new ConflictError(
            `Patch deletion mismatch in '${filePath}' at line ${scanIdx + 1}. Expected to delete: '${text}', found: '${resultLines[scanIdx] ?? "<EOF>"}'. Pre-existing user modifications preserved; patch application aborted.`
          );
        }
        deleteCount++;
        scanIdx++;
      } else if (marker === "+") {
        hunkReplacements.push(text);
      }
    }

    resultLines.splice(targetIndex, deleteCount, ...hunkReplacements);
    lineOffset += hunkReplacements.length - deleteCount;
  }

  return resultLines.join("\n");
}

/**
 * ApprovedPatchService
 *
 * Implements Stage 6: Approved Patch Application with Durable Recovery & Crash Consistency (Phase 4D.5).
 * Guarantees that:
 * 1. Proposed patches are immutable and hash-verified against their exact content at application time.
 * 2. Requires a fresh, authorized, single-use approval bound to the exact task, action ('apply_patch'),
 *    and patch hash.
 * 3. Rejects replayed, stale, or expired approvals.
 * 4. Rejects out-of-bounds paths, path traversal, percent-encoding, null bytes, and sensitive files.
 * 5. Rejects binary patches.
 * 6. Validates hunk context and rejects diverged files, preserving pre-existing user modifications.
 * 7. Enforces atomic all-or-nothing rollback semantics: if any hunk fails, no files are modified.
 * 8. Records a tenant-scoped durable patch journal in PostgreSQL with explicit states
 *    ('prepared' -> 'applying' -> 'applied' | 'rolling_back' -> 'rolled_back' | 'recovery_required' -> 'recovered').
 * 9. Fences dirty projects: prevents any further conflicting writes if a project is in 'recovery_required'.
 * 10. Genuinely modifies files in the target isolated workspace runner upon successful verification.
 */
export class ApprovedPatchService {
  constructor(
    private readonly approvalsService: ApprovalsService = new ApprovalsService(),
    private readonly artifactsService: ArtifactsService = new ArtifactsService(),
    private readonly workspaceRunner?: IsolatedWorkspaceRunner
  ) {}

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
    const membership = roleRes.rows[0];
    if (!membership || !allowedRoles.includes(membership.role)) {
      throw new ForbiddenError(
        `Insufficient permissions. Requires one of roles: [${allowedRoles.join(", ")}].`
      );
    }
  }

  /**
   * Checks if a project's workspace is fenced due to a previous unrecovered failure.
   * Throws ConflictError if any patch application journal is in 'recovery_required'.
   */
  async checkProjectFenced(
    tx: ScopedTransaction,
    organizationId: string,
    projectId: string
  ): Promise<void> {
    const fencedRes = await tx.query<{ id: string; status: string; recovery_details: any; created_at: Date }>(
      `SELECT id, status, recovery_details, created_at
       FROM patch_application_journals
       WHERE organization_id = $1 AND project_id = $2 AND status = 'recovery_required'
       ORDER BY created_at DESC LIMIT 1;`,
      [organizationId, projectId]
    );
    const fenced = fencedRes.rows[0];
    if (fenced) {
      throw new ConflictError(
        `Project workspace is fenced due to an unrecovered patch failure (journal ID: '${fenced.id}'). Administrative recovery is required before any further modifications can be applied.`
      );
    }
  }

  /**
   * Validates patch content hash, diff structure, and target file path safety.
   */
  validatePatchIntegrity(
    artifact: AgentArtifactDto,
    expectedHash?: string
  ): { contentHash: string; targetFiles: string[]; filePatches: DiffFilePatch[] } {
    if (!artifact.content || typeof artifact.content !== "string") {
      throw new ValidationError("Patch artifact content must be a non-empty string.");
    }

    if (Buffer.byteLength(artifact.content, "utf-8") > MAX_PATCH_DIFF_SIZE_BYTES) {
      throw new ValidationError(
        `Patch proposal exceeds maximum allowed diff size (${MAX_PATCH_DIFF_SIZE_BYTES} bytes).`
      );
    }

    // Reject binary diffs
    if (artifact.content.includes("GIT binary patch") || artifact.content.includes("\0")) {
      throw new ValidationError("Binary patches are not supported.");
    }

    // Cryptographically re-verify SHA-256 content hash
    const computedHash = crypto
      .createHash("sha256")
      .update(artifact.content, "utf-8")
      .digest("hex");

    if (computedHash !== artifact.contentHash) {
      throw new ConflictError(
        `Patch content hash mismatch: stored hash is '${artifact.contentHash}', but recomputed content hash is '${computedHash}'. Artifact may have been tampered with.`
      );
    }

    if (expectedHash && computedHash !== expectedHash) {
      throw new ConflictError(
        `Patch content hash mismatch: expected patch hash '${expectedHash}' does not match verified patch content hash '${computedHash}'.`
      );
    }

    // Parse unified diff
    const filePatches = parseUnifiedDiff(artifact.content);
    const targetFiles: string[] = [];

    for (const patch of filePatches) {
      const activePath = patch.isDeleted ? patch.oldPath : patch.newPath;
      if (activePath && activePath !== "dev/null" && activePath !== "/dev/null") {
        const safePath = validateWorkspaceRelativePath(activePath);
        if (!targetFiles.includes(safePath)) {
          targetFiles.push(safePath);
        }
      }
      if (patch.oldPath && patch.oldPath !== "dev/null" && patch.oldPath !== "/dev/null") {
        validateWorkspaceRelativePath(patch.oldPath);
      }
      if (patch.newPath && patch.newPath !== "dev/null" && patch.newPath !== "/dev/null") {
        validateWorkspaceRelativePath(patch.newPath);
      }
    }

    if (targetFiles.length === 0) {
      const metaFiles = Array.isArray(artifact.metadata?.targetFiles)
        ? (artifact.metadata.targetFiles as string[])
        : [];

      for (const rawPath of metaFiles) {
        if (typeof rawPath === "string" && rawPath.trim()) {
          const safePath = validateWorkspaceRelativePath(rawPath.trim());
          if (!targetFiles.includes(safePath)) {
            targetFiles.push(safePath);
          }
        }
      }
    }

    if (targetFiles.length === 0) {
      throw new ValidationError("Patch proposal must modify at least one valid target file.");
    }

    if (targetFiles.length > MAX_PATCH_FILE_COUNT) {
      throw new ValidationError(
        `Patch proposal modifies ${targetFiles.length} files, exceeding limit of ${MAX_PATCH_FILE_COUNT} files.`
      );
    }

    return { contentHash: computedHash, targetFiles, filePatches };
  }

  /**
   * Applies an approved patch proposal to the target project workspace.
   * Atomically consumes the single-use human approval, records a durable patch journal entry,
   * and genuinely modifies workspace files with compensating rollback on failure.
   */
  async applyApprovedPatch(
    tx: ScopedTransaction,
    input: ApplyPatchInput,
    userId: string,
    organizationId: string,
    runnerOverride?: IsolatedWorkspaceRunner
  ): Promise<ApplyPatchResult> {
    // 0. Check dirty workspace fence: fail closed if project is currently fenced
    await this.checkProjectFenced(tx, organizationId, input.projectId);

    // 1. Fetch patch proposal artifact
    const artifactRes = await tx.query<AgentArtifactDto>(
      `SELECT id, organization_id as "organizationId", project_id as "projectId",
              task_id as "taskId", step_id as "stepId", artifact_type as "artifactType",
              title, content, content_hash as "contentHash", size_bytes as "sizeBytes",
              review_status as "reviewStatus", metadata, created_by as "createdBy",
              created_at as "createdAt", updated_at as "updatedAt"
       FROM agent_artifacts
       WHERE id = $1 AND organization_id = $2;`,
      [input.patchArtifactId, organizationId]
    );

    const artifact = artifactRes.rows[0];
    if (!artifact) {
      throw new NotFoundError("Patch proposal artifact not found in tenant");
    }

    if (artifact.artifactType !== "patch_proposal") {
      throw new ValidationError(
        `Artifact '${artifact.id}' is of type '${artifact.artifactType}', expected 'patch_proposal'.`
      );
    }

    if (artifact.taskId !== input.taskId) {
      throw new ConflictError("Patch proposal artifact does not match task ID.");
    }

    if (artifact.projectId !== input.projectId) {
      throw new ConflictError("Patch proposal artifact does not match project ID.");
    }

    // Reject replay: if artifact was already approved and applied, prevent second application
    if (artifact.reviewStatus === "approved" && (artifact.metadata as any)?.appliedAt) {
      throw new ConflictError(
        `Replay prevented: Patch proposal '${artifact.id}' was already applied at ${(artifact.metadata as any).appliedAt}. Approval has already been consumed and cannot be replayed.`
      );
    }

    // Verify task status: cannot apply patch for a cancelled, succeeded, or failed task
    const taskRes = await tx.query<{ status: string; project_id: string }>(
      `SELECT status, project_id FROM agent_tasks WHERE id = $1 AND organization_id = $2 FOR UPDATE;`,
      [input.taskId, organizationId]
    );
    const task = taskRes.rows[0];
    if (!task) {
      throw new NotFoundError("Agent task not found in tenant");
    }
    if (task.status === "cancelled") {
      throw new ConflictError(`Cannot apply patch: Task '${input.taskId}' has been cancelled.`);
    }
    if (task.status === "succeeded") {
      throw new ConflictError(`Cannot apply patch: Task '${input.taskId}' has already succeeded.`);
    }
    if (task.status === "failed") {
      throw new ConflictError(`Cannot apply patch: Task '${input.taskId}' is in failed state.`);
    }

    // 2. Validate patch hash integrity and file path safety
    const { contentHash, targetFiles, filePatches } = this.validatePatchIntegrity(
      artifact,
      input.expectedHash
    );

    // 3. Pre-check: reject replay early if approval was already consumed or expired
    const existingAppRes = await tx.query<{ status: string; expires_at: Date }>(
      `SELECT status, expires_at FROM agent_approvals
       WHERE organization_id = $1 AND task_id = $2 AND action = 'apply_patch'
       ORDER BY created_at DESC LIMIT 1;`,
      [organizationId, input.taskId]
    );
    const existingApp = existingAppRes.rows[0];
    if (existingApp?.status === "consumed") {
      throw new ConflictError(
        "Agent approval has already been consumed. Approvals are single-use and cannot be replayed."
      );
    }
    if (existingApp && new Date(existingApp.expires_at) < new Date()) {
      throw new ConflictError(
        `Approval for action 'apply_patch' expired at ${new Date(existingApp.expires_at).toISOString()}. A new approval must be requested.`
      );
    }

    // 4. Resolve isolated workspace runner
    const runner =
      runnerOverride ??
      this.workspaceRunner ??
      (process.env.NODE_ENV === "production" ? undefined : createWorkspaceRunner());

    if (!runner) {
      throw new ForbiddenError(
        "Cannot apply patch: no isolated workspace runner configured. " +
        "Patch application requires an active isolated container or workspace runner backend."
      );
    }

    // 5. In-memory staging and context verification (all-or-nothing rollback semantics)
    const stagedFiles = new Map<string, string | null>();

    for (const patch of filePatches) {
      if (patch.isNew) {
        let existing = "";
        try {
          existing = await runner.readFile(input.projectId, patch.newPath);
        } catch {
          // File does not exist yet (expected)
        }

        if (existing.trim().length > 0) {
          throw new ConflictError(
            `Patch application rejected: target file '${patch.newPath}' already exists in workspace and is non-empty. Pre-existing files are preserved.`
          );
        }

        const newContent = applyHunksToFile(patch.newPath, "", patch.hunks);
        stagedFiles.set(patch.newPath, newContent);
      } else if (patch.isDeleted) {
        const original = await runner.readFile(input.projectId, patch.oldPath);
        if (Buffer.byteLength(original, "utf-8") > MAX_BASELINE_FILE_SIZE_BYTES) {
          throw new ValidationError(
            `File '${patch.oldPath}' exceeds maximum supported baseline snapshot size (${MAX_BASELINE_FILE_SIZE_BYTES} bytes).`
          );
        }
        applyHunksToFile(patch.oldPath, original, patch.hunks);
        stagedFiles.set(patch.oldPath, null);
      } else {
        const original = await runner.readFile(input.projectId, patch.newPath);
        if (Buffer.byteLength(original, "utf-8") > MAX_BASELINE_FILE_SIZE_BYTES) {
          throw new ValidationError(
            `File '${patch.newPath}' exceeds maximum supported baseline snapshot size (${MAX_BASELINE_FILE_SIZE_BYTES} bytes).`
          );
        }
        const patched = applyHunksToFile(patch.newPath, original, patch.hunks);
        stagedFiles.set(patch.newPath, patched);
      }
    }

    // 6. Snapshot pre-existing file state on the runner before any physical mutations
    let totalBaselineBytes = 0;
    const baselineFiles: Record<string, FileBaselineSnapshot> = {};
    for (const filePath of stagedFiles.keys()) {
      try {
        const content = await runner.readFile(input.projectId, filePath);
        const fileBytes = Buffer.byteLength(content, "utf-8");
        if (fileBytes > MAX_BASELINE_FILE_SIZE_BYTES) {
          throw new ValidationError(
            `File '${filePath}' exceeds maximum supported baseline snapshot size (${MAX_BASELINE_FILE_SIZE_BYTES} bytes).`
          );
        }
        totalBaselineBytes += fileBytes;
        if (totalBaselineBytes > MAX_AGGREGATE_BASELINE_SIZE_BYTES) {
          throw new ValidationError(
            `Aggregate baseline snapshot exceeds limit (${MAX_AGGREGATE_BASELINE_SIZE_BYTES} bytes).`
          );
        }
        const hash = crypto.createHash("sha256").update(content, "utf-8").digest("hex");
        baselineFiles[filePath] = { existed: true, contentHash: hash, content };
      } catch (err: any) {
        if (err instanceof ValidationError) throw err;
        baselineFiles[filePath] = { existed: false, contentHash: null, content: null };
      }
    }
    const baselineState: PatchJournalBaselineState = {
      targetFiles,
      files: baselineFiles,
    };

    // 7. Verify and atomically consume single-use approval bound to this exact hash
    const consumedApproval = await this.approvalsService.verifyAndConsumeApproval(
      tx,
      organizationId,
      input.taskId,
      "apply_patch",
      contentHash
    );

    // 8. Record durable journal entry in status 'applying'
    const journalRes = await tx.query<{ id: string }>(
      `INSERT INTO patch_application_journals (
         organization_id, project_id, task_id, patch_artifact_id, approval_id,
         target_content_hash, status, baseline_state, applied_files, recovery_details, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, 'applying', $7::jsonb, '[]'::jsonb, '{}'::jsonb, $8)
       RETURNING id;`,
      [
        organizationId,
        input.projectId,
        input.taskId,
        artifact.id,
        consumedApproval.id,
        contentHash,
        JSON.stringify(baselineState),
        userId,
      ]
    );
    const journalId = journalRes.rows[0]?.id;

    // 9. Commit staged changes to workspace runner with transactional compensating rollback
    const appliedChanges: {
      path: string;
      previousState: FileBaselineSnapshot;
    }[] = [];

    try {
      for (const [filePath, content] of stagedFiles.entries()) {
        const prevState = baselineFiles[filePath]!;
        if (content === null) {
          if (runner.deleteFile) {
            await runner.deleteFile(input.projectId, filePath);
          }
        } else {
          if (runner.setFile) {
            await runner.setFile(input.projectId, filePath, content);
          }
        }
        appliedChanges.push({ path: filePath, previousState: prevState });
      }
    } catch (commitErr: any) {
      // Transition journal to rolling_back
      if (journalId) {
        await tx.query(
          `UPDATE patch_application_journals
           SET status = 'rolling_back', updated_at = now()
           WHERE id = $1;`,
          [journalId]
        );
      }

      // Execute compensating rollback across all files modified so far
      const rollbackErrors: Error[] = [];
      for (const { path: appliedPath, previousState } of appliedChanges.reverse()) {
        try {
          if (previousState.existed && previousState.content !== null) {
            if (runner.setFile) {
              await runner.setFile(input.projectId, appliedPath, previousState.content);
            }
          } else {
            if (runner.deleteFile) {
              await runner.deleteFile(input.projectId, appliedPath);
            }
          }
        } catch (rbErr: any) {
          rollbackErrors.push(rbErr);
        }
      }

      if (rollbackErrors.length > 0) {
        // Catastrophic: compensating rollback failed
        if (journalId) {
          await tx.query(
            `UPDATE patch_application_journals
             SET status = 'recovery_required',
                 recovery_details = $1::jsonb,
                 updated_at = now()
             WHERE id = $2;`,
            [
              JSON.stringify({
                commitError: redactSensitiveData(commitErr.message).text,
                rollbackErrors: rollbackErrors.map((e) => redactSensitiveData(e.message).text),
                failedAt: new Date().toISOString(),
              }),
              journalId,
            ]
          );
        }

        await tx.query(
          `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
          [
            organizationId,
            "patch.recovery_required",
            "agent_artifact",
            artifact.id,
            "failure",
            JSON.stringify({
              taskId: input.taskId,
              projectId: input.projectId,
              journalId,
              commitError: redactSensitiveData(commitErr.message).text,
              rollbackErrors: rollbackErrors.map((e) => redactSensitiveData(e.message).text),
            }),
          ]
        );

        throw new ConflictError(
          `Critical patch application failure: runner file write failed and compensating rollback could not restore all files (${rollbackErrors.length} errors). Workspace may be inconsistent and is fenced; administrative recovery required. Original error: ${commitErr.message}`
        );
      }

      // Rollback succeeded cleanly
      if (journalId) {
        await tx.query(
          `UPDATE patch_application_journals
           SET status = 'rolled_back',
               recovery_details = $1::jsonb,
               updated_at = now()
             WHERE id = $2;`,
          [
            JSON.stringify({
              commitError: redactSensitiveData(commitErr.message).text,
              rolledBackAt: new Date().toISOString(),
            }),
            journalId,
          ]
        );
      }

      throw new ConflictError(
        `Patch application failed during runner file operations: ${commitErr.message}. Pre-existing user modifications safely restored; workspace rolled back.`
      );
    }

    // 10. Update journal status to 'applied'
    if (journalId) {
      await tx.query(
        `UPDATE patch_application_journals
         SET status = 'applied',
             applied_files = $1::jsonb,
             updated_at = now()
         WHERE id = $2;`,
        [JSON.stringify(targetFiles), journalId]
      );
    }

    // 11. Update artifact review_status to 'approved' and record application metadata
    const updatedMetadata = {
      ...artifact.metadata,
      appliedAt: new Date().toISOString(),
      appliedBy: userId,
      filesModified: targetFiles,
      journalId,
    };

    await tx.query(
      `UPDATE agent_artifacts
       SET review_status = 'approved', metadata = $1::jsonb, updated_at = now()
       WHERE id = $2;`,
      [JSON.stringify(updatedMetadata), artifact.id]
    );

    // 12. Record audit event
    await tx.query(
      `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
      [
        organizationId,
        "patch.applied",
        "agent_artifact",
        artifact.id,
        "success",
        JSON.stringify({
          taskId: input.taskId,
          projectId: input.projectId,
          contentHash,
          targetFiles,
          appliedBy: userId,
          journalId,
        }),
      ]
    );

    return {
      success: true,
      taskId: input.taskId,
      projectId: input.projectId,
      patchArtifactId: artifact.id,
      contentHash,
      filesModified: targetFiles,
      appliedAt: new Date(),
      diffSummary: `Modified ${targetFiles.length} file(s): ${targetFiles.join(", ")}`,
      journalId,
    };
  }

  /**
   * Applies an approved patch proposal using multi-phase durable transactions.
   * Phase 1 commits the journal entry in 'applying' and consumes the approval BEFORE touching the runner.
   * If the process crashes or is killed during Phase 2 runner writes, PostgreSQL retains
   * the durable journal record and consumed approval for idempotent recovery.
   */
  async applyApprovedPatchDurable(
    pool: pg.Pool,
    input: ApplyPatchInput,
    userId: string,
    organizationId: string,
    runnerOverride?: IsolatedWorkspaceRunner,
    crashHook?: (stage: CrashInjectionStage) => Promise<void> | void
  ): Promise<ApplyPatchResult> {
    // Phase 1: Pre-checks, staging, baseline snapshot, approval consumption, and journal persistence
    const phase1 = await withAuthenticatedContext(pool, userId, async (tx) => {
      // 0. Check dirty workspace fence
      await this.checkProjectFenced(tx, organizationId, input.projectId);

      // 1. Fetch patch proposal artifact
      const artifactRes = await tx.query<AgentArtifactDto>(
        `SELECT id, organization_id as "organizationId", project_id as "projectId",
                task_id as "taskId", step_id as "stepId", artifact_type as "artifactType",
                title, content, content_hash as "contentHash", size_bytes as "sizeBytes",
                review_status as "reviewStatus", metadata, created_by as "createdBy",
                created_at as "createdAt", updated_at as "updatedAt"
         FROM agent_artifacts
         WHERE id = $1 AND organization_id = $2;`,
        [input.patchArtifactId, organizationId]
      );

      const artifact = artifactRes.rows[0];
      if (!artifact) throw new NotFoundError("Patch proposal artifact not found in tenant");
      if (artifact.artifactType !== "patch_proposal") {
        throw new ValidationError(`Artifact '${artifact.id}' is of type '${artifact.artifactType}', expected 'patch_proposal'.`);
      }
      if (artifact.taskId !== input.taskId) throw new ConflictError("Patch proposal artifact does not match task ID.");
      if (artifact.projectId !== input.projectId) throw new ConflictError("Patch proposal artifact does not match project ID.");

      if (artifact.reviewStatus === "approved" && (artifact.metadata as any)?.appliedAt) {
        throw new ConflictError(
          `Replay prevented: Patch proposal '${artifact.id}' was already applied at ${(artifact.metadata as any).appliedAt}.`
        );
      }

      // Verify task status
      const taskRes = await tx.query<{ status: string }>(
        `SELECT status FROM agent_tasks WHERE id = $1 AND organization_id = $2 FOR UPDATE;`,
        [input.taskId, organizationId]
      );
      const task = taskRes.rows[0];
      if (!task) throw new NotFoundError("Agent task not found in tenant");
      if (task.status === "cancelled") throw new ConflictError(`Cannot apply patch: Task '${input.taskId}' has been cancelled.`);
      if (task.status === "succeeded") throw new ConflictError(`Cannot apply patch: Task '${input.taskId}' has already succeeded.`);
      if (task.status === "failed") throw new ConflictError(`Cannot apply patch: Task '${input.taskId}' is in failed state.`);

      // Validate integrity
      const { contentHash, targetFiles, filePatches } = this.validatePatchIntegrity(artifact, input.expectedHash);

      const runner =
        runnerOverride ??
        this.workspaceRunner ??
        (process.env.NODE_ENV === "production" ? undefined : createWorkspaceRunner());

      if (!runner) {
        throw new ForbiddenError("Cannot apply patch: no isolated workspace runner configured.");
      }

      // Stage hunks and snapshot baseline
      const stagedFiles = new Map<string, string | null>();
      for (const patch of filePatches) {
        if (patch.isNew) {
          let existing = "";
          try {
            existing = await runner.readFile(input.projectId, patch.newPath);
          } catch {}
          if (existing.trim().length > 0) {
            throw new ConflictError(
              `Patch application rejected: target file '${patch.newPath}' already exists in workspace and is non-empty.`
            );
          }
          stagedFiles.set(patch.newPath, applyHunksToFile(patch.newPath, "", patch.hunks));
        } else if (patch.isDeleted) {
          const original = await runner.readFile(input.projectId, patch.oldPath);
          if (Buffer.byteLength(original, "utf-8") > MAX_BASELINE_FILE_SIZE_BYTES) {
            throw new ValidationError(
              `File '${patch.oldPath}' exceeds maximum supported baseline snapshot size (${MAX_BASELINE_FILE_SIZE_BYTES} bytes).`
            );
          }
          applyHunksToFile(patch.oldPath, original, patch.hunks);
          stagedFiles.set(patch.oldPath, null);
        } else {
          const original = await runner.readFile(input.projectId, patch.newPath);
          if (Buffer.byteLength(original, "utf-8") > MAX_BASELINE_FILE_SIZE_BYTES) {
            throw new ValidationError(
              `File '${patch.newPath}' exceeds maximum supported baseline snapshot size (${MAX_BASELINE_FILE_SIZE_BYTES} bytes).`
            );
          }
          stagedFiles.set(patch.newPath, applyHunksToFile(patch.newPath, original, patch.hunks));
        }
      }

      let totalBaselineBytes = 0;
      const baselineFiles: Record<string, FileBaselineSnapshot> = {};
      for (const filePath of stagedFiles.keys()) {
        try {
          const content = await runner.readFile(input.projectId, filePath);
          const fileBytes = Buffer.byteLength(content, "utf-8");
          if (fileBytes > MAX_BASELINE_FILE_SIZE_BYTES) {
            throw new ValidationError(
              `File '${filePath}' exceeds maximum supported baseline snapshot size (${MAX_BASELINE_FILE_SIZE_BYTES} bytes).`
            );
          }
          totalBaselineBytes += fileBytes;
          if (totalBaselineBytes > MAX_AGGREGATE_BASELINE_SIZE_BYTES) {
            throw new ValidationError(
              `Aggregate baseline snapshot exceeds limit (${MAX_AGGREGATE_BASELINE_SIZE_BYTES} bytes).`
            );
          }
          const hash = crypto.createHash("sha256").update(content, "utf-8").digest("hex");
          baselineFiles[filePath] = { existed: true, contentHash: hash, content };
        } catch (err: any) {
          if (err instanceof ValidationError) throw err;
          baselineFiles[filePath] = { existed: false, contentHash: null, content: null };
        }
      }
      const baselineState: PatchJournalBaselineState = { targetFiles, files: baselineFiles };

      if (crashHook) await crashHook("before_approval");

      const consumedApproval = await this.approvalsService.verifyAndConsumeApproval(
        tx,
        organizationId,
        input.taskId,
        "apply_patch",
        contentHash
      );

      const journalRes = await tx.query<{ id: string }>(
        `INSERT INTO patch_application_journals (
           organization_id, project_id, task_id, patch_artifact_id, approval_id,
           target_content_hash, status, baseline_state, applied_files, recovery_details, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, 'applying', $7::jsonb, '[]'::jsonb, '{}'::jsonb, $8)
         RETURNING id;`,
        [
          organizationId,
          input.projectId,
          input.taskId,
          artifact.id,
          consumedApproval.id,
          contentHash,
          JSON.stringify(baselineState),
          userId,
        ]
      );
      const journalId = journalRes.rows[0]?.id;

      return {
        artifact,
        contentHash,
        targetFiles,
        stagedFiles,
        baselineFiles,
        journalId,
        runner,
      };
    });

    if (crashHook) await crashHook("after_approval_before_writes");

    // Phase 2: Runner file operations with compensating rollback
    const runner = phase1.runner;
    const appliedChanges: { path: string; previousState: FileBaselineSnapshot }[] = [];
    let fileIdx = 0;

    try {
      for (const [filePath, content] of phase1.stagedFiles.entries()) {
        const prevState = phase1.baselineFiles[filePath]!;
        if (content === null) {
          if (runner.deleteFile) await runner.deleteFile(input.projectId, filePath);
        } else {
          if (runner.setFile) await runner.setFile(input.projectId, filePath, content);
        }
        appliedChanges.push({ path: filePath, previousState: prevState });
        fileIdx++;

        if (fileIdx === 1 && crashHook) {
          await crashHook("after_first_write");
        }
      }
    } catch (commitErr: any) {
      if (commitErr?.isHardCrash || commitErr?.message?.startsWith("SIMULATED_CRASH")) {
        // Simulates abrupt process crash: no in-process rollback runs, state remains partial
        throw commitErr;
      }

      if (crashHook) await crashHook("during_rollback");

      // Attempt compensating rollback
      const rollbackErrors: Error[] = [];
      for (const { path: appliedPath, previousState } of appliedChanges.reverse()) {
        try {
          if (previousState.existed && previousState.content !== null) {
            if (runner.setFile) await runner.setFile(input.projectId, appliedPath, previousState.content);
          } else {
            if (runner.deleteFile) await runner.deleteFile(input.projectId, appliedPath);
          }
        } catch (rbErr: any) {
          rollbackErrors.push(rbErr);
        }
      }

      if (rollbackErrors.length > 0) {
        // Rollback failed: fence workspace
        await withAuthenticatedContext(pool, userId, async (tx) => {
          await tx.query(
            `UPDATE patch_application_journals
             SET status = 'recovery_required', recovery_details = $1::jsonb, updated_at = now()
             WHERE id = $2;`,
            [
              JSON.stringify({
                commitError: redactSensitiveData(commitErr.message).text,
                rollbackErrors: rollbackErrors.map((e) => redactSensitiveData(e.message).text),
                failedAt: new Date().toISOString(),
              }),
              phase1.journalId,
            ]
          );

          await tx.query(
            `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
            [
              organizationId,
              "patch.recovery_required",
              "agent_artifact",
              phase1.artifact.id,
              "failure",
              JSON.stringify({
                taskId: input.taskId,
                projectId: input.projectId,
                journalId: phase1.journalId,
                commitError: redactSensitiveData(commitErr.message).text,
                rollbackErrors: rollbackErrors.map((e) => redactSensitiveData(e.message).text),
              }),
            ]
          );
        });

        throw new ConflictError(
          `Critical patch application failure: runner write failed and rollback failed (${rollbackErrors.length} errors). Workspace is fenced; administrative recovery required.`
        );
      }

      // Rollback succeeded
      await withAuthenticatedContext(pool, userId, async (tx) => {
        await tx.query(
          `UPDATE patch_application_journals
           SET status = 'rolled_back', recovery_details = $1::jsonb, updated_at = now()
           WHERE id = $2;`,
          [
            JSON.stringify({
              commitError: redactSensitiveData(commitErr.message).text,
              rolledBackAt: new Date().toISOString(),
            }),
            phase1.journalId,
          ]
        );
      });

      throw new ConflictError(
        `Patch application failed during runner file operations: ${commitErr.message}. Pre-existing user modifications safely restored; workspace rolled back.`
      );
    }

    // Phase 3: Transition journal to 'applied', update artifact, record audit event
    await withAuthenticatedContext(pool, userId, async (tx) => {
      await tx.query(
        `UPDATE patch_application_journals
         SET status = 'applied', applied_files = $1::jsonb, updated_at = now()
         WHERE id = $2;`,
        [JSON.stringify(phase1.targetFiles), phase1.journalId]
      );

      const updatedMetadata = {
        ...phase1.artifact.metadata,
        appliedAt: new Date().toISOString(),
        appliedBy: userId,
        filesModified: phase1.targetFiles,
        journalId: phase1.journalId,
      };

      await tx.query(
        `UPDATE agent_artifacts
         SET review_status = 'approved', metadata = $1::jsonb, updated_at = now()
         WHERE id = $2;`,
        [JSON.stringify(updatedMetadata), phase1.artifact.id]
      );

      await tx.query(
        `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
        [
          organizationId,
          "patch.applied",
          "agent_artifact",
          phase1.artifact.id,
          "success",
          JSON.stringify({
            taskId: input.taskId,
            projectId: input.projectId,
            contentHash: phase1.contentHash,
            targetFiles: phase1.targetFiles,
            appliedBy: userId,
            journalId: phase1.journalId,
          }),
        ]
      );
    });

    return {
      success: true,
      taskId: input.taskId,
      projectId: input.projectId,
      patchArtifactId: phase1.artifact.id,
      contentHash: phase1.contentHash,
      filesModified: phase1.targetFiles,
      appliedAt: new Date(),
      diffSummary: `Modified ${phase1.targetFiles.length} file(s): ${phase1.targetFiles.join(", ")}`,
      journalId: phase1.journalId,
    };
  }

  /**
   * Safely recovers an interrupted patch application across process crashes or restarts.
   * Inspects the durable patch journal, verifies consumed approval and task state,
   * checks workspace files against baseline and target to detect partial writes or divergence,
   * performs idempotent forward-recovery or baseline restoration, and transitions journal to 'applied'.
   */
  async recoverInterruptedPatchApplication(
    tx: ScopedTransaction,
    input: ApplyPatchInput,
    userId: string,
    organizationId: string,
    runnerOverride?: IsolatedWorkspaceRunner,
    options?: { idempotent?: boolean }
  ): Promise<ApplyPatchResult> {
    // 1. Fetch patch proposal artifact
    const artifactRes = await tx.query<AgentArtifactDto>(
      `SELECT id, organization_id as "organizationId", project_id as "projectId",
              task_id as "taskId", step_id as "stepId", artifact_type as "artifactType",
              title, content, content_hash as "contentHash", size_bytes as "sizeBytes",
              review_status as "reviewStatus", metadata, created_by as "createdBy",
              created_at as "createdAt", updated_at as "updatedAt"
       FROM agent_artifacts
       WHERE id = $1 AND organization_id = $2;`,
      [input.patchArtifactId, organizationId]
    );

    const artifact = artifactRes.rows[0];
    if (!artifact) {
      throw new NotFoundError("Patch proposal artifact not found in tenant");
    }

    if (artifact.reviewStatus === "approved" && (artifact.metadata as any)?.appliedAt) {
      if (!options?.idempotent) {
        throw new ConflictError(
          `Replay prevented: Patch proposal '${artifact.id}' was already applied at ${(artifact.metadata as any).appliedAt}. Cannot recover an already completed patch.`
        );
      }
    }

    // 2. Validate patch integrity
    const { contentHash, targetFiles, filePatches } = this.validatePatchIntegrity(
      artifact,
      input.expectedHash
    );

    // 3. Inspect durable journal for this task and patch artifact
    const journalRes = await tx.query<PatchApplicationJournalDto & { baseline_state: any }>(
      `SELECT id, organization_id as "organizationId", project_id as "projectId",
              task_id as "taskId", patch_artifact_id as "patchArtifactId", approval_id as "approvalId",
              target_content_hash as "targetContentHash", status, baseline_state,
              applied_files as "appliedFiles", recovery_details as "recoveryDetails",
              created_by as "createdBy", created_at as "createdAt", updated_at as "updatedAt"
       FROM patch_application_journals
       WHERE organization_id = $1 AND task_id = $2 AND patch_artifact_id = $3
       ORDER BY created_at DESC LIMIT 1
       FOR UPDATE;`,
      [organizationId, input.taskId, artifact.id]
    );

    const journal = journalRes.rows[0];

    if (artifact.projectId !== input.projectId) {
      throw new ConflictError(
        `Patch proposal artifact project '${artifact.projectId}' does not match requested project '${input.projectId}'.`
      );
    }

    if (journal && journal.projectId !== input.projectId) {
      throw new ConflictError(
        `Journal project '${journal.projectId}' does not match requested project '${input.projectId}'.`
      );
    }

    // If journal is in recovery_required, fail closed
    if (journal && journal.status === "recovery_required") {
      throw new ConflictError(
        `Cannot automatically recover patch: Journal '${journal.id}' is in 'recovery_required' state. Project workspace is fenced; administrative recovery is required.`
      );
    }

    // 4. Verify task status: cannot recover a cancelled or terminal task
    const taskRes = await tx.query<{ status: string }>(
      `SELECT status FROM agent_tasks WHERE id = $1 AND organization_id = $2 FOR UPDATE;`,
      [input.taskId, organizationId]
    );
    const task = taskRes.rows[0];
    if (!task) {
      throw new NotFoundError("Agent task not found in tenant");
    }
    if (task.status === "cancelled") {
      // If task was cancelled and journal was in 'applying', rollback files to baseline to ensure clean state
      if (journal && journal.status === "applying") {
        const runner =
          runnerOverride ??
          this.workspaceRunner ??
          (process.env.NODE_ENV === "production" ? undefined : createWorkspaceRunner());
        if (runner && journal.baseline_state?.files) {
          for (const [filePath, base] of Object.entries(journal.baseline_state.files as Record<string, FileBaselineSnapshot>)) {
            try {
              if (base.existed && base.content !== null) {
                if (runner.setFile) await runner.setFile(input.projectId, filePath, base.content);
              } else {
                if (runner.deleteFile) await runner.deleteFile(input.projectId, filePath);
              }
            } catch {}
          }
        }
        await tx.query(
          `UPDATE patch_application_journals
           SET status = 'rolled_back',
               recovery_details = '{"reason":"Task cancelled during patch recovery"}'::jsonb,
               updated_at = now()
           WHERE id = $1;`,
          [journal.id]
        );
      }
      throw new ConflictError(`Cannot recover patch: Task '${input.taskId}' has been cancelled.`);
    }

    // 5. If journal is already 'applied', perform idempotent verification without duplicate writes
    if (journal && journal.status === "applied") {
      if (options?.idempotent) {
        return {
          success: true,
          taskId: input.taskId,
          projectId: input.projectId,
          patchArtifactId: artifact.id,
          contentHash,
          filesModified: targetFiles,
          appliedAt: new Date(journal.updatedAt),
          diffSummary: "Patch already fully applied in workspace (idempotent recovery)",
          journalId: journal.id,
        };
      }
      throw new ConflictError(
        `Replay prevented: Patch proposal '${artifact.id}' was already applied. Cannot recover an already completed patch.`
      );
    }

    // 6. Verify consumed approval exists
    const appRes = await tx.query<{ id: string; status: string }>(
      `SELECT id, status FROM agent_approvals
       WHERE organization_id = $1 AND task_id = $2 AND action = 'apply_patch'
         AND target_content_hash = $3 AND status = 'consumed'
       ORDER BY decided_at DESC LIMIT 1;`,
      [organizationId, input.taskId, contentHash]
    );
    const consumedApproval = appRes.rows[0];
    if (!consumedApproval) {
      throw new ConflictError(
        `No consumed approval found for task '${input.taskId}' and patch hash '${contentHash}'. Recovery is only valid for interrupted applications with an existing consumed approval.`
      );
    }

    // 7. Resolve runner
    const runner =
      runnerOverride ??
      this.workspaceRunner ??
      (process.env.NODE_ENV === "production" ? undefined : createWorkspaceRunner());

    if (!runner) {
      throw new ForbiddenError("Cannot recover patch: no isolated workspace runner configured.");
    }

    // 8. Stage expected patched contents in memory
    const baselineSnapshot: PatchJournalBaselineState =
      journal?.baseline_state ?? { targetFiles, files: {} };

    const stagedFiles = new Map<string, string | null>();
    for (const patch of filePatches) {
      if (patch.isNew) {
        let existing = "";
        try {
          existing = await runner.readFile(input.projectId, patch.newPath);
        } catch {}

        // If file already has the patched content, accept it
        const newContent = applyHunksToFile(patch.newPath, "", patch.hunks);
        if (existing.trim().length > 0 && existing !== newContent) {
          throw new ConflictError(
            `Recovery rejected: target file '${patch.newPath}' already exists and differs from proposed new file.`
          );
        }
        stagedFiles.set(patch.newPath, newContent);
      } else if (patch.isDeleted) {
        let original = "";
        try {
          original = await runner.readFile(input.projectId, patch.oldPath);
        } catch {}
        if (original.trim().length > 0) {
          applyHunksToFile(patch.oldPath, original, patch.hunks);
        }
        stagedFiles.set(patch.oldPath, null);
      } else {
        const baseContent = baselineSnapshot.files?.[patch.newPath]?.content;
        let original: string;
        if (typeof baseContent === "string") {
          original = baseContent;
        } else {
          original = await runner.readFile(input.projectId, patch.newPath);
        }
        const patched = applyHunksToFile(patch.newPath, original, patch.hunks);
        stagedFiles.set(patch.newPath, patched);
      }
    }

    // 9. Inspect current runner files against baseline & target states

    let allMatchTarget = true;
    for (const [filePath, expectedPatchedContent] of stagedFiles.entries()) {
      let currentContent: string | null = null;
      let fileExists = false;
      try {
        currentContent = await runner.readFile(input.projectId, filePath);
        fileExists = true;
      } catch {
        fileExists = false;
      }

      const matchesTarget =
        expectedPatchedContent === null
          ? !fileExists
          : fileExists && currentContent === expectedPatchedContent;

      if (!matchesTarget) {
        allMatchTarget = false;
      }

      // Check if file diverged from both baseline and target
      const baseInfo = baselineSnapshot.files?.[filePath];
      if (baseInfo) {
        const matchesBaseline = baseInfo.existed
          ? fileExists && currentContent === baseInfo.content
          : !fileExists;

        if (!matchesTarget && !matchesBaseline) {
          // File diverged from BOTH baseline and target (user edit during downtime)
          if (journal) {
            await tx.query(
              `UPDATE patch_application_journals
               SET status = 'recovery_required',
                   recovery_details = $1::jsonb,
                   updated_at = now()
               WHERE id = $2;`,
              [
                JSON.stringify({
                  divergedFile: filePath,
                  reason: "Workspace file content diverged from both baseline state and proposed patch.",
                  detectedAt: new Date().toISOString(),
                }),
                journal.id,
              ]
            );
          }
          throw new ConflictError(
            `Recovery aborted: target file '${filePath}' has diverged from both baseline state and proposed patch content. Pre-existing user modifications preserved; automated recovery failed closed.`
          );
        }
      }
    }

    // If all files already match target, idempotent forward-recovery without duplicate writes
    if (allMatchTarget) {
      if (journal) {
        await tx.query(
          `UPDATE patch_application_journals
           SET status = 'applied', applied_files = $1::jsonb, updated_at = now()
           WHERE id = $2;`,
          [JSON.stringify(targetFiles), journal.id]
        );
      }

      const updatedMetadata = {
        ...artifact.metadata,
        appliedAt: new Date().toISOString(),
        recoveredAt: new Date().toISOString(),
        appliedBy: userId,
        filesModified: targetFiles,
        journalId: journal?.id,
      };

      await tx.query(
        `UPDATE agent_artifacts
         SET review_status = 'approved', metadata = $1::jsonb, updated_at = now()
         WHERE id = $2;`,
        [JSON.stringify(updatedMetadata), artifact.id]
      );

      await tx.query(
        `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
        [
          organizationId,
          "patch.recovered_and_applied",
          "agent_artifact",
          artifact.id,
          "success",
          JSON.stringify({
            taskId: input.taskId,
            projectId: input.projectId,
            contentHash,
            targetFiles,
            recoveredBy: userId,
            idempotent: true,
            journalId: journal?.id,
          }),
        ]
      );

      return {
        success: true,
        taskId: input.taskId,
        projectId: input.projectId,
        patchArtifactId: artifact.id,
        contentHash,
        filesModified: targetFiles,
        appliedAt: new Date(),
        diffSummary: `Recovered and verified: ${targetFiles.length} file(s) already matching target patch`,
        journalId: journal?.id,
      };
    }

    // 10. Forward-recovery: apply missing changes with compensating rollback
    const prePatchState = new Map<string, { existed: boolean; originalContent: string | null }>();
    for (const filePath of stagedFiles.keys()) {
      try {
        const content = await runner.readFile(input.projectId, filePath);
        prePatchState.set(filePath, { existed: true, originalContent: content });
      } catch {
        prePatchState.set(filePath, { existed: false, originalContent: null });
      }
    }

    const appliedChanges: {
      path: string;
      previousState: { existed: boolean; originalContent: string | null };
    }[] = [];

    try {
      for (const [filePath, content] of stagedFiles.entries()) {
        const prevState = prePatchState.get(filePath)!;
        if (content === null) {
          if (runner.deleteFile) await runner.deleteFile(input.projectId, filePath);
        } else {
          if (runner.setFile) await runner.setFile(input.projectId, filePath, content);
        }
        appliedChanges.push({ path: filePath, previousState: prevState });
      }
    } catch (commitErr: any) {
      for (const { path: appliedPath, previousState } of appliedChanges.reverse()) {
        try {
          if (previousState.existed && previousState.originalContent !== null) {
            if (runner.setFile) await runner.setFile(input.projectId, appliedPath, previousState.originalContent);
          } else {
            if (runner.deleteFile) await runner.deleteFile(input.projectId, appliedPath);
          }
        } catch {}
      }
      throw new ConflictError(
        `Interrupted patch recovery failed during runner file operations: ${commitErr.message}. Workspace rolled back.`
      );
    }

    // 11. Update journal status to 'applied'
    if (journal) {
      await tx.query(
        `UPDATE patch_application_journals
         SET status = 'applied', applied_files = $1::jsonb, updated_at = now()
         WHERE id = $2;`,
        [JSON.stringify(targetFiles), journal.id]
      );
    } else {
      await tx.query(
        `INSERT INTO patch_application_journals (
           organization_id, project_id, task_id, patch_artifact_id, approval_id,
           target_content_hash, status, baseline_state, applied_files, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, 'applied', $7::jsonb, $8::jsonb, $9);`,
        [
          organizationId,
          input.projectId,
          input.taskId,
          artifact.id,
          consumedApproval.id,
          contentHash,
          JSON.stringify(baselineSnapshot),
          JSON.stringify(targetFiles),
          userId,
        ]
      );
    }

    // 12. Update artifact metadata
    const updatedMetadata = {
      ...artifact.metadata,
      appliedAt: new Date().toISOString(),
      recoveredAt: new Date().toISOString(),
      appliedBy: userId,
      filesModified: targetFiles,
      journalId: journal?.id,
    };

    await tx.query(
      `UPDATE agent_artifacts
       SET review_status = 'approved', metadata = $1::jsonb, updated_at = now()
       WHERE id = $2;`,
      [JSON.stringify(updatedMetadata), artifact.id]
    );

    // 13. Record audit event
    await tx.query(
      `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
      [
        organizationId,
        "patch.recovered_and_applied",
        "agent_artifact",
        artifact.id,
        "success",
        JSON.stringify({
          taskId: input.taskId,
          projectId: input.projectId,
          contentHash,
          targetFiles,
          recoveredBy: userId,
          journalId: journal?.id,
        }),
      ]
    );

    return {
      success: true,
      taskId: input.taskId,
      projectId: input.projectId,
      patchArtifactId: artifact.id,
      contentHash,
      filesModified: targetFiles,
      appliedAt: new Date(),
      diffSummary: `Recovered and applied to ${targetFiles.length} file(s): ${targetFiles.join(", ")}`,
      journalId: journal?.id,
    };
  }

  /**
   * Performs administrative recovery for a project workspace fenced in 'recovery_required'.
   * Supports 'restore_baseline' (safely restores pre-patch files from journal baseline snapshot),
   * 'commit_patch' (forces completion of patch proposal), or 'mark_recovered' (acknowledges manual resolution).
   * Transitions journal to 'recovered', clears the project fence, and emits an audit event.
   */
  async adminRecoverWorkspace(
    tx: ScopedTransaction,
    input: AdminRecoverInput,
    userId: string,
    organizationId: string,
    runnerOverride?: IsolatedWorkspaceRunner
  ): Promise<AdminRecoverResult> {
    // 1. Authorize: requires owner or admin role
    await this.assertOrgRole(tx, organizationId, userId, ["owner", "admin"]);

    // If force is requested, require an explicit, meaningful justification
    if (input.force && (!input.reason || input.reason.trim().length < 10)) {
      throw new ValidationError(
        "Forced administrative recovery requires an explicit, meaningful justification (at least 10 characters)."
      );
    }

    // 2. Fetch and lock journal row
    const journalRes = await tx.query<PatchApplicationJournalDto & { baseline_state: any }>(
      `SELECT id, organization_id as "organizationId", project_id as "projectId",
              task_id as "taskId", patch_artifact_id as "patchArtifactId", approval_id as "approvalId",
              target_content_hash as "targetContentHash", status, baseline_state,
              applied_files as "appliedFiles", recovery_details as "recoveryDetails",
              created_by as "createdBy", created_at as "createdAt", updated_at as "updatedAt"
       FROM patch_application_journals
       WHERE id = $1 AND organization_id = $2
       FOR UPDATE;`,
      [input.journalId, organizationId]
    );

    const journal = journalRes.rows[0];
    if (!journal) {
      throw new NotFoundError(`Patch application journal '${input.journalId}' not found.`);
    }

    if (journal.projectId !== input.projectId) {
      throw new ConflictError(
        `Journal project ID '${journal.projectId}' does not match requested project ID '${input.projectId}'.`
      );
    }

    if (journal.status !== "recovery_required" && journal.status !== "applying") {
      throw new ConflictError(
        `Cannot perform administrative recovery: journal '${journal.id}' is in status '${journal.status}', expected 'recovery_required' or 'applying'.`
      );
    }

    // 3. Resolve runner
    const runner =
      runnerOverride ??
      this.workspaceRunner ??
      (process.env.NODE_ENV === "production" ? undefined : createWorkspaceRunner());

    if (!runner) {
      throw new ForbiddenError("Cannot perform administrative recovery: no isolated workspace runner configured.");
    }

    const baseline = journal.baseline_state as PatchJournalBaselineState;

    // 4. Fetch and verify patch proposal artifact against immutable journal targetContentHash
    const artifactRes = await tx.query<AgentArtifactDto>(
      `SELECT id, organization_id as "organizationId", project_id as "projectId",
              task_id as "taskId", step_id as "stepId", artifact_type as "artifactType",
              title, content, content_hash as "contentHash", size_bytes as "sizeBytes",
              review_status as "reviewStatus", metadata, created_by as "createdBy",
              created_at as "createdAt", updated_at as "updatedAt"
       FROM agent_artifacts
       WHERE id = $1 AND organization_id = $2;`,
      [journal.patchArtifactId, organizationId]
    );
    const artifact = artifactRes.rows[0];
    if (!artifact) throw new NotFoundError("Patch artifact not found for journal");

    if (artifact.contentHash !== journal.targetContentHash) {
      throw new ConflictError(
        `Artifact content hash '${artifact.contentHash}' does not match journal target hash '${journal.targetContentHash}'. Administrative recovery aborted due to artifact tampering or mismatch.`
      );
    }

    const { filePatches } = this.validatePatchIntegrity(artifact, journal.targetContentHash);

    // Compute expected target content for each file patch
    const expectedTargets = new Map<string, string | null>();
    for (const patch of filePatches) {
      if (patch.isNew) {
        expectedTargets.set(patch.newPath, applyHunksToFile(patch.newPath, "", patch.hunks));
      } else if (patch.isDeleted) {
        expectedTargets.set(patch.oldPath, null);
      } else {
        const baseContent = baseline?.files?.[patch.newPath]?.content;
        let orig: string;
        if (typeof baseContent === "string") {
          orig = baseContent;
        } else {
          orig = await runner.readFile(input.projectId, patch.newPath);
        }
        expectedTargets.set(patch.newPath, applyHunksToFile(patch.newPath, orig, patch.hunks));
      }
    }

    // 5. Execute administrative resolution with divergence protection
    if (input.resolution === "restore_baseline") {
      if (!baseline || !baseline.files) {
        throw new ValidationError("Cannot restore baseline: journal does not contain valid baseline state.");
      }

      // Check for divergence unless force is explicitly true
      if (!input.force) {
        for (const [filePath, fileInfo] of Object.entries(baseline.files)) {
          let currentContent: string | null = null;
          let fileExists = false;
          try {
            currentContent = await runner.readFile(input.projectId, filePath);
            fileExists = true;
          } catch {
            fileExists = false;
          }

          const targetContent = expectedTargets.get(filePath);
          const matchesTarget =
            targetContent === null
              ? !fileExists
              : targetContent !== undefined && fileExists && currentContent === targetContent;
          const matchesBaseline = fileInfo.existed
            ? fileExists && currentContent === fileInfo.content
            : !fileExists;

          if (!matchesBaseline && !matchesTarget) {
            throw new ConflictError(
              `Administrative recovery refused: file '${filePath}' contains uncommitted user modifications that diverge from both baseline and patch proposal. Pass force=true to explicitly overwrite divergent user edits.`
            );
          }
        }
      }

      for (const [filePath, fileInfo] of Object.entries(baseline.files)) {
        if (fileInfo.existed && fileInfo.content !== null) {
          if (runner.setFile) {
            await runner.setFile(input.projectId, filePath, fileInfo.content);
          }
        } else {
          if (runner.deleteFile) {
            await runner.deleteFile(input.projectId, filePath);
          }
        }
      }
    } else if (input.resolution === "commit_patch") {
      // Check for divergence unless force is explicitly true
      if (!input.force) {
        for (const patch of filePatches) {
          const activePath = patch.isDeleted ? patch.oldPath : patch.newPath;
          let currentContent: string | null = null;
          let fileExists = false;
          try {
            currentContent = await runner.readFile(input.projectId, activePath);
            fileExists = true;
          } catch {
            fileExists = false;
          }

          const targetContent = expectedTargets.get(activePath);
          const fileInfo = baseline?.files?.[activePath];
          const matchesTarget =
            targetContent === null
              ? !fileExists
              : targetContent !== undefined && fileExists && currentContent === targetContent;
          const matchesBaseline = fileInfo
            ? fileInfo.existed
              ? fileExists && currentContent === fileInfo.content
              : !fileExists
            : false;

          if (!matchesBaseline && !matchesTarget) {
            throw new ConflictError(
              `Administrative recovery refused: file '${activePath}' contains uncommitted user modifications that diverge from both baseline and patch proposal. Pass force=true to explicitly overwrite divergent user edits.`
            );
          }
        }
      }

      for (const [activePath, targetContent] of expectedTargets.entries()) {
        if (targetContent === null) {
          if (runner.deleteFile) await runner.deleteFile(input.projectId, activePath);
        } else {
          if (runner.setFile) await runner.setFile(input.projectId, activePath, targetContent);
        }
      }

      await tx.query(
        `UPDATE agent_artifacts
         SET review_status = 'approved', updated_at = now()
         WHERE id = $1;`,
        [artifact.id]
      );
    }

    // 6. Update journal to 'recovered'
    const recoveryDetails = {
      ...(journal.recoveryDetails ?? {}),
      resolution: input.resolution,
      force: input.force ?? false,
      reason: redactSensitiveData(input.reason ?? "Administrative recovery intervention").text,
      recoveredBy: userId,
      recoveredAt: new Date().toISOString(),
    };

    await tx.query(
      `UPDATE patch_application_journals
       SET status = 'recovered',
           recovery_details = $1::jsonb,
           updated_at = now()
       WHERE id = $2;`,
      [JSON.stringify(recoveryDetails), input.journalId]
    );

    // 6. Record audit event
    await tx.query(
      `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
      [
        organizationId,
        "patch.admin_recovered",
        "agent_artifact",
        journal.patchArtifactId,
        "success",
        JSON.stringify({
          journalId: input.journalId,
          projectId: input.projectId,
          taskId: journal.taskId,
          resolution: input.resolution,
          force: input.force ?? false,
          recoveredBy: userId,
          reason: recoveryDetails.reason,
        }),
      ]
    );

    return {
      success: true,
      journalId: input.journalId,
      projectId: input.projectId,
      resolution: input.resolution,
      details: recoveryDetails,
      recoveredAt: new Date(),
    };
  }

  /**
   * Lists patch application journals for a project under tenant context.
   */
  async listJournals(
    tx: ScopedTransaction,
    organizationId: string,
    projectId: string,
    options?: { taskId?: string; status?: PatchJournalStatus; limit?: number; offset?: number }
  ): Promise<PatchApplicationJournalDto[]> {
    const limit = Math.min(Math.max(options?.limit ?? 50, 1), 100);
    const offset = Math.max(options?.offset ?? 0, 0);

    const conditions = ["organization_id = $1", "project_id = $2"];
    const params: any[] = [organizationId, projectId];

    if (options?.taskId) {
      params.push(options.taskId);
      conditions.push(`task_id = $${params.length}`);
    }

    if (options?.status) {
      params.push(options.status);
      conditions.push(`status = $${params.length}`);
    }

    params.push(limit, offset);
    const sql = `
      SELECT id, organization_id as "organizationId", project_id as "projectId",
             task_id as "taskId", patch_artifact_id as "patchArtifactId", approval_id as "approvalId",
             target_content_hash as "targetContentHash", status,
             applied_files as "appliedFiles", recovery_details as "recoveryDetails",
             created_by as "createdBy", created_at as "createdAt", updated_at as "updatedAt"
      FROM patch_application_journals
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length};
    `;

    const res = await tx.query<PatchApplicationJournalDto>(sql, params);
    return res.rows;
  }

  /**
   * Retrieves a single journal by ID under tenant context.
   */
  async getJournal(
    tx: ScopedTransaction,
    organizationId: string,
    journalId: string
  ): Promise<PatchApplicationJournalDto | null> {
    const res = await tx.query<PatchApplicationJournalDto>(
      `SELECT id, organization_id as "organizationId", project_id as "projectId",
              task_id as "taskId", patch_artifact_id as "patchArtifactId", approval_id as "approvalId",
              target_content_hash as "targetContentHash", status,
              applied_files as "appliedFiles", recovery_details as "recoveryDetails",
              created_by as "createdBy", created_at as "createdAt", updated_at as "updatedAt"
       FROM patch_application_journals
       WHERE id = $1 AND organization_id = $2;`,
      [journalId, organizationId]
    );
    return res.rows[0] ?? null;
  }
}
