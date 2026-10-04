import type pg from "pg";
import { ScopedTransaction, withAuthenticatedContext } from "../../db/transaction.js";
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
} from "../../errors/app-errors.js";
import { encryptSecret, decryptSecret, maskApiKey } from "../providers/crypto.js";
import { redactSensitiveData } from "../memory/redactor.js";

export interface ProjectResourceRow {
  id: string;
  organization_id: string;
  project_id: string;
  provider_id: string;
  resource_type: "database" | "object_storage";
  name: string;
  status: "provisioning" | "active" | "failed" | "deprovisioning" | "deprovisioned";
  endpoint: Record<string, unknown> | null;
  configuration: Record<string, unknown>;
  error_details: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface ResourceCredentialRow {
  id: string;
  organization_id: string;
  project_id: string;
  resource_id: string;
  status: "active" | "rotated" | "revoked";
  version: number;
  username: string;
  encrypted_password: string;
  key_prefix: string;
  key_suffix: string;
  connection_string_template: string;
  created_by: string;
  created_at: Date;
  rotated_at: Date | null;
  revoked_at: Date | null;
}

export interface ProjectResourceResponseDTO {
  id: string;
  organizationId: string;
  projectId: string;
  providerId: string;
  resourceType: "database" | "object_storage";
  name: string;
  status: "provisioning" | "active" | "failed" | "deprovisioning" | "deprovisioned";
  endpoint: Record<string, unknown> | null;
  configuration: Record<string, unknown>;
  errorDetails: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface ResourceCredentialSummaryDTO {
  id: string;
  organizationId: string;
  projectId: string;
  resourceId: string;
  status: "active" | "rotated" | "revoked";
  version: number;
  username: string;
  keyPrefix: string;
  keySuffix: string;
  connectionStringTemplate: string;
  createdBy: string;
  createdAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
}

export interface RevealedCredentialsDTO {
  username: string;
  password: string;
  connectionString: string;
}

export interface CreateResourceInput {
  organizationId: string;
  projectId: string;
  providerId: string;
  resourceType: "database" | "object_storage";
  name: string;
  endpoint?: Record<string, unknown>;
  configuration?: Record<string, unknown>;
}

export interface CreateResourceCredentialInput {
  organizationId: string;
  projectId: string;
  resourceId: string;
  username: string;
  password: string;
  connectionStringTemplate: string;
}

export interface RotateResourceCredentialInput {
  organizationId: string;
  projectId: string;
  resourceId: string;
  newPassword: string;
  username?: string;
  connectionStringTemplate?: string;
}

export interface RevealCredentialInput {
  organizationId: string;
  projectId: string;
  resourceId: string;
}

export interface DeprovisionResourceInput {
  organizationId: string;
  projectId: string;
  resourceId: string;
}

export interface ReconcileResourceInput {
  organizationId: string;
  projectId: string;
  resourceId: string;
  status: "failed" | "active" | "provisioning";
  errorDetails?: string;
}

const BLACKLISTED_CONFIG_KEYS = [
  "password",
  "secret",
  "token",
  "apikey",
  "api_key",
  "authorization",
  "cookie",
  "jwt",
  "privatekey",
  "private_key",
  "credentials",
];

export class ResourceService {
  /**
   * Asserts the user holds an allowed role within the target organization.
   */
  async assertOrgRole(
    tx: ScopedTransaction,
    organizationId: string,
    userId: string,
    allowedRoles: string[]
  ): Promise<string> {
    const res = await tx.query<{ role: string }>(
      `SELECT role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2;`,
      [organizationId, userId]
    );

    const membership = res.rows[0];
    if (!membership) {
      throw new NotFoundError("Organization membership");
    }

    if (!allowedRoles.includes(membership.role)) {
      throw new ForbiddenError(
        `Action requires one of: ${allowedRoles.join(", ")}. Current role: '${membership.role}'.`
      );
    }

    return membership.role;
  }

  /**
   * Validates configuration and endpoint objects against sensitive keys recursively across
   * nested objects, arrays of objects, and arbitrary mixed nesting.
   * Supports normalized delimiter variants (e.g. api_key, api-key, api.key, privateKey, private-key)
   * while safely permitting legitimate non-secret fields like public_key and routing_key.
   */
  validateNoSecretKeys(val: unknown, fieldName: string): void {
    if (!val || typeof val !== "object") return;

    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        const item = val[i];
        if (item && typeof item === "object") {
          this.validateNoSecretKeys(item, `${fieldName}[${i}]`);
        }
      }
      return;
    }

    const record = val as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const lowerKey = key.toLowerCase();
      const normalizedKey = lowerKey.replace(/[-_.]/g, "");
      if (
        BLACKLISTED_CONFIG_KEYS.some(
          (b) => lowerKey.includes(b) || normalizedKey.includes(b)
        )
      ) {
        throw new ValidationError(
          `Sensitive key '${key}' is prohibited in '${fieldName}'. Secrets must be stored in the credential vault.`
        );
      }
      const child = record[key];
      if (child && typeof child === "object") {
        this.validateNoSecretKeys(child, `${fieldName}.${key}`);
      }
    }
  }

  /**
   * Maps internal database row to explicit, public DTO allowlist.
   */
  mapResourceDto(row: ProjectResourceRow): ProjectResourceResponseDTO {
    return {
      id: row.id,
      organizationId: row.organization_id,
      projectId: row.project_id,
      providerId: row.provider_id,
      resourceType: row.resource_type,
      name: row.name,
      status: row.status,
      endpoint: row.endpoint,
      configuration: row.configuration,
      errorDetails: row.error_details,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
    };
  }

  /**
   * Maps credential row to non-secret summary DTO.
   */
  mapCredentialSummaryDto(row: ResourceCredentialRow): ResourceCredentialSummaryDTO {
    return {
      id: row.id,
      organizationId: row.organization_id,
      projectId: row.project_id,
      resourceId: row.resource_id,
      status: row.status,
      version: row.version,
      username: row.username,
      keyPrefix: row.key_prefix,
      keySuffix: row.key_suffix,
      connectionStringTemplate: row.connection_string_template,
      createdBy: row.created_by,
      createdAt: row.created_at,
      rotatedAt: row.rotated_at,
      revokedAt: row.revoked_at,
    };
  }

  /**
   * Creates a new cloud resource record with least-privilege checks.
   */
  async createResource(
    tx: ScopedTransaction,
    input: CreateResourceInput,
    userId: string
  ): Promise<ProjectResourceResponseDTO> {
    await this.assertOrgRole(tx, input.organizationId, userId, ["owner", "admin", "member"]);

    this.validateNoSecretKeys(input.configuration, "configuration");
    this.validateNoSecretKeys(input.endpoint, "endpoint");

    const endpointJson = input.endpoint ? JSON.stringify(input.endpoint) : null;
    const configJson = JSON.stringify(input.configuration ?? {});

    const insertResult = await tx.query<ProjectResourceRow>(
      `INSERT INTO project_resources (
        organization_id, project_id, provider_id, resource_type,
        name, status, endpoint, configuration, created_by
      ) VALUES ($1, $2, $3, $4, $5, 'active', $6::jsonb, $7::jsonb, $8)
      RETURNING *;`,
      [
        input.organizationId,
        input.projectId,
        input.providerId,
        input.resourceType,
        input.name.trim(),
        endpointJson,
        configJson,
        userId,
      ]
    );

    const row = insertResult.rows[0];

    // Atomically record audit event
    await tx.query(
      `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
      [
        input.organizationId,
        "resource.created",
        "project_resource",
        row.id,
        "success",
        JSON.stringify({
          projectId: input.projectId,
          providerId: input.providerId,
          resourceType: input.resourceType,
          name: row.name,
        }),
      ]
    );

    return this.mapResourceDto(row);
  }

  /**
   * Lists project resources filtered by organization and project under forced RLS.
   */
  async listResources(
    tx: ScopedTransaction,
    organizationId: string,
    projectId: string,
    query?: { status?: string; resourceType?: string; limit?: number; offset?: number }
  ): Promise<ProjectResourceResponseDTO[]> {
    const params: any[] = [organizationId, projectId];
    let sql = `SELECT * FROM project_resources WHERE organization_id = $1 AND project_id = $2`;

    if (query?.status) {
      params.push(query.status);
      sql += ` AND status = $${params.length}`;
    }
    if (query?.resourceType) {
      params.push(query.resourceType);
      sql += ` AND resource_type = $${params.length}`;
    }

    const limit = query?.limit ?? 50;
    const offset = query?.offset ?? 0;
    params.push(limit, offset);
    sql += ` ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length};`;

    const res = await tx.query<ProjectResourceRow>(sql, params);
    return res.rows.map((row) => this.mapResourceDto(row));
  }

  /**
   * Retrieves a single project resource under forced RLS.
   */
  async getResource(
    tx: ScopedTransaction,
    organizationId: string,
    projectId: string,
    resourceId: string
  ): Promise<ProjectResourceResponseDTO> {
    const res = await tx.query<ProjectResourceRow>(
      `SELECT * FROM project_resources WHERE organization_id = $1 AND project_id = $2 AND id = $3;`,
      [organizationId, projectId, resourceId]
    );

    const row = res.rows[0];
    if (!row) {
      throw new NotFoundError("Project resource");
    }

    return this.mapResourceDto(row);
  }

  /**
   * Creates an active credential row in the vault, encrypted with AES-256-GCM + tenant AAD.
   */
  async createResourceCredential(
    tx: ScopedTransaction,
    input: CreateResourceCredentialInput,
    userId: string
  ): Promise<ResourceCredentialSummaryDTO> {
    await this.assertOrgRole(tx, input.organizationId, userId, ["owner", "admin"]);

    if (!input.password || input.password.trim().length === 0) {
      throw new ValidationError("Credential password cannot be empty.");
    }

    // Encrypt password using tenant organizationId as AAD context
    const encrypted = encryptSecret(input.password, input.organizationId);
    const { prefix, suffix } = maskApiKey(input.password);

    // Verify parent resource exists and matches composite scope
    const parentCheck = await tx.query<ProjectResourceRow>(
      `SELECT id FROM project_resources WHERE organization_id = $1 AND project_id = $2 AND id = $3;`,
      [input.organizationId, input.projectId, input.resourceId]
    );
    if (!parentCheck.rows[0]) {
      throw new NotFoundError("Project resource");
    }

    const insertResult = await tx.query<ResourceCredentialRow>(
      `INSERT INTO resource_credentials (
        organization_id, project_id, resource_id, status, version,
        username, encrypted_password, key_prefix, key_suffix,
        connection_string_template, created_by
      ) VALUES ($1, $2, $3, 'active', 1, $4, $5, $6, $7, $8, $9)
      RETURNING *;`,
      [
        input.organizationId,
        input.projectId,
        input.resourceId,
        input.username.trim(),
        encrypted,
        prefix,
        suffix,
        input.connectionStringTemplate,
        userId,
      ]
    );

    const row = insertResult.rows[0];

    // Atomically record audit event without leaking secret material
    await tx.query(
      `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
      [
        input.organizationId,
        "resource.credentials.created",
        "resource_credentials",
        row.id,
        "success",
        JSON.stringify({
          resourceId: input.resourceId,
          version: row.version,
          username: row.username,
          keyPrefix: row.key_prefix,
        }),
      ]
    );

    return this.mapCredentialSummaryDto(row);
  }

  /**
   * Rotates credentials atomically using parent row locking and single-active partial unique index.
   */
  async rotateResourceCredential(
    tx: ScopedTransaction,
    input: RotateResourceCredentialInput,
    userId: string
  ): Promise<ResourceCredentialSummaryDTO> {
    await this.assertOrgRole(tx, input.organizationId, userId, ["owner", "admin"]);

    // Step 1: Explicitly lock parent resource row to serialize concurrent rotation requests
    const parentLock = await tx.query<ProjectResourceRow>(
      `SELECT id, organization_id, project_id, status 
       FROM project_resources 
       WHERE organization_id = $1 AND project_id = $2 AND id = $3 
       FOR UPDATE;`,
      [input.organizationId, input.projectId, input.resourceId]
    );
    const parent = parentLock.rows[0];
    if (!parent) {
      throw new NotFoundError("Project resource");
    }
    if (parent.status === "deprovisioned") {
      throw new ValidationError("Cannot rotate credentials on a deprovisioned resource.");
    }

    // Step 2: Lock existing active credential
    const activeLock = await tx.query<ResourceCredentialRow>(
      `SELECT * FROM resource_credentials 
       WHERE organization_id = $1 AND resource_id = $2 AND status = 'active'
       FOR UPDATE;`,
      [input.organizationId, input.resourceId]
    );
    const currentCred = activeLock.rows[0];
    if (!currentCred) {
      throw new NotFoundError("Active resource credential");
    }

    // Step 3: Deactivate current credential
    await tx.query(
      `UPDATE resource_credentials 
       SET status = 'rotated', rotated_at = now() 
       WHERE id = $1;`,
      [currentCred.id]
    );

    // Step 4: Encrypt new password
    const encrypted = encryptSecret(input.newPassword, input.organizationId);
    const { prefix, suffix } = maskApiKey(input.newPassword);
    const newUsername = input.username?.trim() || currentCred.username;
    const newTemplate = input.connectionStringTemplate || currentCred.connection_string_template;

    // Step 5: Insert new active credential with incremented version
    const insertResult = await tx.query<ResourceCredentialRow>(
      `INSERT INTO resource_credentials (
        organization_id, project_id, resource_id, status, version,
        username, encrypted_password, key_prefix, key_suffix,
        connection_string_template, created_by
      ) VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, $8, $9, $10)
      RETURNING *;`,
      [
        input.organizationId,
        input.projectId,
        input.resourceId,
        currentCred.version + 1,
        newUsername,
        encrypted,
        prefix,
        suffix,
        newTemplate,
        userId,
      ]
    );

    const newCred = insertResult.rows[0];

    // Step 6: Record rotation audit event
    await tx.query(
      `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
      [
        input.organizationId,
        "resource.credentials.rotated",
        "resource_credentials",
        newCred.id,
        "success",
        JSON.stringify({
          resourceId: input.resourceId,
          version: newCred.version,
          username: newCred.username,
          keyPrefix: newCred.key_prefix,
        }),
      ]
    );

    return this.mapCredentialSummaryDto(newCred);
  }

  /**
   * Reveals decrypted credential material for an authorized owner/admin.
   * Employs the Autonomous Audit Pattern: denied/failed attempts are audited in a
   * separate transaction so rollback of the business logic does not drop the audit trail.
   */
  async revealResourceCredential(
    pool: pg.Pool,
    input: RevealCredentialInput,
    userId: string
  ): Promise<RevealedCredentialsDTO> {
    try {
      return await withAuthenticatedContext(pool, userId, async (tx) => {
        // Assert role (throws ForbiddenError if member or viewer)
        await this.assertOrgRole(tx, input.organizationId, userId, ["owner", "admin"]);

        const res = await tx.query<ResourceCredentialRow>(
          `SELECT * FROM resource_credentials 
           WHERE organization_id = $1 AND project_id = $2 AND resource_id = $3 AND status = 'active';`,
          [input.organizationId, input.projectId, input.resourceId]
        );
        const cred = res.rows[0];
        if (!cred) {
          throw new NotFoundError("Active credential for resource");
        }

        // Decrypt password with tenant organizationId as AAD
        const decryptedPassword = decryptSecret(cred.encrypted_password, input.organizationId);

        // Interpolate connection string template if applicable
        const connectionString = cred.connection_string_template
          .replace("{username}", cred.username)
          .replace("{password}", decryptedPassword);

        // Record successful reveal
        await tx.query(
          `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
          [
            input.organizationId,
            "resource.credentials.revealed",
            "resource_credentials",
            cred.id,
            "success",
            JSON.stringify({
              resourceId: input.resourceId,
              version: cred.version,
              username: cred.username,
            }),
          ]
        );

        return {
          username: cred.username,
          password: decryptedPassword,
          connectionString,
        };
      });
    } catch (err: any) {
      // Autonomous Audit Pattern: persist audit record even if main transaction failed or rolled back
      const outcome = err instanceof ForbiddenError ? "denied" : "failure";
      try {
        await withAuthenticatedContext(pool, userId, async (auditTx) => {
          // Check if actor is member of org before attempting record_audit_event
          const memberCheck = await auditTx.query<{ exists: boolean }>(
            `SELECT public.moducraft_is_org_member($1) as exists;`,
            [input.organizationId]
          );
          if (memberCheck.rows[0]?.exists) {
            await auditTx.query(
              `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
              [
                input.organizationId,
                "resource.credentials.revealed",
                "resource_credentials",
                input.resourceId,
                outcome,
                JSON.stringify({
                  errorCode: err.code || "UNKNOWN",
                  reason: redactSensitiveData(err.message || "").text,
                }),
              ]
            );
          }
        });
      } catch {
        // Fallback: do not mask original error if audit logging encounters a secondary error
      }
      throw err;
    }
  }

  /**
   * Deprovisions a resource and revokes its active credentials.
   * Preserves historical record under soft-delete lifecycle.
   */
  async deprovisionResource(
    tx: ScopedTransaction,
    input: DeprovisionResourceInput,
    userId: string
  ): Promise<ProjectResourceResponseDTO> {
    await this.assertOrgRole(tx, input.organizationId, userId, ["owner", "admin"]);

    // Lock resource
    const resLock = await tx.query<ProjectResourceRow>(
      `SELECT * FROM project_resources 
       WHERE organization_id = $1 AND project_id = $2 AND id = $3 
       FOR UPDATE;`,
      [input.organizationId, input.projectId, input.resourceId]
    );
    const existing = resLock.rows[0];
    if (!existing) {
      throw new NotFoundError("Project resource");
    }

    // Soft delete: status = 'deprovisioned', deleted_at = now()
    const updateRes = await tx.query<ProjectResourceRow>(
      `UPDATE project_resources 
       SET status = 'deprovisioned', deleted_at = now(), updated_at = now() 
       WHERE id = $1 
       RETURNING *;`,
      [existing.id]
    );

    // Revoke active credentials
    await tx.query(
      `UPDATE resource_credentials 
       SET status = 'revoked', revoked_at = now() 
       WHERE resource_id = $1 AND status = 'active';`,
      [existing.id]
    );

    const updatedRow = updateRes.rows[0];

    // Record deprovision audit event
    await tx.query(
      `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
      [
        input.organizationId,
        "resource.deprovisioned",
        "project_resource",
        updatedRow.id,
        "success",
        JSON.stringify({
          name: updatedRow.name,
          resourceType: updatedRow.resource_type,
          providerId: updatedRow.provider_id,
        }),
      ]
    );

    return this.mapResourceDto(updatedRow);
  }

  /**
   * Reconciles external provider side effects or failure states.
   */
  async reconcileResourceState(
    tx: ScopedTransaction,
    input: ReconcileResourceInput,
    userId: string
  ): Promise<ProjectResourceResponseDTO> {
    await this.assertOrgRole(tx, input.organizationId, userId, ["owner", "admin"]);

    const sanitizedError = input.errorDetails
      ? redactSensitiveData(input.errorDetails).text
      : null;

    const resLock = await tx.query<ProjectResourceRow>(
      `SELECT * FROM project_resources 
       WHERE organization_id = $1 AND project_id = $2 AND id = $3 
       FOR UPDATE;`,
      [input.organizationId, input.projectId, input.resourceId]
    );
    const existing = resLock.rows[0];
    if (!existing) {
      throw new NotFoundError("Project resource");
    }

    const updateRes = await tx.query<ProjectResourceRow>(
      `UPDATE project_resources 
       SET status = $1, error_details = $2, updated_at = now() 
       WHERE id = $3 
       RETURNING *;`,
      [input.status, sanitizedError, existing.id]
    );

    const updatedRow = updateRes.rows[0];

    await tx.query(
      `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
      [
        input.organizationId,
        "resource.reconciled",
        "project_resource",
        updatedRow.id,
        "success",
        JSON.stringify({
          status: updatedRow.status,
          errorSummary: sanitizedError ? sanitizedError.slice(0, 100) : null,
        }),
      ]
    );

    return this.mapResourceDto(updatedRow);
  }
}
