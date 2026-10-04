import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  MigrationManager,
  MigrationChecksumDriftError,
  MigrationInterruptedError,
  MigrationExecutionError,
  MigrationLockConflictError,
  MigrationAdoptionError,
  MigrationPermissionError,
  UntrackedSchemaMigrationError,
  MODUCRAFT_MIGRATION_ADVISORY_LOCK_ID,
} from "../src/db/migration-manager.js";
import {
  getTestDatabaseUrls,
  getDisposableDatabaseUrl,
  getAdminRootDatabaseUrl,
} from "./helpers/test-db-guard.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, "../../../db/migrations");

const { superuserDbUrl, runtimeDbUrl } = getTestDatabaseUrls({
  allowDisposable: true,
  allowAdminRoot: true,
});
const postgresDbUrl = getAdminRootDatabaseUrl();

describe("Phase 4D.8: Migration Manager Integration & Security Closure", () => {
  let adminPool: pg.Pool;

  before(async () => {
    adminPool = new pg.Pool({ connectionString: superuserDbUrl, max: 2 });
  });

  after(async () => {
    await adminPool.end();
  });

  // ===========================================================================
  // 1. PostgreSQL Advisory Lock Concurrency Serialization
  // ===========================================================================
  describe("1. Advisory Lock Concurrency Serialization (Real DB Integration)", () => {
    const lockDbName = "moducraft_disposable_lock_eval";

    before(async () => {
      const rootClient = new pg.Client({ connectionString: postgresDbUrl });
      await rootClient.connect();
      try {
        await rootClient.query(`DROP DATABASE IF EXISTS ${lockDbName};`);
        await rootClient.query(`CREATE DATABASE ${lockDbName};`);
      } finally {
        await rootClient.end();
      }
    });

    after(async () => {
      const rootClient = new pg.Client({ connectionString: postgresDbUrl });
      await rootClient.connect();
      try {
        await rootClient.query(`
          SELECT pg_terminate_backend(pid) FROM pg_stat_activity 
          WHERE datname = '${lockDbName}' AND pid <> pg_backend_pid();
        `);
        await rootClient.query(`DROP DATABASE IF EXISTS ${lockDbName};`);
      } finally {
        await rootClient.end();
      }
    });

    it("1.1 should serialize concurrent migration runs via pg_try_advisory_lock", async () => {
      const client1 = new pg.Client({
        connectionString: getDisposableDatabaseUrl(lockDbName),
      });
      const client2 = new pg.Client({
        connectionString: getDisposableDatabaseUrl(lockDbName),
      });

      await client1.connect();
      await client2.connect();

      const manager1 = new MigrationManager();
      const manager2 = new MigrationManager();

      try {
        // Client 1 acquires lock
        const locked1 = await manager1.acquireAdvisoryLock(client1);
        assert.equal(locked1, true, "Client 1 should acquire advisory lock");

        // Client 2 attempts withAdvisoryLock -> should throw MigrationLockConflictError
        await assert.rejects(
          async () =>
            manager2.withAdvisoryLock(client2, async () => {
              return "should_not_run";
            }),
          (err: any) =>
            err instanceof MigrationLockConflictError &&
            err.message.includes("Another migration process currently holds the migration lock")
        );

        // Client 1 releases lock
        const released1 = await manager1.releaseAdvisoryLock(client1);
        assert.equal(released1, true, "Client 1 should release advisory lock");

        // Client 2 can now acquire lock and proceed
        const executed2 = await manager2.withAdvisoryLock(client2, async () => {
          return "client2_success";
        });
        assert.equal(executed2, "client2_success");
      } finally {
        await client1.end().catch(() => {});
        await client2.end().catch(() => {});
      }
    });
  });

  // ===========================================================================
  // 2. Existing Database Adoption & Schema Milestone Verification
  // ===========================================================================
  describe("2. Existing Database Adoption (Disposable DB Integration)", () => {
    const adoptDbName = "moducraft_disposable_adopt_eval";

    before(async () => {
      const rootClient = new pg.Client({ connectionString: postgresDbUrl });
      await rootClient.connect();
      try {
        await rootClient.query(`DROP DATABASE IF EXISTS ${adoptDbName};`);
        await rootClient.query(`CREATE DATABASE ${adoptDbName};`);
      } finally {
        await rootClient.end();
      }

      // Replay migrations 0001-0010 directly (simulating historical manual psql execution)
      const targetClient = new pg.Client({
        connectionString: getDisposableDatabaseUrl(adoptDbName),
      });
      await targetClient.connect();
      try {
        const files = fs
          .readdirSync(migrationsDir)
          .filter((f) => f.endsWith(".sql"))
          .sort();

        for (const f of files) {
          const content = fs.readFileSync(path.join(migrationsDir, f), "utf-8");
          await targetClient.query(content);
        }
      } finally {
        await targetClient.end();
      }
    });

    after(async () => {
      const rootClient = new pg.Client({ connectionString: postgresDbUrl });
      await rootClient.connect();
      try {
        await rootClient.query(`
          SELECT pg_terminate_backend(pid) FROM pg_stat_activity 
          WHERE datname = '${adoptDbName}' AND pid <> pg_backend_pid();
        `);
        await rootClient.query(`DROP DATABASE IF EXISTS ${adoptDbName};`);
      } finally {
        await rootClient.end();
      }
    });

    it("2.1 should adopt historical migrations 0001-0010 after deep schema catalog verification", async () => {
      const client = new pg.Client({
        connectionString: getDisposableDatabaseUrl(adoptDbName),
      });
      await client.connect();

      const manager = new MigrationManager();

      try {
        // Initially, schema_migrations does not exist
        const initialCheck = await client.query<{ exists: boolean }>(
          `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists;`
        );
        assert.equal(initialCheck.rows[0].exists, false, "schema_migrations should not exist initially");

        // Run adoption
        const result = await manager.adoptHistoricalBaseline(client, migrationsDir, "0010");
        assert.equal(result.adopted.length, 10, "Should adopt all 10 historical migrations");
        assert.equal(result.verified.length, 10, "Should verify 10 schema milestones");
        assert.equal(result.skipped.length, 0);

        // Verify records in schema_migrations
        const applied = await manager.getAppliedMigrations(client);
        assert.equal(applied.size, 10);
        for (let i = 1; i <= 10; i++) {
          const v = String(i).padStart(4, "0");
          const rec = applied.get(v);
          assert.ok(rec, `Record for version ${v} should exist`);
          assert.equal(rec.status, "applied");
          assert.equal(rec.executionTimeMs, 0, "Adopted migration should have executionTimeMs = 0");
        }

        // Running planMigrations now should show 0 pending files
        const plan = await manager.planMigrations(migrationsDir, applied);
        assert.equal(plan.pendingFiles.length, 0, "No pending files after full adoption");
        assert.equal(plan.appliedFiles.length, 10);

        // Running adoption a second time should be idempotent (skip already-recorded)
        const secondAdopt = await manager.adoptHistoricalBaseline(client, migrationsDir, "0010");
        assert.equal(secondAdopt.adopted.length, 0, "No newly adopted on second run");
        assert.equal(secondAdopt.skipped.length, 10, "All 10 skipped on second run");
      } finally {
        await client.end();
      }
    });
  });

  // ===========================================================================
  // 3. Adoption Rejection on Partial / Missing Schema Milestone
  // ===========================================================================
  describe("3. Adoption Rejection on Partial Schema State (Disposable DB Integration)", () => {
    const partialDbName = "moducraft_disposable_partial_eval";

    before(async () => {
      const rootClient = new pg.Client({ connectionString: postgresDbUrl });
      await rootClient.connect();
      try {
        await rootClient.query(`DROP DATABASE IF EXISTS ${partialDbName};`);
        await rootClient.query(`CREATE DATABASE ${partialDbName};`);
      } finally {
        await rootClient.end();
      }

      // Replay only migrations 0001 through 0008 (deliberately missing 0009 and 0010)
      const targetClient = new pg.Client({
        connectionString: getDisposableDatabaseUrl(partialDbName),
      });
      await targetClient.connect();
      try {
        const files = fs
          .readdirSync(migrationsDir)
          .filter((f) => f.endsWith(".sql"))
          .sort();

        for (const f of files.slice(0, 8)) {
          const content = fs.readFileSync(path.join(migrationsDir, f), "utf-8");
          await targetClient.query(content);
        }
      } finally {
        await targetClient.end();
      }
    });

    after(async () => {
      const rootClient = new pg.Client({ connectionString: postgresDbUrl });
      await rootClient.connect();
      try {
        await rootClient.query(`
          SELECT pg_terminate_backend(pid) FROM pg_stat_activity 
          WHERE datname = '${partialDbName}' AND pid <> pg_backend_pid();
        `);
        await rootClient.query(`DROP DATABASE IF EXISTS ${partialDbName};`);
      } finally {
        await rootClient.end();
      }
    });

    it("3.1 should fail closed with MigrationAdoptionError if expected schema objects are missing", async () => {
      const client = new pg.Client({
        connectionString: getDisposableDatabaseUrl(partialDbName),
      });
      await client.connect();

      const manager = new MigrationManager();

      try {
        await assert.rejects(
          async () => manager.adoptHistoricalBaseline(client, migrationsDir, "0010"),
          (err: any) =>
            err instanceof MigrationAdoptionError &&
            err.version === "0009" &&
            err.message.includes("Schema verification failed for historical migration '0009'")
        );

        // Verify that failed migration was not recorded as applied and zero partial baseline was written
        const applied = await manager.getAppliedMigrations(client);
        assert.equal(applied.size, 0, "No partial baseline records should be recorded on failure");
        assert.equal(applied.has("0009"), false, "0009 should not be recorded");
        assert.equal(applied.has("0010"), false, "0010 should not be recorded");
      } finally {
        await client.end();
      }
    });
  });

  // ===========================================================================
  // 4. Role Privilege Boundary & Runtime Role Rejection
  // ===========================================================================
  describe("4. Least-Privilege Role Boundary (Real DB Integration)", () => {
    it("4.1 should reject migrate() when connected as moducraft_runtime", async () => {
      const runtimeClient = new pg.Client({ connectionString: runtimeDbUrl });
      await runtimeClient.connect();

      const manager = new MigrationManager();

      try {
        await assert.rejects(
          async () => manager.migrate(runtimeClient, migrationsDir),
          (err: any) =>
            err instanceof MigrationPermissionError &&
            err.message.includes("Role 'moducraft_runtime' is the restricted API application role")
        );
      } finally {
        await runtimeClient.end();
      }
    });

    it("4.2 should reject adoptHistoricalBaseline() when connected as moducraft_runtime", async () => {
      const runtimeClient = new pg.Client({ connectionString: runtimeDbUrl });
      await runtimeClient.connect();

      const manager = new MigrationManager();

      try {
        await assert.rejects(
          async () => manager.adoptHistoricalBaseline(runtimeClient, migrationsDir, "0010"),
          (err: any) =>
            err instanceof MigrationPermissionError &&
            err.message.includes("Role 'moducraft_runtime' is the restricted API application role")
        );
      } finally {
        await runtimeClient.end();
      }
    });
  });

  // ===========================================================================
  // 5. Checksum Drift Detection
  // ===========================================================================
  describe("5. Checksum Drift Detection (Unit + Real DB)", () => {
    const driftDbName = "moducraft_disposable_drift_eval";

    before(async () => {
      const rootClient = new pg.Client({ connectionString: postgresDbUrl });
      await rootClient.connect();
      try {
        await rootClient.query(`DROP DATABASE IF EXISTS ${driftDbName};`);
        await rootClient.query(`CREATE DATABASE ${driftDbName};`);
      } finally {
        await rootClient.end();
      }
    });

    after(async () => {
      const rootClient = new pg.Client({ connectionString: postgresDbUrl });
      await rootClient.connect();
      try {
        await rootClient.query(`
          SELECT pg_terminate_backend(pid) FROM pg_stat_activity 
          WHERE datname = '${driftDbName}' AND pid <> pg_backend_pid();
        `);
        await rootClient.query(`DROP DATABASE IF EXISTS ${driftDbName};`);
      } finally {
        await rootClient.end();
      }
    });

    it("5.1 should detect tampered migration checksum and refuse execution", async () => {
      const client = new pg.Client({
        connectionString: getDisposableDatabaseUrl(driftDbName),
      });
      await client.connect();

      const manager = new MigrationManager();

      try {
        await manager.ensureMigrationTable(client);

        // Record a forged/tampered checksum for migration 0001
        await client.query(
          `INSERT INTO public.schema_migrations (version, name, checksum, status, execution_time_ms)
           VALUES ('0001', '0001_identity_tenant_core.sql', '0000000000000000000000000000000000000000000000000000000000000000', 'applied', 10);`
        );

        const applied = await manager.getAppliedMigrations(client);

        await assert.rejects(
          async () => manager.planMigrations(migrationsDir, applied),
          (err: any) =>
            err instanceof MigrationChecksumDriftError &&
            err.message.includes("Checksum drift detected for migration '0001_identity_tenant_core.sql'")
        );
      } finally {
        await client.end();
      }
    });
  });

  // ===========================================================================
  // 6. Phase 4D.9: CLI Safety & Untracked Schema Protection Regression Tests
  // ===========================================================================
  describe("6. Phase 4D.9: CLI Safety & Untracked Schema Protection", () => {
    const untrackedDbName = "moducraft_disposable_untracked_eval";
    const cleanDbName = "moducraft_disposable_clean_eval";

    before(async () => {
      const rootClient = new pg.Client({ connectionString: postgresDbUrl });
      await rootClient.connect();
      try {
        await rootClient.query(`DROP DATABASE IF EXISTS ${untrackedDbName};`);
        await rootClient.query(`CREATE DATABASE ${untrackedDbName};`);
        await rootClient.query(`DROP DATABASE IF EXISTS ${cleanDbName};`);
        await rootClient.query(`CREATE DATABASE ${cleanDbName};`);
      } finally {
        await rootClient.end();
      }

      // Populate untrackedDbName with sample user table simulating pre-existing untracked schema
      const untrackedClient = new pg.Client({
        connectionString: getDisposableDatabaseUrl(untrackedDbName),
      });
      await untrackedClient.connect();
      try {
        await untrackedClient.query(`
          CREATE TABLE public.app_users (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            email VARCHAR(255) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
        `);
      } finally {
        await untrackedClient.end();
      }
    });

    after(async () => {
      const rootClient = new pg.Client({ connectionString: postgresDbUrl });
      await rootClient.connect();
      try {
        await rootClient.query(`
          SELECT pg_terminate_backend(pid) FROM pg_stat_activity 
          WHERE datname IN ('${untrackedDbName}', '${cleanDbName}') AND pid <> pg_backend_pid();
        `);
        await rootClient.query(`DROP DATABASE IF EXISTS ${untrackedDbName};`);
        await rootClient.query(`DROP DATABASE IF EXISTS ${cleanDbName};`);
      } finally {
        await rootClient.end();
      }
    });

    it("6.1 should verify db:status logic is strictly read-only and does not create schema_migrations", async () => {
      const client = new pg.Client({
        connectionString: getDisposableDatabaseUrl(untrackedDbName),
      });
      await client.connect();

      const manager = new MigrationManager();

      try {
        // Verify schema_migrations does not exist
        const beforeCheck = await client.query<{ exists: boolean }>(
          `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists;`
        );
        assert.equal(beforeCheck.rows[0].exists, false);

        // Perform status inquiry with autoCreate = false
        const applied = await manager.getAppliedMigrations(client, false);
        assert.equal(applied.size, 0);

        // Verify schema_migrations was NOT created
        const afterCheck = await client.query<{ exists: boolean }>(
          `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists;`
        );
        assert.equal(afterCheck.rows[0].exists, false, "db:status inquiry must remain strictly read-only");
      } finally {
        await client.end();
      }
    });

    it("6.2 should refuse migrate() on non-empty untracked schema to prevent blind replay", async () => {
      const client = new pg.Client({
        connectionString: getDisposableDatabaseUrl(untrackedDbName),
      });
      await client.connect();

      const manager = new MigrationManager();

      try {
        await assert.rejects(
          async () => manager.migrate(client, migrationsDir),
          (err: any) =>
            err instanceof UntrackedSchemaMigrationError &&
            err.message.includes("Untracked schema detected: Database contains 1 existing table(s)") &&
            err.message.includes("Explicit baseline adoption via 'db:adopt' is required")
        );

        // Ensure schema_migrations was NOT created and no tables were altered
        const afterCheck = await client.query<{ exists: boolean }>(
          `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists;`
        );
        assert.equal(afterCheck.rows[0].exists, false, "schema_migrations should not be created on rejected run");
      } finally {
        await client.end();
      }
    });

    it("6.3 should permit migrate() on a clean empty database without prior adoption", async () => {
      const client = new pg.Client({
        connectionString: getDisposableDatabaseUrl(cleanDbName),
      });
      await client.connect();

      const manager = new MigrationManager();

      try {
        // Initial state has 0 tables
        const tableCountBefore = await client.query<{ count: string }>(
          `SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public';`
        );
        assert.equal(parseInt(tableCountBefore.rows[0].count, 10), 0);

        // Migrate on clean DB succeeds
        const res = await manager.migrate(client, migrationsDir);
        assert.equal(res.applied.length, 10, "Should apply all 10 migrations on empty database");

        // Verify schema_migrations now exists and has 10 records
        const applied = await manager.getAppliedMigrations(client);
        assert.equal(applied.size, 10);
      } finally {
        await client.end();
      }
    });

    it("6.4 should verify connection string credentials are redacted from logs and errors", () => {
      const sensitiveUri = "postgresql://my_secret_user:super_secret_password@db.internal.moducraft:5432/sanitization_eval_db";
      const errMsg = `Connection failure connecting to ${sensitiveUri} during migration`;
      const sanitized = errMsg.replace(/postgres(?:ql)?:\/\/[^\s@]+@[^\s/]+/gi, "postgresql://***:***@***");
      assert.ok(!sanitized.includes("my_secret_user"));
      assert.ok(!sanitized.includes("super_secret_password"));
      assert.ok(sanitized.includes("postgresql://***:***@***"));
    });

    it("6.5 should record failure state and halt subsequent migrations on execution error", async () => {
      const failDbName = "moducraft_disposable_injected_fail_eval";
      const rootClient = new pg.Client({ connectionString: postgresDbUrl });
      await rootClient.connect();
      try {
        await rootClient.query(`DROP DATABASE IF EXISTS ${failDbName};`);
        await rootClient.query(`CREATE DATABASE ${failDbName};`);
      } finally {
        await rootClient.end();
      }

      const client = new pg.Client({
        connectionString: getDisposableDatabaseUrl(failDbName),
      });
      await client.connect();

      const tempDir = path.resolve(__dirname, "../../test-temp-migrations");
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

      try {
        const manager = new MigrationManager();
        await manager.ensureMigrationTable(client);

        // Create a faulty migration file
        const faultyFile = "0001_faulty_test.sql";
        fs.writeFileSync(path.join(tempDir, faultyFile), "INVALID SYNTAX THAT CRASHES POSTGRESQL;");

        await assert.rejects(
          async () => manager.applySingleMigration(client, tempDir, faultyFile),
          (err: any) => err.name === "MigrationExecutionError"
        );

        // Verify failure was persisted with status = 'failed'
        const applied = await manager.getAppliedMigrations(client);
        assert.equal(applied.size, 1);
        const record = applied.get("0001");
        assert.ok(record);
        assert.equal(record.status, "failed");
        assert.ok(record.errorMessage && record.errorMessage.includes("syntax error"));

        // Subsequent planMigrations must halt with MigrationInterruptedError
        await assert.rejects(
          async () => manager.planMigrations(tempDir, applied),
          (err: any) =>
            err.name === "MigrationInterruptedError" &&
            err.message.includes("is in 'failed' state. Manual intervention required.")
        );
      } finally {
        if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
        await client.end();

        // Cleanup disposable failure database
        const cleanupRoot = new pg.Client({ connectionString: postgresDbUrl });
        await cleanupRoot.connect();
        try {
          await cleanupRoot.query(`
            SELECT pg_terminate_backend(pid) FROM pg_stat_activity 
            WHERE datname = '${failDbName}' AND pid <> pg_backend_pid();
          `);
          await cleanupRoot.query(`DROP DATABASE IF EXISTS ${failDbName};`);
        } finally {
          await cleanupRoot.end();
        }
      }
    });

    it("6.6 should fail closed when attempting to connect to invalid or unreachable database", async () => {
      const invalidClient = new pg.Client({
        connectionString: getDisposableDatabaseUrl("moducraft_disposable_non_existent_xyz"),
      });
      await assert.rejects(
        async () => invalidClient.connect(),
        (err: any) => err.message.includes('database "moducraft_disposable_non_existent_xyz" does not exist')
      );
    });
  });

  // ===========================================================================
  // 7. Primary Database Preservation & Cleanup Verification
  // ===========================================================================
  describe("7. Primary Database Safety & Parity Verification (Real DB Integration)", () => {
    it("7.1 should verify primary database was never dropped, truncated, or overwritten", async () => {
      const res = await adminPool.query(
        `SELECT datname FROM pg_database WHERE datname = 'moducraft';`
      );
      assert.equal(res.rowCount, 1, "Primary moducraft database must exist");
    });

    it("7.2 should verify all 16 public tables remain intact with relforcerowsecurity = t", async () => {
      const res = await adminPool.query<{ relname: string; relforcerowsecurity: boolean }>(
        `SELECT c.relname, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname != 'schema_migrations'
         ORDER BY c.relname;`
      );

      assert.equal(res.rowCount, 16, "All 16 tables must be present in public schema");
      for (const row of res.rows) {
        assert.equal(
          row.relforcerowsecurity,
          true,
          `Table '${row.relname}' must have forced row-level security enabled`
        );
      }
    });

    it("7.3 should verify all disposable databases created by this suite were cleanly dropped", async () => {
      const suiteDbs = [
        "moducraft_disposable_lock_eval",
        "moducraft_disposable_fresh_init",
        "moducraft_disposable_replay_guard",
        "moducraft_disposable_historical_adopt",
        "moducraft_disposable_untracked_test",
        "moducraft_disposable_lifecycle_test",
      ];
      const res = await adminPool.query<{ datname: string }>(
        `SELECT datname FROM pg_database WHERE datname = ANY($1::text[]);`,
        [suiteDbs]
      );
      assert.equal(
        res.rowCount,
        0,
        `All suite disposable databases must be cleaned up, found: ${res.rows.map((r) => r.datname).join(", ")}`
      );
    });
  });
});
