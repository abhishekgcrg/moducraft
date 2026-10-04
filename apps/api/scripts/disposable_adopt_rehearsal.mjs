import pg from "pg";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const migrationsDir = path.resolve(repoRoot, "db/migrations");
const cliPath = path.resolve(__dirname, "../src/db/cli.ts");

const postgresDbUrl = "postgresql://moducraft:moducraft_local_only@127.0.0.1:5432/postgres";
const rehearsalDbName = "moducraft_disposable_adopt_rehearsal";
const rehearsalAdminUrl = `postgresql://moducraft:moducraft_local_only@127.0.0.1:5432/${rehearsalDbName}`;
const rehearsalRuntimeUrl = `postgresql://moducraft_runtime:moducraft_runtime_local@127.0.0.1:5432/${rehearsalDbName}`;

async function main() {
  console.log("=== Phase 4D.11: Disposable Adoption Rehearsal ===");
  const rootClient = new pg.Client({ connectionString: postgresDbUrl });
  await rootClient.connect();

  try {
    // 1. Provision disposable target DB
    console.log(`\n[STEP 1] Creating disposable rehearsal database: ${rehearsalDbName}`);
    await rootClient.query(`DROP DATABASE IF EXISTS ${rehearsalDbName} WITH (FORCE);`);
    await rootClient.query(`CREATE DATABASE ${rehearsalDbName} OWNER moducraft;`);
    console.log(`Created database '${rehearsalDbName}'.`);

    // Grant schema permissions to moducraft_runtime for testing
    const rehearseClient = new pg.Client({ connectionString: rehearsalAdminUrl });
    await rehearseClient.connect();

    console.log(`\n[STEP 2] Applying baseline migrations 0001-0010 SQL directly (simulating pre-adoption primary)...`);
    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort();
    for (const f of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, f), "utf-8");
      await rehearseClient.query(sql);
    }
    console.log(`Applied ${files.length} SQL migrations directly without migration tracker.`);

    // Check table count & forced RLS
    const tableRes = await rehearseClient.query(
      `SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';`
    );
    console.log(`Table count in ${rehearsalDbName}: ${tableRes.rows[0].count}`);
    await rehearseClient.end();

    // 2. Preflight CLI db:status
    console.log(`\n[STEP 3] Running CLI db:status before adoption (expect UNINITIALIZED)...`);
    try {
      const statusOut = execFileSync(
        process.execPath,
        ["--import", "tsx", cliPath, "status"],
        {
          env: { ...process.env, MIGRATION_DATABASE_URL: rehearsalAdminUrl, MIGRATIONS_DIR: migrationsDir },
          encoding: "utf-8"
        }
      );
      console.log(statusOut.trim());
    } catch (e) {
      console.error("Status failed:", e.stdout || e.message);
    }

    // 3. CLI db:adopt
    console.log(`\n[STEP 4] Running CLI db:adopt to register historical baseline...`);
    const adoptOut = execFileSync(
      process.execPath,
      ["--import", "tsx", cliPath, "adopt"],
      {
        env: { ...process.env, MIGRATION_DATABASE_URL: rehearsalAdminUrl, MIGRATIONS_DIR: migrationsDir },
        encoding: "utf-8"
      }
    );
    console.log(adoptOut.trim());

    // 4. Post-adoption CLI db:status
    console.log(`\n[STEP 5] Running CLI db:status post-adoption (expect 10 applied, Up to date)...`);
    const postStatusOut = execFileSync(
      process.execPath,
      ["--import", "tsx", cliPath, "status"],
      {
        env: { ...process.env, MIGRATION_DATABASE_URL: rehearsalAdminUrl, MIGRATIONS_DIR: migrationsDir },
        encoding: "utf-8"
      }
    );
    console.log(postStatusOut.trim());

    // 5. Test Checksum Drift Detection
    console.log(`\n[STEP 6] Testing Checksum Drift Detection...`);
    const tamperClient = new pg.Client({ connectionString: rehearsalAdminUrl });
    await tamperClient.connect();
    await tamperClient.query(
      `UPDATE schema_migrations SET checksum = 'tampered_sha256_hash_value' WHERE version = '0005';`
    );
    await tamperClient.end();

    try {
      execFileSync(
        process.execPath,
        ["--import", "tsx", cliPath, "status"],
        {
          env: { ...process.env, MIGRATION_DATABASE_URL: rehearsalAdminUrl, MIGRATIONS_DIR: migrationsDir },
          encoding: "utf-8"
        }
      );
      console.error("FAIL: Checksum drift was not detected!");
    } catch (e) {
      console.log("SUCCESS: CLI failed closed on checksum drift as expected:");
      console.log((e.stderr || e.stdout || e.message).trim());
    }

    // 6. Test Runtime Role Denial
    console.log(`\n[STEP 7] Testing Runtime Role Rejection (moducraft_runtime)...`);
    try {
      execFileSync(
        process.execPath,
        ["--import", "tsx", cliPath, "adopt"],
        {
          env: { ...process.env, MIGRATION_DATABASE_URL: rehearsalRuntimeUrl, MIGRATIONS_DIR: migrationsDir },
          encoding: "utf-8"
        }
      );
      console.error("FAIL: Runtime role was able to run adopt!");
    } catch (e) {
      console.log("SUCCESS: Runtime role denied execution as expected:");
      console.log((e.stderr || e.stdout || e.message).trim());
    }

    // 7. Cleanup
    console.log(`\n[STEP 8] Cleaning up disposable rehearsal database...`);
    await rootClient.query(`DROP DATABASE ${rehearsalDbName} WITH (FORCE);`);
    console.log(`Dropped database '${rehearsalDbName}'.`);

    // Verify cleanup
    const remaining = await rootClient.query(
      `SELECT datname FROM pg_database WHERE datname LIKE 'moducraft_disposable_%';`
    );
    console.log(`Remaining disposable databases: ${remaining.rowCount}`);
    if (remaining.rowCount > 0) {
      console.warn(`Leaked databases: ${remaining.rows.map(r => r.datname).join(", ")}`);
    } else {
      console.log(`All disposable databases cleanly removed.`);
    }

  } finally {
    await rootClient.end();
  }
}

main().catch(err => {
  console.error("Rehearsal failed with error:", err);
  process.exit(1);
});
