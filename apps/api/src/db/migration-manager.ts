import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type pg from "pg";

/**
 * 64-bit application advisory lock ID for serializing ModuCraft schema migrations.
 * Prevents race conditions and multiple workers running concurrent migrations.
 */
export const MODUCRAFT_MIGRATION_ADVISORY_LOCK_ID = 84920491048102;

export interface MigrationRecord {
  version: string;
  name: string;
  checksum: string;
  status: "applied" | "failed";
  executionTimeMs: number;
  appliedAt: Date;
  errorMessage?: string | null;
}

export class MigrationChecksumDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationChecksumDriftError";
  }
}

export class MigrationInterruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationInterruptedError";
  }
}

export class MigrationExecutionError extends Error {
  constructor(message: string, public readonly originalError: any) {
    super(message);
    this.name = "MigrationExecutionError";
  }
}

export class MigrationLockConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationLockConflictError";
  }
}

export class MigrationAdoptionError extends Error {
  constructor(public readonly version: string, public readonly reason: string) {
    super(`Schema verification failed for historical migration '${version}': ${reason}`);
    this.name = "MigrationAdoptionError";
  }
}

export class MigrationPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationPermissionError";
  }
}

export class UntrackedSchemaMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UntrackedSchemaMigrationError";
  }
}

/**
 * MigrationManager
 *
 * Implements hardened schema migration tracking with:
 * - Distributed PostgreSQL advisory lock serialization
 * - Checksum verification and fail-closed drift detection
 * - Deep catalog-level historical schema verification & adoption
 * - Atomic transactional DDL execution and rollback on failure
 * - Non-transactional migration support documentation & handling
 * - Least-privilege role boundary enforcement (runtime role rejection)
 */
export class MigrationManager {
  /**
   * Computes the SHA-256 checksum of migration SQL file contents.
   */
  static computeChecksum(content: string): string {
    return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
  }

  /**
   * Extracts version prefix from migration filename (e.g., '0001' from '0001_identity_tenant_core.sql').
   */
  static extractVersion(fileName: string): string {
    const match = fileName.match(/^(\d+)/);
    if (!match) {
      throw new Error(`Invalid migration filename format '${fileName}'. Expected numeric prefix (e.g. 0001_...).`);
    }
    return match[1];
  }

  /**
   * Tries to acquire session-level advisory lock for migration execution.
   */
  async acquireAdvisoryLock(client: pg.Client | pg.PoolClient): Promise<boolean> {
    const res = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock($1) AS acquired;`,
      [MODUCRAFT_MIGRATION_ADVISORY_LOCK_ID]
    );
    return res.rows[0]?.acquired ?? false;
  }

  /**
   * Releases session-level advisory lock.
   */
  async releaseAdvisoryLock(client: pg.Client | pg.PoolClient): Promise<boolean> {
    const res = await client.query<{ released: boolean }>(
      `SELECT pg_advisory_unlock($1) AS released;`,
      [MODUCRAFT_MIGRATION_ADVISORY_LOCK_ID]
    );
    return res.rows[0]?.released ?? false;
  }

  /**
   * Executes an action wrapped inside PostgreSQL advisory locking.
   * Throws MigrationLockConflictError if another migration process holds the lock.
   */
  async withAdvisoryLock<T>(client: pg.Client | pg.PoolClient, action: () => Promise<T>): Promise<T> {
    const acquired = await this.acquireAdvisoryLock(client);
    if (!acquired) {
      throw new MigrationLockConflictError(
        `Another migration process currently holds the migration lock (lock ID: ${MODUCRAFT_MIGRATION_ADVISORY_LOCK_ID}). Concurrent migration prevented.`
      );
    }
    try {
      return await action();
    } finally {
      await this.releaseAdvisoryLock(client);
    }
  }

  /**
   * Asserts that current database user possesses administrative/migration credentials.
   * Fails closed if invoked under the least-privileged moducraft_runtime role.
   */
  async assertMigrationRole(client: pg.Client | pg.PoolClient): Promise<void> {
    const res = await client.query<{ current_user: string }>(`SELECT current_user;`);
    const currentUser = res.rows[0]?.current_user;
    if (currentUser === "moducraft_runtime") {
      throw new MigrationPermissionError(
        `Role 'moducraft_runtime' is the restricted API application role and cannot execute DDL migrations. Migrations must be run under a trusted administrative/migration role.`
      );
    }
  }

  /**
   * Initializes the schema_migrations tracking table if not present.
   */
  async ensureMigrationTable(client: pg.Client | pg.PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version VARCHAR(50) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        checksum VARCHAR(64) NOT NULL,
        status VARCHAR(20) NOT NULL,
        execution_time_ms INTEGER NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        error_message TEXT
      );
    `);
  }

  /**
   * Fetches all recorded migrations from public.schema_migrations.
   */
  async getAppliedMigrations(
    client: pg.Client | pg.PoolClient,
    autoCreate: boolean = false
  ): Promise<Map<string, MigrationRecord>> {
    const check = await client.query<{ exists: boolean }>(
      `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists;`
    );
    if (!check.rows[0]?.exists) {
      if (autoCreate) {
        await this.ensureMigrationTable(client);
      } else {
        return new Map<string, MigrationRecord>();
      }
    }

    const res = await client.query<MigrationRecord>(`
      SELECT version, name, checksum, status,
             execution_time_ms as "executionTimeMs",
             applied_at as "appliedAt",
             error_message as "errorMessage"
      FROM public.schema_migrations
      ORDER BY version ASC;
    `);

    const map = new Map<string, MigrationRecord>();
    for (const row of res.rows) {
      map.set(row.version, row);
    }
    return map;
  }

  /**
   * Inspects migrations directory and compares with applied migrations.
   * Throws MigrationChecksumDriftError if any applied migration has been altered on disk.
   * Throws MigrationInterruptedError if any prior migration is in 'failed' status.
   */
  async planMigrations(
    migrationsDir: string,
    applied: Map<string, MigrationRecord>
  ): Promise<{
    pendingFiles: string[];
    appliedFiles: string[];
    driftCount: number;
  }> {
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const pendingFiles: string[] = [];
    const appliedFiles: string[] = [];

    for (const file of files) {
      const version = MigrationManager.extractVersion(file);
      const filePath = path.join(migrationsDir, file);
      const content = fs.readFileSync(filePath, "utf-8");
      const diskChecksum = MigrationManager.computeChecksum(content);

      const record = applied.get(version);
      if (record) {
        if (record.status === "failed") {
          throw new MigrationInterruptedError(
            `Migration '${file}' (version ${version}) is in 'failed' state. Manual intervention required.`
          );
        }
        if (record.checksum !== diskChecksum) {
          throw new MigrationChecksumDriftError(
            `Checksum drift detected for migration '${file}'. Stored: '${record.checksum}', Disk: '${diskChecksum}'. Refusing execution due to schema drift.`
          );
        }
        appliedFiles.push(file);
      } else {
        pendingFiles.push(file);
      }
    }

    return {
      pendingFiles,
      appliedFiles,
      driftCount: 0,
    };
  }

  /**
   * Deep physical catalog inspection verifying the effects of historical migrations 0001–0010.
   * Prevents registering historical migrations without confirming their actual schema objects.
   */
  async verifySchemaMilestone(
    client: pg.Client | pg.PoolClient,
    version: string
  ): Promise<{ valid: boolean; reason?: string }> {
    switch (version) {
      case "0001": {
        const tables = ["app_users", "organizations", "organization_memberships", "projects", "audit_events"];
        const res = await client.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1);`,
          [tables]
        );
        const found = new Set(res.rows.map((r) => r.table_name));
        for (const t of tables) {
          if (!found.has(t)) return { valid: false, reason: `Missing required table '${t}' for migration 0001` };
        }
        return { valid: true };
      }
      case "0002": {
        const funcs = ["moducraft_current_user_id", "moducraft_is_org_member", "moducraft_has_org_role"];
        const res = await client.query<{ proname: string }>(
          `SELECT proname FROM pg_proc JOIN pg_namespace ON pg_proc.pronamespace = pg_namespace.oid 
           WHERE pg_namespace.nspname = 'public' AND proname = ANY($1);`,
          [funcs]
        );
        const found = new Set(res.rows.map((r) => r.proname));
        for (const f of funcs) {
          if (!found.has(f)) return { valid: false, reason: `Missing required function '${f}' for migration 0002` };
        }
        return { valid: true };
      }
      case "0003": {
        const res = await client.query<{ rolcanlogin: boolean }>(
          `SELECT rolcanlogin FROM pg_roles WHERE rolname = 'moducraft_runtime';`
        );
        if (res.rowCount === 0) return { valid: false, reason: "Missing role 'moducraft_runtime' for migration 0003" };
        if (!res.rows[0].rolcanlogin) return { valid: false, reason: "Role 'moducraft_runtime' lacks LOGIN privilege for migration 0003" };
        return { valid: true };
      }
      case "0004": {
        const res = await client.query<{ proname: string }>(
          `SELECT proname FROM pg_proc JOIN pg_namespace ON pg_proc.pronamespace = pg_namespace.oid 
           WHERE pg_namespace.nspname = 'public' AND proname = 'moducraft_record_audit_event';`
        );
        if (res.rowCount === 0) return { valid: false, reason: "Missing function 'moducraft_record_audit_event' for migration 0004" };
        return { valid: true };
      }
      case "0005": {
        const tables = ["agent_tasks", "agent_task_steps", "agent_task_events"];
        const res = await client.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1);`,
          [tables]
        );
        const found = new Set(res.rows.map((r) => r.table_name));
        for (const t of tables) {
          if (!found.has(t)) return { valid: false, reason: `Missing required table '${t}' for migration 0005` };
        }
        return { valid: true };
      }
      case "0006": {
        const tables = ["provider_configs", "provider_usage_records"];
        const res = await client.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1);`,
          [tables]
        );
        const found = new Set(res.rows.map((r) => r.table_name));
        for (const t of tables) {
          if (!found.has(t)) return { valid: false, reason: `Missing required table '${t}' for migration 0006` };
        }
        return { valid: true };
      }
      case "0007": {
        const tables = ["conversations", "conversation_messages", "agent_memories"];
        const res = await client.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1);`,
          [tables]
        );
        const found = new Set(res.rows.map((r) => r.table_name));
        for (const t of tables) {
          if (!found.has(t)) return { valid: false, reason: `Missing required table '${t}' for migration 0007` };
        }
        return { valid: true };
      }
      case "0008": {
        const tables = ["agent_artifacts", "agent_approvals"];
        const res = await client.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1);`,
          [tables]
        );
        const found = new Set(res.rows.map((r) => r.table_name));
        for (const t of tables) {
          if (!found.has(t)) return { valid: false, reason: `Missing required table '${t}' for migration 0008` };
        }
        return { valid: true };
      }
      case "0009": {
        const tableRes = await client.query<{ exists: boolean }>(
          `SELECT to_regclass('public.agent_approvals') IS NOT NULL AS exists;`
        );
        if (!tableRes.rows[0]?.exists) {
          return { valid: false, reason: "Missing table 'agent_approvals' for migration 0009" };
        }
        const res = await client.query<{ conname: string; confdeltype: string; def: string }>(
          `SELECT conname, confdeltype, pg_get_constraintdef(oid) as def 
           FROM pg_constraint 
           WHERE conrelid = 'public.agent_approvals'::regclass 
             AND conname IN ('agent_approvals_status_check', 'agent_approvals_artifact_id_fkey');`
        );
        const map = new Map(res.rows.map((r) => [r.conname, r]));
        const statusCheck = map.get("agent_approvals_status_check");
        if (!statusCheck || !statusCheck.def.includes("consumed")) {
          return { valid: false, reason: "Constraint 'agent_approvals_status_check' missing or lacks 'consumed' status for migration 0009" };
        }
        const fkey = map.get("agent_approvals_artifact_id_fkey");
        if (!fkey || fkey.confdeltype !== "r") {
          return { valid: false, reason: "Constraint 'agent_approvals_artifact_id_fkey' missing or not ON DELETE RESTRICT for migration 0009" };
        }
        return { valid: true };
      }
      case "0010": {
        const tableRes = await client.query<{ exists: boolean }>(
          `SELECT to_regclass('public.patch_application_journals') IS NOT NULL AS exists;`
        );
        if (!tableRes.rows[0]?.exists) {
          return { valid: false, reason: "Missing table 'patch_application_journals' for migration 0010" };
        }
        const res = await client.query<{ conname: string }>(
          `SELECT conname FROM pg_constraint 
           WHERE conrelid = 'public.patch_application_journals'::regclass 
             AND conname = 'patch_journals_status_check';`
        );
        if (res.rowCount === 0) {
          return { valid: false, reason: "Constraint 'patch_journals_status_check' missing on patch_application_journals for migration 0010" };
        }
        return { valid: true };
      }
      case "0011": {
        const tables = ["project_resources", "resource_credentials"];
        const res = await client.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1);`,
          [tables]
        );
        const found = new Set(res.rows.map((r) => r.table_name));
        for (const t of tables) {
          if (!found.has(t)) return { valid: false, reason: `Missing required table '${t}' for migration 0011` };
        }
        return { valid: true };
      }
      default:
        return { valid: false, reason: `Unknown migration version '${version}' for milestone verification.` };
    }
  }

  /**
   * Safely adopts historical migrations into schema_migrations after catalog verification.
   * Only registers historical migrations whose schema objects are verified to exist.
   * Pre-validates ALL milestones before writing any baseline records, guaranteeing atomic
   * all-or-nothing adoption without leaving partial baselines on incomplete schemas.
   * Fails closed if any expected object is missing or has drifted.
   */
  async adoptHistoricalBaseline(
    client: pg.Client,
    migrationsDir: string,
    upToVersion: string = "0010"
  ): Promise<{ adopted: MigrationRecord[]; verified: string[]; skipped: string[] }> {
    await this.assertMigrationRole(client);

    return this.withAdvisoryLock(client, async () => {
      await this.ensureMigrationTable(client);
      const applied = await this.getAppliedMigrations(client);

      const files = fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith(".sql"))
        .sort();

      const adopted: MigrationRecord[] = [];
      const verified: string[] = [];
      const skipped: string[] = [];

      const targetVersionNum = parseInt(upToVersion, 10);

      // Pass 1: Pre-validation of ALL milestones and checksums up to upToVersion
      // Guarantees atomic all-or-nothing adoption: no partial baseline is ever written
      const toAdopt: { version: string; file: string; checksum: string }[] = [];

      for (const file of files) {
        const version = MigrationManager.extractVersion(file);
        const versionNum = parseInt(version, 10);
        if (versionNum > targetVersionNum) continue;

        const filePath = path.join(migrationsDir, file);
        const content = fs.readFileSync(filePath, "utf-8");
        const diskChecksum = MigrationManager.computeChecksum(content);

        const existing = applied.get(version);
        if (existing) {
          if (existing.checksum !== diskChecksum) {
            throw new MigrationChecksumDriftError(
              `Checksum drift on already-adopted migration '${file}'. Stored: '${existing.checksum}', Disk: '${diskChecksum}'.`
            );
          }
          skipped.push(file);
          continue;
        }

        // Deep physical schema object verification before registering
        const check = await this.verifySchemaMilestone(client, version);
        if (!check.valid) {
          throw new MigrationAdoptionError(version, check.reason || "Verification failed");
        }

        toAdopt.push({ version, file, checksum: diskChecksum });
      }

      // Pass 2: Atomic transactional insertion of verified baseline records
      if (toAdopt.length > 0) {
        await client.query("BEGIN;");
        try {
          for (const item of toAdopt) {
            await client.query(
              `INSERT INTO public.schema_migrations (version, name, checksum, status, execution_time_ms, applied_at, error_message)
               VALUES ($1, $2, $3, 'applied', 0, now(), NULL);`,
              [item.version, item.file, item.checksum]
            );

            const record: MigrationRecord = {
              version: item.version,
              name: item.file,
              checksum: item.checksum,
              status: "applied",
              executionTimeMs: 0,
              appliedAt: new Date(),
            };

            adopted.push(record);
            verified.push(item.file);
          }
          await client.query("COMMIT;");
        } catch (insertErr) {
          await client.query("ROLLBACK;");
          throw insertErr;
        }
      }

      return { adopted, verified, skipped };
    });
  }

  /**
   * Applies a single migration inside a transactional block.
   * If non-transactional annotations are present, runs without transaction wrapper.
   * Catches errors, cleanly rolls back DDL, and persists failure metadata.
   */
  async applySingleMigration(
    client: pg.Client,
    migrationsDir: string,
    fileName: string
  ): Promise<MigrationRecord> {
    const version = MigrationManager.extractVersion(fileName);
    const filePath = path.join(migrationsDir, fileName);
    const content = fs.readFileSync(filePath, "utf-8");
    const checksum = MigrationManager.computeChecksum(content);

    const isNonTransactional =
      content.includes("-- moducraft:no-transaction") ||
      content.includes("/* moducraft:no-transaction */");

    const startTime = Date.now();
    try {
      if (!isNonTransactional) {
        await client.query("BEGIN;");
      }
      await client.query(content);

      const elapsed = Date.now() - startTime;
      await client.query(
        `INSERT INTO public.schema_migrations (version, name, checksum, status, execution_time_ms, applied_at, error_message)
         VALUES ($1, $2, $3, 'applied', $4, now(), NULL)
         ON CONFLICT (version) DO UPDATE
         SET checksum = EXCLUDED.checksum,
             status = EXCLUDED.status,
             execution_time_ms = EXCLUDED.execution_time_ms,
             applied_at = now(),
             error_message = NULL;`,
        [version, fileName, checksum, elapsed]
      );
      if (!isNonTransactional) {
        await client.query("COMMIT;");
      }

      return {
        version,
        name: fileName,
        checksum,
        status: "applied",
        executionTimeMs: elapsed,
        appliedAt: new Date(),
      };
    } catch (err: any) {
      if (!isNonTransactional) {
        try {
          await client.query("ROLLBACK;");
        } catch {}
      }

      // Record failure with sanitized error message in an autonomous transaction
      try {
        const sanitizedErr = (err.message || "Unknown error").slice(0, 1000);
        await client.query(
          `INSERT INTO public.schema_migrations (version, name, checksum, status, execution_time_ms, applied_at, error_message)
           VALUES ($1, $2, $3, 'failed', $4, now(), $5)
           ON CONFLICT (version) DO UPDATE
           SET status = 'failed', applied_at = now(), error_message = EXCLUDED.error_message;`,
          [version, fileName, checksum, Date.now() - startTime, sanitizedErr]
        );
      } catch {}

      throw new MigrationExecutionError(
        `Failed executing migration '${fileName}': ${err.message}`,
        err
      );
    }
  }

  /**
   * Runs all pending migrations sequentially under advisory lock serialization.
   * Refuses to run if user tables exist in a non-empty, untracked schema without prior baseline adoption.
   */
  async migrate(
    client: pg.Client,
    migrationsDir: string
  ): Promise<{ applied: MigrationRecord[]; totalPending: number }> {
    await this.assertMigrationRole(client);

    return this.withAdvisoryLock(client, async () => {
      // 1. Check if public.schema_migrations exists
      const tableCheck = await client.query<{ exists: boolean }>(
        `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists;`
      );
      const hasTrackingTable = tableCheck.rows[0]?.exists ?? false;

      let currentApplied = new Map<string, MigrationRecord>();
      if (hasTrackingTable) {
        currentApplied = await this.getAppliedMigrations(client);
      }

      // 2. Safety guard: If tracking table is absent or has 0 applied migrations,
      // verify whether the database already contains non-empty user tables.
      // If tables exist, running migrate() blindly would replay historical migrations
      // against an untracked schema, causing table conflicts, data corruption, or partial failures.
      if (currentApplied.size === 0) {
        const userTableRes = await client.query<{ count: string }>(
          `SELECT count(*)::int AS count 
           FROM information_schema.tables 
           WHERE table_schema = 'public' 
             AND table_type = 'BASE TABLE' 
             AND table_name != 'schema_migrations';`
        );
        const existingTableCount = parseInt(userTableRes.rows[0]?.count ?? "0", 10);
        if (existingTableCount > 0) {
          throw new UntrackedSchemaMigrationError(
            `Untracked schema detected: Database contains ${existingTableCount} existing table(s), but migration tracking is uninitialized. ` +
            `Refusing to run migrations to prevent blind replay. Explicit baseline adoption via 'db:adopt' is required before running migrations.`
          );
        }
      }

      await this.ensureMigrationTable(client);
      if (!hasTrackingTable) {
        currentApplied = await this.getAppliedMigrations(client);
      }
      const plan = await this.planMigrations(migrationsDir, currentApplied);

      const newlyApplied: MigrationRecord[] = [];
      for (const pendingFile of plan.pendingFiles) {
        const record = await this.applySingleMigration(client, migrationsDir, pendingFile);
        newlyApplied.push(record);
      }

      return {
        applied: newlyApplied,
        totalPending: plan.pendingFiles.length,
      };
    });
  }
}
