#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  MigrationManager,
  MigrationChecksumDriftError,
  MigrationInterruptedError,
  MigrationLockConflictError,
  MigrationAdoptionError,
  MigrationPermissionError,
  UntrackedSchemaMigrationError,
} from "./migration-manager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const command = process.argv[2] || "status";
const migrationsDir =
  process.env.MIGRATIONS_DIR ||
  path.resolve(__dirname, "../../../../db/migrations");

import {
  resolveAndValidateMigrationTarget,
  MigrationTargetValidationError,
} from "./migration-target.js";

async function run() {
  let target;
  try {
    target = resolveAndValidateMigrationTarget(undefined, command, process.env);
  } catch (err: any) {
    console.error(`\n${err.message}`);
    process.exitCode = 1;
    return;
  }

  const client = new pg.Client({ connectionString: target.databaseUrl });
  const manager = new MigrationManager();

  try {
    await client.connect();

    const sessionRes = await client.query<{ current_database: string; current_user: string }>(
      `SELECT current_database(), current_user;`
    );
    const dbName = sessionRes.rows[0]?.current_database ?? "unknown";
    const currentUser = sessionRes.rows[0]?.current_user ?? "unknown";
    console.log(`[ModuCraft Migration CLI] Connected to database '${dbName}' as role '${currentUser}'`);

    switch (command) {
      case "status": {
        console.log(`[ModuCraft Migration CLI] Checking status against database...`);
        const tableCheck = await client.query<{ exists: boolean }>(
          `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists;`
        );
        const hasTable = tableCheck.rows[0]?.exists ?? false;
        if (!hasTable) {
          console.log(`\n[UNINITIALIZED] Tracking table 'public.schema_migrations' does not exist yet.`);
          console.log(`Database has not been baseline-adopted or migrated via MigrationManager.`);
          console.log(`To adopt existing verified migrations 0001-0010 without data loss, run 'db:adopt'.`);
          break;
        }

        const applied = await manager.getAppliedMigrations(client);
        const plan = await manager.planMigrations(migrationsDir, applied);

        console.log(`\n--- Applied Migrations (${applied.size}) ---`);
        for (const [ver, record] of applied.entries()) {
          console.log(
            `  [${record.status.toUpperCase()}] ${ver}: ${record.name} (${record.executionTimeMs}ms at ${record.appliedAt})`
          );
        }

        console.log(`\n--- Pending Migrations (${plan.pendingFiles.length}) ---`);
        for (const pending of plan.pendingFiles) {
          console.log(`  [PENDING] ${pending}`);
        }

        console.log(`\nStatus: ${plan.pendingFiles.length === 0 ? "Up to date." : "Migrations pending."}`);
        break;
      }

      case "migrate": {
        console.log(`[ModuCraft Migration CLI] Executing pending migrations with advisory lock...`);
        const result = await manager.migrate(client, migrationsDir);
        if (result.applied.length === 0) {
          console.log(`[ModuCraft Migration CLI] No pending migrations to apply.`);
        } else {
          console.log(`[ModuCraft Migration CLI] Successfully applied ${result.applied.length} migration(s):`);
          for (const m of result.applied) {
            console.log(`  ✓ ${m.version}: ${m.name} (${m.executionTimeMs}ms) [${m.checksum.slice(0, 12)}...]`);
          }
        }
        break;
      }

      case "adopt": {
        console.log(`[ModuCraft Migration CLI] Running historical baseline verification & adoption...`);
        const result = await manager.adoptHistoricalBaseline(client, migrationsDir, "0010");
        console.log(
          `[ModuCraft Migration CLI] Baseline adoption complete: ` +
          `${result.adopted.length} adopted, ${result.skipped.length} skipped/already recorded.`
        );
        for (const m of result.adopted) {
          console.log(`  ✓ Adopted ${m.version}: ${m.name} [Verified Schema Milestone]`);
        }
        break;
      }

      default:
        console.error(`Unknown command '${command}'. Supported: 'status', 'migrate', 'adopt'.`);
        process.exitCode = 1;
    }
  } catch (err: any) {
    const rawMsg = err?.message || String(err);
    const safeMsg = rawMsg.replace(/postgres(?:ql)?:\/\/[^\s@]+@[^\s/]+/gi, "postgresql://***:***@***");

    if (err instanceof UntrackedSchemaMigrationError) {
      console.error(`\n[UNTRACKED SCHEMA] ${safeMsg}`);
    } else if (err instanceof MigrationLockConflictError) {
      console.error(`\n[LOCK CONFLICT] ${safeMsg}`);
    } else if (err instanceof MigrationChecksumDriftError) {
      console.error(`\n[CHECKSUM DRIFT] ${safeMsg}`);
    } else if (err instanceof MigrationInterruptedError) {
      console.error(`\n[INTERRUPTED MIGRATION] ${safeMsg}`);
    } else if (err instanceof MigrationAdoptionError) {
      console.error(`\n[ADOPTION ERROR] ${safeMsg}`);
    } else if (err instanceof MigrationPermissionError) {
      console.error(`\n[PERMISSION DENIED] ${safeMsg}`);
    } else {
      console.error(`\n[MIGRATION ERROR] ${safeMsg}`);
    }
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

run();
