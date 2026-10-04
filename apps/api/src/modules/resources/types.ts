import { AppError } from "../../errors/app-errors.js";

// ============================================================================
// Database Provider Contracts
// ============================================================================

export interface DatabaseEndpoint {
  readonly host: string;
  readonly port: number;
}

export interface ProvisionedDatabaseCredentials {
  readonly username: string;
  readonly password: string;
  readonly connectionStringTemplate: string;
}

export interface DatabaseProvisionInput {
  readonly organizationId: string;
  readonly projectId: string;
  readonly resourceId: string;
  readonly databaseName: string;
  readonly options?: {
    readonly characterSet?: string;
    readonly collation?: string;
    readonly maxConnections?: number;
    readonly storageLimitMb?: number;
  };
}

export interface DatabaseProvisionResult {
  readonly organizationId: string;
  readonly projectId: string;
  readonly resourceId: string;
  readonly databaseName: string;
  readonly endpoint: DatabaseEndpoint;
  readonly status: "provisioned";
  readonly allocatedAt: Date;
  /**
   * Sensitive credentials generated at provision time.
   * Must be consumed immediately by the caller and persisted via the ModuCraft credential vault.
   * Never log or expose this property in public API responses.
   */
  readonly credentials: ProvisionedDatabaseCredentials;
}

export interface DatabaseDeprovisionInput {
  readonly organizationId: string;
  readonly projectId: string;
  readonly resourceId: string;
  readonly options?: {
    readonly takeFinalSnapshot?: boolean;
    readonly dropImmediately?: boolean;
  };
}

export interface DatabaseDeprovisionResult {
  readonly organizationId: string;
  readonly projectId: string;
  readonly resourceId: string;
  readonly status: "deprovisioned";
  readonly deprovisionedAt: Date;
}

export interface DatabaseCredentialRotationInput {
  readonly organizationId: string;
  readonly projectId: string;
  readonly resourceId: string;
  readonly username?: string;
}

export interface DatabaseCredentialRotationResult {
  readonly organizationId: string;
  readonly projectId: string;
  readonly resourceId: string;
  readonly status: "rotated";
  readonly rotatedAt: Date;
  /**
   * Newly rotated credentials.
   * Must be stored encrypted using the ModuCraft vault.
   */
  readonly credentials: ProvisionedDatabaseCredentials;
}

export interface DatabaseHealthCheckInput {
  readonly organizationId: string;
  readonly projectId: string;
  readonly resourceId: string;
}

export interface DatabaseHealthResult {
  readonly organizationId: string;
  readonly projectId: string;
  readonly resourceId: string;
  readonly status: "healthy" | "degraded" | "unreachable";
  readonly latencyMs: number;
  readonly activeConnections?: number;
  readonly checkedAt: Date;
  readonly details?: string;
}

export interface DatabaseProvider {
  readonly providerId: string;

  provisionDatabase(input: DatabaseProvisionInput): Promise<DatabaseProvisionResult>;
  deprovisionDatabase(input: DatabaseDeprovisionInput): Promise<DatabaseDeprovisionResult>;
  rotateCredentials(input: DatabaseCredentialRotationInput): Promise<DatabaseCredentialRotationResult>;
  checkHealth(input: DatabaseHealthCheckInput): Promise<DatabaseHealthResult>;
}

// ============================================================================
// Object Storage Provider Contracts
// ============================================================================

export interface StorageCorsRule {
  readonly allowedOrigins: readonly string[];
  readonly allowedMethods: readonly string[];
  readonly allowedHeaders?: readonly string[];
  readonly maxAgeSeconds?: number;
}

export interface StorageAccessPolicy {
  readonly isPublicRead?: boolean;
  readonly corsRules?: readonly StorageCorsRule[];
  readonly expirationDays?: number;
}

export interface CreateBucketInput {
  readonly organizationId: string;
  readonly projectId: string;
  readonly resourceId: string;
  readonly bucketName: string;
  readonly options?: {
    readonly region?: string;
    readonly initialPolicy?: StorageAccessPolicy;
  };
}

export interface CreateBucketResult {
  readonly organizationId: string;
  readonly projectId: string;
  readonly resourceId: string;
  readonly bucketName: string;
  readonly status: "created" | "already_exists";
  readonly arnOrUri: string;
  readonly createdAt: Date;
}

export interface UpdateStoragePolicyInput {
  readonly organizationId: string;
  readonly projectId: string;
  readonly resourceId: string;
  readonly bucketName: string;
  readonly policy: StorageAccessPolicy;
}

export interface UpdateStoragePolicyResult {
  readonly organizationId: string;
  readonly projectId: string;
  readonly resourceId: string;
  readonly bucketName: string;
  readonly status: "policy_applied";
  readonly appliedPolicy: StorageAccessPolicy;
  readonly updatedAt: Date;
}

export interface GenerateSignedUrlInput {
  readonly organizationId: string;
  readonly projectId: string;
  readonly resourceId: string;
  readonly bucketName: string;
  readonly objectKey: string;
  readonly operation: "read" | "write" | "delete";
  readonly expiresInSeconds: number;
  readonly options?: {
    readonly contentType?: string;
  };
}

export interface GenerateSignedUrlResult {
  readonly organizationId: string;
  readonly projectId: string;
  readonly resourceId: string;
  readonly bucketName: string;
  readonly objectKey: string;
  readonly operation: "read" | "write" | "delete";
  readonly url: string;
  readonly expiresAt: Date;
}

export interface DeleteBucketInput {
  readonly organizationId: string;
  readonly projectId: string;
  readonly resourceId: string;
  readonly bucketName: string;
  readonly options?: {
    readonly forceDeleteObjects?: boolean;
  };
}

export interface DeleteBucketResult {
  readonly organizationId: string;
  readonly projectId: string;
  readonly resourceId: string;
  readonly bucketName: string;
  readonly status: "deleted";
  readonly deletedAt: Date;
}

export interface ObjectStorageProvider {
  readonly providerId: string;

  createBucket(input: CreateBucketInput): Promise<CreateBucketResult>;
  updatePolicy(input: UpdateStoragePolicyInput): Promise<UpdateStoragePolicyResult>;
  generateSignedUrl(input: GenerateSignedUrlInput): Promise<GenerateSignedUrlResult>;
  deleteBucket(input: DeleteBucketInput): Promise<DeleteBucketResult>;
}

// ============================================================================
// Normalized Resource Error Hierarchy
// ============================================================================

export class ResourceProviderError extends AppError {
  public readonly resourceId?: string;
  public readonly isRetryable: boolean;

  constructor(
    code: string,
    message: string,
    statusCode: number,
    isRetryable: boolean = false,
    resourceId?: string,
    details?: unknown
  ) {
    super(message, code, statusCode, details);
    this.name = "ResourceProviderError";
    this.isRetryable = isRetryable;
    this.resourceId = resourceId;
  }
}

export class DatabaseProvisioningError extends ResourceProviderError {
  constructor(message: string, resourceId?: string, isRetryable = false, details?: unknown) {
    super("DATABASE_PROVISIONING_ERROR", message, 500, isRetryable, resourceId, details);
    this.name = "DatabaseProvisioningError";
  }
}

export class DatabaseDeprovisioningError extends ResourceProviderError {
  constructor(message: string, resourceId?: string, details?: unknown) {
    super("DATABASE_DEPROVISIONING_ERROR", message, 500, false, resourceId, details);
    this.name = "DatabaseDeprovisioningError";
  }
}

export class DatabaseCredentialRotationError extends ResourceProviderError {
  constructor(message: string, resourceId?: string, details?: unknown) {
    super("DATABASE_CREDENTIAL_ROTATION_ERROR", message, 500, false, resourceId, details);
    this.name = "DatabaseCredentialRotationError";
  }
}

export class DatabaseHealthCheckError extends ResourceProviderError {
  constructor(message: string, resourceId?: string, details?: unknown) {
    super("DATABASE_HEALTH_CHECK_ERROR", message, 503, true, resourceId, details);
    this.name = "DatabaseHealthCheckError";
  }
}

export class StorageProvisioningError extends ResourceProviderError {
  constructor(message: string, resourceId?: string, isRetryable = false, details?: unknown) {
    super("STORAGE_PROVISIONING_ERROR", message, 500, isRetryable, resourceId, details);
    this.name = "StorageProvisioningError";
  }
}

export class StoragePolicyError extends ResourceProviderError {
  constructor(message: string, resourceId?: string, details?: unknown) {
    super("STORAGE_POLICY_ERROR", message, 400, false, resourceId, details);
    this.name = "StoragePolicyError";
  }
}

export class StoragePresignError extends ResourceProviderError {
  constructor(message: string, resourceId?: string, details?: unknown) {
    super("STORAGE_PRESIGN_ERROR", message, 400, false, resourceId, details);
    this.name = "StoragePresignError";
  }
}

export class ResourceNotFoundError extends ResourceProviderError {
  constructor(resourceType: string, resourceId: string) {
    super(
      "RESOURCE_NOT_FOUND",
      `${resourceType} with ID '${resourceId}' was not found.`,
      404,
      false,
      resourceId
    );
    this.name = "ResourceNotFoundError";
  }
}
