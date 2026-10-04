/**
 * Phase 4D: Agent Workflow, Contracts, Tools, Artifacts, and Approvals Types
 */

export type AgentRole =
  | "planner"
  | "coding"
  | "testing"
  | "code_review"
  | "security_review"
  | "documentation";

export type ArtifactType =
  | "patch_proposal"
  | "test_report"
  | "code_review"
  | "security_review"
  | "documentation"
  | "plan";

export type ReviewStatus = "pending" | "approved" | "rejected";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "consumed";

export type ApprovalAction =
  | "apply_patch"
  | "execute_consequential_step"
  | "deploy"
  | "publish";

export interface AgentArtifactDto {
  id: string;
  organizationId: string;
  projectId: string | null;
  taskId: string;
  stepId: string | null;
  artifactType: ArtifactType;
  title: string;
  content: string;
  contentHash: string; // SHA-256
  sizeBytes: number;
  reviewStatus: ReviewStatus;
  metadata: Record<string, unknown>;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateArtifactInput {
  projectId?: string | null;
  taskId: string;
  stepId?: string | null;
  artifactType: ArtifactType;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface AgentApprovalDto {
  id: string;
  organizationId: string;
  taskId: string;
  stepId: string | null;
  artifactId: string | null;
  action: ApprovalAction;
  targetContentHash: string;
  status: ApprovalStatus;
  requiredRole: "owner" | "admin";
  expiresAt: Date;
  approvedBy: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateApprovalInput {
  taskId: string;
  stepId?: string | null;
  artifactId?: string | null;
  action: ApprovalAction;
  targetContentHash: string;
  requiredRole?: "owner" | "admin";
  expiresInSeconds?: number;
  metadata?: Record<string, unknown>;
}

export interface DecideApprovalInput {
  decision: "approved" | "rejected";
  reason?: string;
}

// -----------------------------------------------------------------------------
// Controlled Tool Registry Contracts
// -----------------------------------------------------------------------------

export type ToolCapability =
  | "read_workflow_status"
  | "read_project_manifest"
  | "inspect_file"
  | "create_patch_proposal"
  | "run_test_command"
  | "produce_review_report";

export interface ToolDefinition {
  name: ToolCapability;
  description: string;
  requiredRole: "member" | "admin" | "owner";
  parametersSchema: Record<string, unknown>;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ToolExecutionRequest {
  toolName: ToolCapability;
  organizationId: string;
  projectId: string;
  taskId: string;
  stepId?: string;
  userId: string;
  parameters: Record<string, unknown>;
}

export interface ToolExecutionResponse {
  success: boolean;
  output: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
  durationMs: number;
  outputSizeBytes: number;
}

// -----------------------------------------------------------------------------
// Agent Contracts
// -----------------------------------------------------------------------------

export interface AgentContract<TInput, TOutput> {
  role: AgentRole;
  description: string;
  allowedCapabilities: readonly ToolCapability[];
  maxContextTokens: number;
  execute(
    input: TInput,
    context: AgentExecutionContext
  ): Promise<AgentExecutionResult<TOutput>>;
}

export interface AgentExecutionContext {
  organizationId: string;
  projectId: string;
  taskId: string;
  stepId?: string;
  userId: string;
  providerConfigId?: string;
}

export interface AgentExecutionResult<TOutput> {
  success: boolean;
  data?: TOutput;
  error?: {
    code: string;
    message: string;
    isActionable: boolean;
  };
  artifactsGenerated?: CreateArtifactInput[];
  tokensUsed?: number;
}

// Specific Agent Input / Output Schemas
export interface PlannerInput {
  title: string;
  inputSummary?: string;
  requirements: string[];
  scope?: "feature" | "refactor" | "bugfix" | "review";
}

export interface PlannerOutput {
  planTitle: string;
  architectureSummary: string;
  plannedSteps: Array<{
    stepKey: string;
    agentRole: AgentRole;
    description: string;
    targetFiles: string[];
    requiresApproval: boolean;
  }>;
  totalEstimatedSteps: number;
}

export interface CodingInput {
  stepKey: string;
  instructions: string;
  targetFiles: string[];
  contextFiles?: Array<{ path: string; content: string }>;
}

export interface CodingOutput {
  patchProposal: string; // Unified diff format
  filesModified: string[];
  summaryOfChanges: string;
}

export interface TestingInput {
  testCommand: "test" | "test:unit" | "test:coverage" | "typecheck" | "lint";
  targetFiles?: string[];
  patchArtifactId?: string;
}

export interface TestingOutput {
  command: string;
  exitCode: number;
  passed: boolean;
  testsRun: number;
  testsPassed: number;
  testsFailed: number;
  outputSnippet: string;
  durationMs: number;
}

export interface ReviewInput {
  patchArtifactId: string;
  patchContent: string;
  reviewFocus: "quality" | "security";
}

export interface ReviewOutput {
  reviewType: "code_review" | "security_review";
  score: number; // 0 to 100
  approved: boolean;
  findings: Array<{
    severity: "low" | "medium" | "high" | "critical";
    file?: string;
    line?: number;
    description: string;
    recommendation: string;
  }>;
  recommendation: "approve" | "request_changes" | "reject";
}

export interface DocumentationInput {
  taskTitle: string;
  completedSteps: string[];
  patchSummaries: string[];
}

export interface DocumentationOutput {
  docTitle: string;
  markdownContent: string;
  updatedSections: string[];
}

// -----------------------------------------------------------------------------
// Workspace Isolated Runner Interface (Mock & Production Spec)
// -----------------------------------------------------------------------------

export interface WorkspaceFile {
  path: string;
  content: string;
  sizeBytes: number;
  lastModified: Date;
}

export type AllowlistedCommand =
  | "test"
  | "test:unit"
  | "test:coverage"
  | "typecheck"
  | "lint";

export type RunnerType = "mock" | "isolated_container" | "microvm" | "fail_closed";

export type IsolationLevel = "none" | "process" | "unprivileged_container" | "microvm";

export interface WorkspaceExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  isSimulated: boolean;
  runnerType: RunnerType;
  isolationLevel: IsolationLevel;
  timedOut?: boolean;
  cancelled?: boolean;
}

export interface WorkspaceRunnerConfig {
  mode: "mock" | "docker" | "fail_closed";
  dockerImage?: string;
  requireMicroVM?: boolean;
  maxMemoryMb?: number;
  maxCpu?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
  networkDisabled?: boolean;
  containerUid?: number;
  containerGid?: number;
}

export interface IsolatedWorkspaceRunner {
  readonly runnerType: RunnerType;
  readonly isProductionSandbox: boolean;
  readonly isolationLevel: IsolationLevel;
  readFile(projectId: string, relativePath: string): Promise<string>;
  readManifest(projectId: string): Promise<Record<string, unknown>>;
  runAllowlistedCommand(
    projectId: string,
    command: AllowlistedCommand,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<WorkspaceExecutionResult>;
  cleanupWorkspace?(projectId: string): Promise<void>;
  setFile?(projectId: string, relativePath: string, content: string): Promise<void> | void;
  deleteFile?(projectId: string, relativePath: string): Promise<void> | void;
}

// -----------------------------------------------------------------------------
// Patch Application Contracts
// -----------------------------------------------------------------------------

export interface ApplyPatchInput {
  taskId: string;
  projectId: string;
  patchArtifactId: string;
  expectedHash?: string;
}

export interface ApplyPatchResult {
  success: boolean;
  taskId: string;
  projectId: string;
  patchArtifactId: string;
  contentHash: string;
  filesModified: string[];
  appliedAt: Date;
  diffSummary?: string;
  journalId?: string;
}

// -----------------------------------------------------------------------------
// Durable Patch Journal Contracts (Phase 4D.5)
// -----------------------------------------------------------------------------

export type PatchJournalStatus =
  | "prepared"
  | "applying"
  | "applied"
  | "rolling_back"
  | "rolled_back"
  | "recovery_required"
  | "recovered";

export interface FileBaselineSnapshot {
  existed: boolean;
  contentHash: string | null;
  content: string | null;
}

export interface PatchJournalBaselineState {
  targetFiles: string[];
  files: Record<string, FileBaselineSnapshot>;
}

export interface PatchApplicationJournalDto {
  id: string;
  organizationId: string;
  projectId: string;
  taskId: string;
  patchArtifactId: string;
  approvalId: string;
  targetContentHash: string;
  status: PatchJournalStatus;
  baselineState: PatchJournalBaselineState;
  appliedFiles: string[];
  recoveryDetails: Record<string, unknown>;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminRecoverInput {
  journalId: string;
  projectId: string;
  resolution: "restore_baseline" | "commit_patch" | "mark_recovered";
  reason?: string;
  force?: boolean;
}

export interface AdminRecoverResult {
  success: boolean;
  journalId: string;
  projectId: string;
  resolution: "restore_baseline" | "commit_patch" | "mark_recovered";
  details: Record<string, unknown>;
  recoveredAt: Date;
}

