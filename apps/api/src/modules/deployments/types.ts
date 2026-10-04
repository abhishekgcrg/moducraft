import { AppError } from "../../errors/app-errors.js";

// ============================================================================
// Build Executor Contracts
// ============================================================================

export type BuildStatus = "queued" | "building" | "succeeded" | "failed" | "cancelled";

export interface BuildArtifactSource {
  readonly type: "artifact";
  readonly artifactId: string;
  readonly contentHash: string;
}

export interface BuildGitSource {
  readonly type: "git";
  readonly repositoryUrl: string;
  readonly commitHash: string;
  readonly branch?: string;
}

export type BuildSource = BuildArtifactSource | BuildGitSource;

export interface BuildConfig {
  readonly dockerfilePath?: string;
  readonly contextPath?: string;
  readonly targetStage?: string;
  readonly buildArgs?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface BuildTriggerInput {
  readonly organizationId: string;
  readonly projectId: string;
  readonly buildId: string;
  readonly source: BuildSource;
  readonly config?: BuildConfig;
}

export interface BuildExecutionResult {
  readonly buildId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly status: BuildStatus;
  readonly startedAt: Date;
  readonly completedAt?: Date;
  /**
   * Immutable image digest (e.g. sha256:abcdef...) produced upon successful build.
   */
  readonly imageDigest?: string;
  readonly errorSummary?: string;
}

export interface BuildLogChunk {
  readonly sequence: number;
  readonly timestamp: Date;
  readonly stream: "stdout" | "stderr";
  readonly message: string;
}

export interface BuildLogOptions {
  readonly since?: Date;
  readonly offset?: number;
  readonly limit?: number;
}

export interface BuildExecutor {
  readonly executorId: string;

  triggerBuild(input: BuildTriggerInput): Promise<BuildExecutionResult>;
  getStatus(buildId: string): Promise<BuildExecutionResult>;
  getLogs(buildId: string, options?: BuildLogOptions): Promise<readonly BuildLogChunk[]>;
  subscribeLogs(buildId: string, listener: (chunk: BuildLogChunk) => void): () => void;
  cancelBuild(buildId: string, reason?: string): Promise<BuildExecutionResult>;
}

// ============================================================================
// Deployment Provider Contracts
// ============================================================================

export type DeploymentEnvironment = "preview" | "staging" | "production";

export type DeploymentStatus =
  | "pending_approval"
  | "deploying"
  | "active"
  | "failed"
  | "rolled_back";

export interface DeploymentResourceLimits {
  readonly memoryMb?: number;
  readonly cpu?: number;
}

export interface DeploymentConfig {
  readonly port: number;
  readonly replicas?: number;
  readonly resourceLimits?: DeploymentResourceLimits;
  /**
   * Non-sensitive or vaulted environment variable names.
   * Note: Plaintext secrets must never be passed in logs or raw config objects.
   */
  readonly environmentVariables?: Readonly<Record<string, string>>;
}

export interface DeployInput {
  readonly organizationId: string;
  readonly projectId: string;
  readonly deploymentId: string;
  readonly environment: DeploymentEnvironment;
  readonly imageDigest: string;
  readonly config?: DeploymentConfig;
  readonly approvalId?: string;
}

export interface DeploymentResult {
  readonly deploymentId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly environment: DeploymentEnvironment;
  readonly imageDigest: string;
  readonly status: DeploymentStatus;
  readonly activeVersion: string;
  readonly endpointUrl?: string;
  readonly deployedAt: Date;
}

export interface UpdateRoutingInput {
  readonly organizationId: string;
  readonly projectId: string;
  readonly deploymentId: string;
  readonly environment: DeploymentEnvironment;
  readonly trafficWeight: number; // 0 to 100
  readonly domainAliases?: readonly string[];
}

export interface RoutingUpdateResult {
  readonly deploymentId: string;
  readonly environment: DeploymentEnvironment;
  readonly trafficWeight: number;
  readonly effectiveDomains: readonly string[];
  readonly status: "routing_updated";
  readonly updatedAt: Date;
}

export interface DeploymentHealthInput {
  readonly organizationId: string;
  readonly projectId: string;
  readonly deploymentId: string;
}

export interface DeploymentHealthResult {
  readonly deploymentId: string;
  readonly status: "healthy" | "unhealthy" | "degraded" | "unknown";
  readonly healthyReplicas: number;
  readonly totalReplicas: number;
  readonly latencyMs?: number;
  readonly checkedAt: Date;
  readonly details?: string;
}

export interface RollbackInput {
  readonly organizationId: string;
  readonly projectId: string;
  readonly targetDeploymentId: string;
  readonly environment: DeploymentEnvironment;
  readonly reason?: string;
}

export interface RollbackResult {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environment: DeploymentEnvironment;
  readonly previousDeploymentId: string;
  readonly currentDeploymentId: string;
  readonly restoredVersion: string;
  readonly status: "rolled_back";
  readonly rolledBackAt: Date;
}

export interface DeploymentProvider {
  readonly providerId: string;

  deploy(input: DeployInput): Promise<DeploymentResult>;
  updateRouting(input: UpdateRoutingInput): Promise<RoutingUpdateResult>;
  checkHealth(input: DeploymentHealthInput): Promise<DeploymentHealthResult>;
  rollback(input: RollbackInput): Promise<RollbackResult>;
}

// ============================================================================
// Normalized Deployment Pipeline Error Hierarchy
// ============================================================================

export class DeploymentPipelineError extends AppError {
  public readonly isRetryable: boolean;

  constructor(
    code: string,
    message: string,
    statusCode: number,
    isRetryable: boolean = false,
    details?: unknown
  ) {
    super(message, code, statusCode, details);
    this.name = "DeploymentPipelineError";
    this.isRetryable = isRetryable;
  }
}

export class BuildExecutionError extends DeploymentPipelineError {
  public readonly buildId?: string;

  constructor(message: string, buildId?: string, isRetryable = false, details?: unknown) {
    super("BUILD_EXECUTION_ERROR", message, 500, isRetryable, details);
    this.name = "BuildExecutionError";
    this.buildId = buildId;
  }
}

export class BuildNotFoundError extends DeploymentPipelineError {
  constructor(buildId: string) {
    super("BUILD_NOT_FOUND", `Build with ID '${buildId}' was not found.`, 404, false, { buildId });
    this.name = "BuildNotFoundError";
  }
}

export class BuildCancelledError extends DeploymentPipelineError {
  constructor(buildId: string, reason?: string) {
    super(
      "BUILD_CANCELLED",
      `Build '${buildId}' was cancelled${reason ? `: ${reason}` : "."}`,
      409,
      false,
      { buildId, reason }
    );
    this.name = "BuildCancelledError";
  }
}

export class BuildTimeoutError extends DeploymentPipelineError {
  constructor(buildId: string, timeoutMs: number) {
    super(
      "BUILD_TIMEOUT",
      `Build '${buildId}' timed out after ${timeoutMs}ms.`,
      504,
      true,
      { buildId, timeoutMs }
    );
    this.name = "BuildTimeoutError";
  }
}

export class DeploymentProviderError extends DeploymentPipelineError {
  public readonly deploymentId?: string;

  constructor(
    code: string,
    message: string,
    statusCode: number,
    isRetryable = false,
    deploymentId?: string,
    details?: unknown
  ) {
    super(code, message, statusCode, isRetryable, details);
    this.name = "DeploymentProviderError";
    this.deploymentId = deploymentId;
  }
}

export class DeploymentNotFoundError extends DeploymentProviderError {
  constructor(deploymentId: string) {
    super(
      "DEPLOYMENT_NOT_FOUND",
      `Deployment with ID '${deploymentId}' was not found.`,
      404,
      false,
      deploymentId,
      { deploymentId }
    );
    this.name = "DeploymentNotFoundError";
  }
}

export class DeploymentFailedError extends DeploymentProviderError {
  constructor(message: string, deploymentId?: string, isRetryable = false, details?: unknown) {
    super("DEPLOYMENT_FAILED", message, 500, isRetryable, deploymentId, details);
    this.name = "DeploymentFailedError";
  }
}

export class DeploymentRollbackError extends DeploymentProviderError {
  constructor(message: string, deploymentId?: string, details?: unknown) {
    super("DEPLOYMENT_ROLLBACK_ERROR", message, 400, false, deploymentId, details);
    this.name = "DeploymentRollbackError";
  }
}

export class InvalidRoutingError extends DeploymentProviderError {
  constructor(message: string, deploymentId?: string, details?: unknown) {
    super("INVALID_ROUTING_ERROR", message, 400, false, deploymentId, details);
    this.name = "InvalidRoutingError";
  }
}
