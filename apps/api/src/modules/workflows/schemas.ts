import { z } from "zod";

export const ProjectIdParamSchema = z.object({
  projectId: z.string().uuid("Project ID must be a valid UUID"),
});

export const TaskIdParamSchema = z.object({
  taskId: z.string().uuid("Task ID must be a valid UUID"),
});

export const CreateArtifactSchema = z.object({
  taskId: z.string().uuid("Task ID must be a valid UUID"),
  stepId: z.string().uuid("Step ID must be a valid UUID").optional().nullable(),
  artifactType: z.enum([
    "patch_proposal",
    "test_report",
    "code_review",
    "security_review",
    "documentation",
    "plan",
  ]),
  title: z.string().trim().min(1).max(200),
  content: z.string().min(1).max(524288),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const ListArtifactsQuerySchema = z.object({
  taskId: z.string().uuid().optional(),
  artifactType: z
    .enum([
      "patch_proposal",
      "test_report",
      "code_review",
      "security_review",
      "documentation",
      "plan",
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const CreateApprovalRequestSchema = z.object({
  taskId: z.string().uuid("Task ID must be a valid UUID").optional(),
  stepId: z.string().uuid("Step ID must be a valid UUID").optional().nullable(),
  artifactId: z.string().uuid("Artifact ID must be a valid UUID").optional().nullable(),
  action: z.enum(["apply_patch", "execute_consequential_step", "deploy", "publish"]),
  targetContentHash: z.string().length(64, "Target content hash must be a 64-character SHA-256 hex string"),
  requiredRole: z.enum(["owner", "admin"]).optional(),
  expiresInSeconds: z.number().int().min(60).max(604800).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const DecideApprovalSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().max(1000).optional(),
});

export const StartWorkflowSchema = z.object({
  projectId: z.string().uuid("Project ID must be a valid UUID"),
  title: z.string().trim().min(1).max(200),
  requirements: z.array(z.string().trim().min(1)).min(1),
  providerConfigId: z.string().uuid().optional(),
});

export const ExecuteToolSchema = z.object({
  toolName: z.enum([
    "read_workflow_status",
    "read_project_manifest",
    "inspect_file",
    "create_patch_proposal",
    "run_test_command",
    "produce_review_report",
  ]),
  projectId: z.string().uuid(),
  taskId: z.string().uuid(),
  stepId: z.string().uuid().optional(),
  parameters: z.record(z.string(), z.unknown()).default({}),
});

export const JournalIdParamSchema = z.object({
  projectId: z.string().uuid("Project ID must be a valid UUID"),
  journalId: z.string().uuid("Journal ID must be a valid UUID"),
});

export const AdminRecoverWorkspaceSchema = z.object({
  resolution: z.enum(["restore_baseline", "commit_patch", "mark_recovered"]),
  reason: z.string().max(1000).optional(),
  force: z.boolean().optional(),
});

export const RecoverInterruptedSchema = z.object({
  taskId: z.string().uuid("Task ID must be a valid UUID"),
  patchArtifactId: z.string().uuid("Patch Artifact ID must be a valid UUID"),
  expectedHash: z.string().length(64, "Expected hash must be 64 characters").optional(),
});

export const ListPatchJournalsQuerySchema = z.object({
  taskId: z.string().uuid().optional(),
  status: z.enum(["applying", "applied", "rolled_back", "recovery_required", "recovered"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

