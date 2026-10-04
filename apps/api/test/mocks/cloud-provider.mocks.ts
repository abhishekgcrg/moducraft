import crypto from "node:crypto";
import type {
  DatabaseProvider,
  DatabaseProvisionInput,
  DatabaseProvisionResult,
  DatabaseDeprovisionInput,
  DatabaseDeprovisionResult,
  DatabaseCredentialRotationInput,
  DatabaseCredentialRotationResult,
  DatabaseHealthCheckInput,
  DatabaseHealthResult,
  ObjectStorageProvider,
  CreateBucketInput,
  CreateBucketResult,
  UpdateStoragePolicyInput,
  UpdateStoragePolicyResult,
  GenerateSignedUrlInput,
  GenerateSignedUrlResult,
  DeleteBucketInput,
  DeleteBucketResult,
  StorageAccessPolicy,
} from "../../src/modules/resources/types.js";
import {
  ResourceNotFoundError,
  DatabaseProvisioningError,
  DatabaseDeprovisioningError,
  DatabaseCredentialRotationError,
  DatabaseHealthCheckError,
  StorageProvisioningError,
  StoragePolicyError,
  StoragePresignError,
} from "../../src/modules/resources/types.js";
import type {
  BuildExecutor,
  BuildTriggerInput,
  BuildExecutionResult,
  BuildLogChunk,
  BuildLogOptions,
  DeploymentProvider,
  DeployInput,
  DeploymentResult,
  UpdateRoutingInput,
  RoutingUpdateResult,
  DeploymentHealthInput,
  DeploymentHealthResult,
  RollbackInput,
  RollbackResult,
} from "../../src/modules/deployments/types.js";
import {
  BuildNotFoundError,
  BuildExecutionError,
  BuildCancelledError,
  DeploymentNotFoundError,
  DeploymentFailedError,
  DeploymentRollbackError,
  InvalidRoutingError,
} from "../../src/modules/deployments/types.js";
import { ValidationError } from "../../src/errors/app-errors.js";

export interface MockCallRecord {
  readonly method: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly timestamp: Date;
}

// ============================================================================
// Mock Database Provider
// ============================================================================

interface InMemDatabaseRecord {
  organizationId: string;
  projectId: string;
  resourceId: string;
  databaseName: string;
  username: string;
  status: "provisioned" | "deprovisioned";
  allocatedAt: Date;
  updatedAt: Date;
}

export class MockDatabaseProvider implements DatabaseProvider {
  public readonly providerId = "mock-database-provider";
  private readonly databases = new Map<string, InMemDatabaseRecord>();
  public readonly calls: MockCallRecord[] = [];
  private readonly failures = new Map<string, Error>();

  private makeKey(orgId: string, projId: string, resId: string): string {
    return `${orgId}:${projId}:${resId}`;
  }

  public setFailure(method: string, error: Error | null): void {
    if (error) {
      this.failures.set(method, error);
    } else {
      this.failures.delete(method);
    }
  }

  public clear(): void {
    this.databases.clear();
    this.calls.length = 0;
    this.failures.clear();
  }

  public getDatabase(orgId: string, projId: string, resId: string): InMemDatabaseRecord | undefined {
    return this.databases.get(this.makeKey(orgId, projId, resId));
  }

  async provisionDatabase(input: DatabaseProvisionInput): Promise<DatabaseProvisionResult> {
    this.calls.push({ method: "provisionDatabase", args: { ...input }, timestamp: new Date() });

    const failure = this.failures.get("provisionDatabase");
    if (failure) throw failure;

    if (!input.organizationId?.trim() || !input.projectId?.trim() || !input.resourceId?.trim()) {
      throw new ValidationError("Missing tenant or resource scope for database provisioning.");
    }
    if (!input.databaseName?.trim()) {
      throw new ValidationError("Database name must not be empty.");
    }

    const key = this.makeKey(input.organizationId, input.projectId, input.resourceId);
    const existing = this.databases.get(key);

    const allocatedAt = existing?.allocatedAt ?? new Date();
    const username = `usr_${crypto.createHash("sha256").update(key).digest("hex").slice(0, 10)}`;
    const mockPassword = `mock_sec_${crypto.randomBytes(8).toString("hex")}`;

    this.databases.set(key, {
      organizationId: input.organizationId,
      projectId: input.projectId,
      resourceId: input.resourceId,
      databaseName: input.databaseName,
      username,
      status: "provisioned",
      allocatedAt,
      updatedAt: new Date(),
    });

    return {
      organizationId: input.organizationId,
      projectId: input.projectId,
      resourceId: input.resourceId,
      databaseName: input.databaseName,
      endpoint: { host: "127.0.0.1", port: 5432 },
      status: "provisioned",
      allocatedAt,
      credentials: {
        username,
        password: mockPassword,
        connectionStringTemplate: `postgresql://${username}:***@127.0.0.1:5432/${input.databaseName}`,
      },
    };
  }

  async deprovisionDatabase(input: DatabaseDeprovisionInput): Promise<DatabaseDeprovisionResult> {
    this.calls.push({ method: "deprovisionDatabase", args: { ...input }, timestamp: new Date() });

    const failure = this.failures.get("deprovisionDatabase");
    if (failure) throw failure;

    if (!input.organizationId?.trim() || !input.projectId?.trim() || !input.resourceId?.trim()) {
      throw new ValidationError("Missing tenant or resource scope for database deprovisioning.");
    }

    const key = this.makeKey(input.organizationId, input.projectId, input.resourceId);
    const existing = this.databases.get(key);
    if (!existing || existing.status === "deprovisioned") {
      throw new ResourceNotFoundError("Database", input.resourceId);
    }

    this.databases.delete(key);

    return {
      organizationId: input.organizationId,
      projectId: input.projectId,
      resourceId: input.resourceId,
      status: "deprovisioned",
      deprovisionedAt: new Date(),
    };
  }

  async rotateCredentials(input: DatabaseCredentialRotationInput): Promise<DatabaseCredentialRotationResult> {
    this.calls.push({ method: "rotateCredentials", args: { ...input }, timestamp: new Date() });

    const failure = this.failures.get("rotateCredentials");
    if (failure) throw failure;

    if (!input.organizationId?.trim() || !input.projectId?.trim() || !input.resourceId?.trim()) {
      throw new ValidationError("Missing tenant or resource scope for credential rotation.");
    }

    const key = this.makeKey(input.organizationId, input.projectId, input.resourceId);
    const existing = this.databases.get(key);
    if (!existing || existing.status !== "provisioned") {
      throw new ResourceNotFoundError("Database", input.resourceId);
    }

    const username = input.username || existing.username;
    const newPassword = `mock_rot_${crypto.randomBytes(8).toString("hex")}`;
    existing.updatedAt = new Date();

    return {
      organizationId: input.organizationId,
      projectId: input.projectId,
      resourceId: input.resourceId,
      status: "rotated",
      rotatedAt: new Date(),
      credentials: {
        username,
        password: newPassword,
        connectionStringTemplate: `postgresql://${username}:***@127.0.0.1:5432/${existing.databaseName}`,
      },
    };
  }

  async checkHealth(input: DatabaseHealthCheckInput): Promise<DatabaseHealthResult> {
    this.calls.push({ method: "checkHealth", args: { ...input }, timestamp: new Date() });

    const failure = this.failures.get("checkHealth");
    if (failure) throw failure;

    const key = this.makeKey(input.organizationId, input.projectId, input.resourceId);
    const existing = this.databases.get(key);
    if (!existing || existing.status !== "provisioned") {
      return {
        organizationId: input.organizationId,
        projectId: input.projectId,
        resourceId: input.resourceId,
        status: "unreachable",
        latencyMs: 0,
        checkedAt: new Date(),
        details: "Resource not provisioned or removed.",
      };
    }

    return {
      organizationId: input.organizationId,
      projectId: input.projectId,
      resourceId: input.resourceId,
      status: "healthy",
      latencyMs: 4,
      activeConnections: 2,
      checkedAt: new Date(),
    };
  }
}

// ============================================================================
// Mock Object Storage Provider
// ============================================================================

interface InMemBucketRecord {
  organizationId: string;
  projectId: string;
  resourceId: string;
  bucketName: string;
  policy: StorageAccessPolicy;
  createdAt: Date;
  updatedAt: Date;
}

export class MockObjectStorageProvider implements ObjectStorageProvider {
  public readonly providerId = "mock-storage-provider";
  private readonly buckets = new Map<string, InMemBucketRecord>();
  public readonly calls: MockCallRecord[] = [];
  private readonly failures = new Map<string, Error>();

  private makeKey(orgId: string, projId: string, resId: string): string {
    return `${orgId}:${projId}:${resId}`;
  }

  public setFailure(method: string, error: Error | null): void {
    if (error) {
      this.failures.set(method, error);
    } else {
      this.failures.delete(method);
    }
  }

  public clear(): void {
    this.buckets.clear();
    this.calls.length = 0;
    this.failures.clear();
  }

  public getBucket(orgId: string, projId: string, resId: string): InMemBucketRecord | undefined {
    return this.buckets.get(this.makeKey(orgId, projId, resId));
  }

  async createBucket(input: CreateBucketInput): Promise<CreateBucketResult> {
    this.calls.push({ method: "createBucket", args: { ...input }, timestamp: new Date() });

    const failure = this.failures.get("createBucket");
    if (failure) throw failure;

    if (!input.organizationId?.trim() || !input.projectId?.trim() || !input.resourceId?.trim()) {
      throw new ValidationError("Missing tenant or resource scope for bucket creation.");
    }
    if (!input.bucketName?.trim()) {
      throw new ValidationError("Bucket name must not be empty.");
    }

    const key = this.makeKey(input.organizationId, input.projectId, input.resourceId);
    if (this.buckets.has(key)) {
      const existing = this.buckets.get(key)!;
      return {
        organizationId: input.organizationId,
        projectId: input.projectId,
        resourceId: input.resourceId,
        bucketName: existing.bucketName,
        status: "already_exists",
        arnOrUri: `s3://${existing.bucketName}`,
        createdAt: existing.createdAt,
      };
    }

    const createdAt = new Date();
    this.buckets.set(key, {
      organizationId: input.organizationId,
      projectId: input.projectId,
      resourceId: input.resourceId,
      bucketName: input.bucketName,
      policy: input.options?.initialPolicy ?? { isPublicRead: false },
      createdAt,
      updatedAt: createdAt,
    });

    return {
      organizationId: input.organizationId,
      projectId: input.projectId,
      resourceId: input.resourceId,
      bucketName: input.bucketName,
      status: "created",
      arnOrUri: `s3://${input.bucketName}`,
      createdAt,
    };
  }

  async updatePolicy(input: UpdateStoragePolicyInput): Promise<UpdateStoragePolicyResult> {
    this.calls.push({ method: "updatePolicy", args: { ...input }, timestamp: new Date() });

    const failure = this.failures.get("updatePolicy");
    if (failure) throw failure;

    const key = this.makeKey(input.organizationId, input.projectId, input.resourceId);
    const existing = this.buckets.get(key);
    if (!existing) {
      throw new ResourceNotFoundError("Bucket", input.resourceId);
    }

    existing.policy = { ...input.policy };
    existing.updatedAt = new Date();

    return {
      organizationId: input.organizationId,
      projectId: input.projectId,
      resourceId: input.resourceId,
      bucketName: input.bucketName,
      status: "policy_applied",
      appliedPolicy: existing.policy,
      updatedAt: existing.updatedAt,
    };
  }

  async generateSignedUrl(input: GenerateSignedUrlInput): Promise<GenerateSignedUrlResult> {
    this.calls.push({ method: "generateSignedUrl", args: { ...input }, timestamp: new Date() });

    const failure = this.failures.get("generateSignedUrl");
    if (failure) throw failure;

    if (!input.objectKey?.trim()) {
      throw new ValidationError("Object key must not be empty.");
    }
    if (typeof input.expiresInSeconds !== "number" || input.expiresInSeconds <= 0) {
      throw new ValidationError("Expiration must be a positive integer in seconds.");
    }

    const key = this.makeKey(input.organizationId, input.projectId, input.resourceId);
    const existing = this.buckets.get(key);
    if (!existing) {
      throw new ResourceNotFoundError("Bucket", input.resourceId);
    }

    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000);
    const mockSig = crypto.randomBytes(12).toString("hex");
    const mockUrl = `https://storage.local.moducraft/${input.bucketName}/${encodeURIComponent(
      input.objectKey
    )}?op=${input.operation}&exp=${Math.floor(expiresAt.getTime() / 1000)}&sig=${mockSig}`;

    return {
      organizationId: input.organizationId,
      projectId: input.projectId,
      resourceId: input.resourceId,
      bucketName: input.bucketName,
      objectKey: input.objectKey,
      operation: input.operation,
      url: mockUrl,
      expiresAt,
    };
  }

  async deleteBucket(input: DeleteBucketInput): Promise<DeleteBucketResult> {
    this.calls.push({ method: "deleteBucket", args: { ...input }, timestamp: new Date() });

    const failure = this.failures.get("deleteBucket");
    if (failure) throw failure;

    const key = this.makeKey(input.organizationId, input.projectId, input.resourceId);
    const existing = this.buckets.get(key);
    if (!existing) {
      throw new ResourceNotFoundError("Bucket", input.resourceId);
    }

    this.buckets.delete(key);

    return {
      organizationId: input.organizationId,
      projectId: input.projectId,
      resourceId: input.resourceId,
      bucketName: input.bucketName,
      status: "deleted",
      deletedAt: new Date(),
    };
  }
}

// ============================================================================
// Mock Build Executor
// ============================================================================

interface InMemBuildRecord {
  buildId: string;
  organizationId: string;
  projectId: string;
  status: "queued" | "building" | "succeeded" | "failed" | "cancelled";
  startedAt: Date;
  completedAt?: Date;
  imageDigest?: string;
  errorSummary?: string;
}

export class MockBuildExecutor implements BuildExecutor {
  public readonly executorId = "mock-build-executor";
  private readonly builds = new Map<string, InMemBuildRecord>();
  private readonly logs = new Map<string, BuildLogChunk[]>();
  private readonly subscribers = new Map<string, Set<(chunk: BuildLogChunk) => void>>();
  public readonly calls: MockCallRecord[] = [];
  private readonly failures = new Map<string, Error>();

  public setFailure(method: string, error: Error | null): void {
    if (error) {
      this.failures.set(method, error);
    } else {
      this.failures.delete(method);
    }
  }

  public clear(): void {
    this.builds.clear();
    this.logs.clear();
    this.subscribers.clear();
    this.calls.length = 0;
    this.failures.clear();
  }

  public emitLogChunk(buildId: string, stream: "stdout" | "stderr", message: string): BuildLogChunk {
    const list = this.logs.get(buildId) ?? [];
    const chunk: BuildLogChunk = {
      sequence: list.length + 1,
      timestamp: new Date(),
      stream,
      message,
    };
    list.push(chunk);
    this.logs.set(buildId, list);

    const listeners = this.subscribers.get(buildId);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(chunk);
        } catch {}
      }
    }
    return chunk;
  }

  async triggerBuild(input: BuildTriggerInput): Promise<BuildExecutionResult> {
    this.calls.push({ method: "triggerBuild", args: { ...input }, timestamp: new Date() });

    const failure = this.failures.get("triggerBuild");
    if (failure) throw failure;

    if (!input.organizationId?.trim() || !input.projectId?.trim() || !input.buildId?.trim()) {
      throw new ValidationError("Missing tenant or build scope for build triggering.");
    }

    const startedAt = new Date();
    const digest = `sha256:${crypto.createHash("sha256").update(input.buildId).digest("hex")}`;

    const record: InMemBuildRecord = {
      buildId: input.buildId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: "succeeded",
      startedAt,
      completedAt: new Date(startedAt.getTime() + 150),
      imageDigest: digest,
    };

    this.builds.set(input.buildId, record);

    // Seed default log events
    this.emitLogChunk(input.buildId, "stdout", "Starting isolated build execution...");
    this.emitLogChunk(input.buildId, "stdout", "Compiling project source files...");
    this.emitLogChunk(input.buildId, "stdout", `Successfully tagged image: ${digest}`);

    return {
      buildId: record.buildId,
      organizationId: record.organizationId,
      projectId: record.projectId,
      status: record.status,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      imageDigest: record.imageDigest,
    };
  }

  async getStatus(buildId: string): Promise<BuildExecutionResult> {
    this.calls.push({ method: "getStatus", args: { buildId }, timestamp: new Date() });

    const failure = this.failures.get("getStatus");
    if (failure) throw failure;

    const record = this.builds.get(buildId);
    if (!record) {
      throw new BuildNotFoundError(buildId);
    }

    return {
      buildId: record.buildId,
      organizationId: record.organizationId,
      projectId: record.projectId,
      status: record.status,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      imageDigest: record.imageDigest,
      errorSummary: record.errorSummary,
    };
  }

  async getLogs(buildId: string, options?: BuildLogOptions): Promise<readonly BuildLogChunk[]> {
    this.calls.push({ method: "getLogs", args: { buildId, ...options }, timestamp: new Date() });

    const failure = this.failures.get("getLogs");
    if (failure) throw failure;

    const list = this.logs.get(buildId);
    if (!list) {
      if (!this.builds.has(buildId)) {
        throw new BuildNotFoundError(buildId);
      }
      return [];
    }

    let result = list;
    if (options?.since) {
      const sinceTime = options.since.getTime();
      result = result.filter((c) => c.timestamp.getTime() >= sinceTime);
    }
    if (options?.offset) {
      result = result.slice(options.offset);
    }
    if (options?.limit) {
      result = result.slice(0, options.limit);
    }
    return result;
  }

  subscribeLogs(buildId: string, listener: (chunk: BuildLogChunk) => void): () => void {
    if (!this.subscribers.has(buildId)) {
      this.subscribers.set(buildId, new Set());
    }
    const set = this.subscribers.get(buildId)!;
    set.add(listener);

    return () => {
      set.delete(listener);
    };
  }

  async cancelBuild(buildId: string, reason?: string): Promise<BuildExecutionResult> {
    this.calls.push({ method: "cancelBuild", args: { buildId, reason }, timestamp: new Date() });

    const failure = this.failures.get("cancelBuild");
    if (failure) throw failure;

    const record = this.builds.get(buildId);
    if (!record) {
      throw new BuildNotFoundError(buildId);
    }

    record.status = "cancelled";
    record.completedAt = new Date();
    record.errorSummary = reason ?? "Cancelled by user request";

    this.emitLogChunk(buildId, "stderr", `Build was cancelled: ${record.errorSummary}`);

    return {
      buildId: record.buildId,
      organizationId: record.organizationId,
      projectId: record.projectId,
      status: record.status,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      errorSummary: record.errorSummary,
    };
  }
}

// ============================================================================
// Mock Deployment Provider
// ============================================================================

interface InMemDeploymentRecord {
  deploymentId: string;
  organizationId: string;
  projectId: string;
  environment: "preview" | "staging" | "production";
  imageDigest: string;
  status: "pending_approval" | "deploying" | "active" | "failed" | "rolled_back";
  activeVersion: string;
  endpointUrl?: string;
  deployedAt: Date;
  trafficWeight: number;
  domains: string[];
}

export class MockDeploymentProvider implements DeploymentProvider {
  public readonly providerId = "mock-deployment-provider";
  private readonly deployments = new Map<string, InMemDeploymentRecord>();
  // environmentHistory tracks deployment IDs per environment in chronological order
  private readonly environmentHistory = new Map<string, string[]>();
  // activePointer tracks active deployment ID per environment
  private readonly activePointer = new Map<string, string>();
  public readonly calls: MockCallRecord[] = [];
  private readonly failures = new Map<string, Error>();

  private makeEnvKey(orgId: string, projId: string, env: string): string {
    return `${orgId}:${projId}:${env}`;
  }

  public setFailure(method: string, error: Error | null): void {
    if (error) {
      this.failures.set(method, error);
    } else {
      this.failures.delete(method);
    }
  }

  public clear(): void {
    this.deployments.clear();
    this.environmentHistory.clear();
    this.activePointer.clear();
    this.calls.length = 0;
    this.failures.clear();
  }

  public getDeployment(deploymentId: string): InMemDeploymentRecord | undefined {
    return this.deployments.get(deploymentId);
  }

  async deploy(input: DeployInput): Promise<DeploymentResult> {
    this.calls.push({ method: "deploy", args: { ...input }, timestamp: new Date() });

    const failure = this.failures.get("deploy");
    if (failure) throw failure;

    if (!input.organizationId?.trim() || !input.projectId?.trim() || !input.deploymentId?.trim()) {
      throw new ValidationError("Missing tenant or deployment scope.");
    }
    if (!input.imageDigest?.trim()) {
      throw new ValidationError("Image digest must be provided.");
    }

    const envKey = this.makeEnvKey(input.organizationId, input.projectId, input.environment);
    const deployedAt = new Date();
    const versionTag = `v_${deployedAt.getTime().toString(36)}`;
    const endpointUrl = `https://${input.environment}.${input.projectId.slice(0, 8)}.moducraft.internal`;

    const record: InMemDeploymentRecord = {
      deploymentId: input.deploymentId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      environment: input.environment,
      imageDigest: input.imageDigest,
      status: "active",
      activeVersion: versionTag,
      endpointUrl,
      deployedAt,
      trafficWeight: 100,
      domains: [endpointUrl],
    };

    this.deployments.set(input.deploymentId, record);

    const history = this.environmentHistory.get(envKey) ?? [];
    history.push(input.deploymentId);
    this.environmentHistory.set(envKey, history);
    this.activePointer.set(envKey, input.deploymentId);

    return {
      deploymentId: record.deploymentId,
      organizationId: record.organizationId,
      projectId: record.projectId,
      environment: record.environment,
      imageDigest: record.imageDigest,
      status: record.status,
      activeVersion: record.activeVersion,
      endpointUrl: record.endpointUrl,
      deployedAt: record.deployedAt,
    };
  }

  async updateRouting(input: UpdateRoutingInput): Promise<RoutingUpdateResult> {
    this.calls.push({ method: "updateRouting", args: { ...input }, timestamp: new Date() });

    const failure = this.failures.get("updateRouting");
    if (failure) throw failure;

    if (typeof input.trafficWeight !== "number" || input.trafficWeight < 0 || input.trafficWeight > 100) {
      throw new InvalidRoutingError("Traffic weight must be an integer between 0 and 100.", input.deploymentId);
    }

    const record = this.deployments.get(input.deploymentId);
    if (!record) {
      throw new DeploymentNotFoundError(input.deploymentId);
    }

    if (
      record.organizationId !== input.organizationId ||
      record.projectId !== input.projectId ||
      record.environment !== input.environment
    ) {
      throw new DeploymentNotFoundError(input.deploymentId);
    }

    record.trafficWeight = input.trafficWeight;
    if (input.domainAliases) {
      record.domains = [...input.domainAliases];
    }

    return {
      deploymentId: record.deploymentId,
      environment: record.environment,
      trafficWeight: record.trafficWeight,
      effectiveDomains: record.domains,
      status: "routing_updated",
      updatedAt: new Date(),
    };
  }

  async checkHealth(input: DeploymentHealthInput): Promise<DeploymentHealthResult> {
    this.calls.push({ method: "checkHealth", args: { ...input }, timestamp: new Date() });

    const failure = this.failures.get("checkHealth");
    if (failure) throw failure;

    const record = this.deployments.get(input.deploymentId);
    if (!record) {
      return {
        deploymentId: input.deploymentId,
        status: "unknown",
        healthyReplicas: 0,
        totalReplicas: 0,
        checkedAt: new Date(),
        details: "Deployment record not found in provider.",
      };
    }

    return {
      deploymentId: record.deploymentId,
      status: record.status === "active" ? "healthy" : "unhealthy",
      healthyReplicas: 1,
      totalReplicas: 1,
      latencyMs: 12,
      checkedAt: new Date(),
    };
  }

  async rollback(input: RollbackInput): Promise<RollbackResult> {
    this.calls.push({ method: "rollback", args: { ...input }, timestamp: new Date() });

    const failure = this.failures.get("rollback");
    if (failure) throw failure;

    const envKey = this.makeEnvKey(input.organizationId, input.projectId, input.environment);
    const currentActiveId = this.activePointer.get(envKey);
    const targetRecord = this.deployments.get(input.targetDeploymentId);

    if (!targetRecord) {
      throw new DeploymentNotFoundError(input.targetDeploymentId);
    }

    if (
      targetRecord.organizationId !== input.organizationId ||
      targetRecord.projectId !== input.projectId ||
      targetRecord.environment !== input.environment
    ) {
      throw new DeploymentRollbackError(
        `Target deployment '${input.targetDeploymentId}' does not belong to environment '${input.environment}' of project '${input.projectId}'.`,
        input.targetDeploymentId
      );
    }

    // Mark previous active as rolled back if distinct
    if (currentActiveId && currentActiveId !== input.targetDeploymentId) {
      const prev = this.deployments.get(currentActiveId);
      if (prev) {
        prev.status = "rolled_back";
      }
    }

    targetRecord.status = "active";
    this.activePointer.set(envKey, targetRecord.deploymentId);

    return {
      organizationId: input.organizationId,
      projectId: input.projectId,
      environment: input.environment,
      previousDeploymentId: currentActiveId ?? input.targetDeploymentId,
      currentDeploymentId: targetRecord.deploymentId,
      restoredVersion: targetRecord.activeVersion,
      status: "rolled_back",
      rolledBackAt: new Date(),
    };
  }
}
