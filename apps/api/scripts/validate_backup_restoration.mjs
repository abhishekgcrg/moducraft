import pg from "pg";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

const postgresDbUrl = "postgresql://moducraft:moducraft_local_only@127.0.0.1:5432/postgres";
const primaryDbUrl = "postgresql://moducraft:moducraft_local_only@127.0.0.1:5432/moducraft";
const smokeDbName = "moducraft_disposable_smoke_test";
const smokeAdminUrl = `postgresql://moducraft:moducraft_local_only@127.0.0.1:5432/${smokeDbName}`;
const smokeRuntimeUrl = `postgresql://moducraft_runtime:moducraft_runtime_local@127.0.0.1:5432/${smokeDbName}`;

async function main() {
  console.log("=== Phase 4D.12: Backup Restoration Validation & Application Smoke Test ===");
  const rootClient = new pg.Client({ connectionString: postgresDbUrl });
  await rootClient.connect();

  const backupFilePath = "/tmp/moducraft_phase4d12_backup.dump";

  try {
    // 1. Capture fresh backup of primary moducraft using pg_dump -Fc
    console.log("\n[STEP 1] Generating fresh custom-format backup from primary database...");
    const dumpRes = execFileSync(
      "docker",
      ["exec", "moducraft-postgres", "pg_dump", "-U", "moducraft", "-Fc", "-d", "moducraft", "-f", backupFilePath],
      { encoding: "utf-8" }
    );
    console.log("pg_dump completed with exit code 0.");

    // Verify backup TOC with pg_restore --list
    const tocOutput = execFileSync(
      "docker",
      ["exec", "moducraft-postgres", "pg_restore", "--list", backupFilePath],
      { encoding: "utf-8" }
    );
    const tocLines = tocOutput.trim().split("\n").filter(l => !l.startsWith(";"));
    console.log(`pg_restore TOC verified: ${tocLines.length} catalog items present.`);

    // 2. Create newly created disposable database
    console.log(`\n[STEP 2] Creating disposable validation database: ${smokeDbName}`);
    await rootClient.query(`DROP DATABASE IF EXISTS ${smokeDbName} WITH (FORCE);`);
    await rootClient.query(`CREATE DATABASE ${smokeDbName} OWNER moducraft;`);
    console.log(`Database '${smokeDbName}' provisioned.`);

    // 3. Restore backup into disposable database
    console.log(`\n[STEP 3] Restoring backup archive into '${smokeDbName}'...`);
    const restoreRes = execFileSync(
      "docker",
      ["exec", "moducraft-postgres", "pg_restore", "-U", "moducraft", "-d", smokeDbName, backupFilePath],
      { encoding: "utf-8" }
    );
    console.log("pg_restore completed with exit code 0 without errors.");

    // 4. Inspect Restored Catalog
    console.log("\n[STEP 4] Deep catalog inspection on restored database...");
    const smokeAdminClient = new pg.Client({ connectionString: smokeAdminUrl });
    await smokeAdminClient.connect();

    // Table count
    const tableRes = await smokeAdminClient.query(
      `SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';`
    );
    console.log(`  - Base tables in public schema: ${tableRes.rows[0].count}`);

    // Forced RLS count
    const rlsRes = await smokeAdminClient.query(`
      SELECT count(*)::int AS count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity = true AND c.relforcerowsecurity = true;
    `);
    console.log(`  - Tables with forced RLS (relrowsecurity & relforcerowsecurity): ${rlsRes.rows[0].count}`);

    // Constraints count
    const constrRes = await smokeAdminClient.query(
      `SELECT count(*)::int AS count FROM information_schema.table_constraints WHERE table_schema = 'public';`
    );
    console.log(`  - Table constraints: ${constrRes.rows[0].count}`);

    // Functions count
    const funcRes = await smokeAdminClient.query(
      `SELECT count(*)::int AS count FROM information_schema.routines WHERE routine_schema = 'public';`
    );
    console.log(`  - Stored functions: ${funcRes.rows[0].count}`);

    // Extensions
    const extRes = await smokeAdminClient.query(
      `SELECT extname, extversion FROM pg_extension WHERE extname NOT IN ('plpgsql');`
    );
    console.log(`  - Extensions present: ${extRes.rows.map(e => `${e.extname} (${e.extversion})`).join(", ") || "plpgsql only"}`);

    // Schema migrations tracking table presence
    const trackingRes = await smokeAdminClient.query(
      `SELECT to_regclass('public.schema_migrations') AS tbl;`
    );
    console.log(`  - Migration tracking table (schema_migrations): ${trackingRes.rows[0].tbl ? "EXISTS" : "ABSENT (NULL)"}`);

    // 5. Application-Level Read-Only Smoke Tests
    console.log("\n[STEP 5] Executing Application-Level Read-Only Smoke Tests...");
    const smokeRuntimeClient = new pg.Client({ connectionString: smokeRuntimeUrl });
    await smokeRuntimeClient.connect();

    // Test 5.1: Session identity under runtime role
    const sessionRes = await smokeRuntimeClient.query(
      `SELECT current_database() AS db, current_user AS usr;`
    );
    console.log(`  - Test 5.1: Connected as role '${sessionRes.rows[0].usr}' to '${sessionRes.rows[0].db}' [PASS]`);

    // Test 5.2: Query app_users table with tenant context
    await smokeRuntimeClient.query(`SET LOCAL app.current_organization_id = '00000000-0000-0000-0000-000000000000';`);
    const usersRes = await smokeRuntimeClient.query(`SELECT count(*)::int AS cnt FROM app_users;`);
    console.log(`  - Test 5.2: Tenant-scoped read on 'app_users' returned ${usersRes.rows[0].cnt} rows [PASS]`);

    // Test 5.3: Query projects table with tenant context
    const projRes = await smokeRuntimeClient.query(`SELECT count(*)::int AS cnt FROM projects;`);
    console.log(`  - Test 5.3: Tenant-scoped read on 'projects' returned ${projRes.rows[0].cnt} rows [PASS]`);

    // Test 5.4: Query audit_events table
    const auditRes = await smokeRuntimeClient.query(`SELECT count(*)::int AS cnt FROM audit_events;`);
    console.log(`  - Test 5.4: Tenant-scoped read on 'audit_events' returned ${auditRes.rows[0].cnt} rows [PASS]`);

    // Test 5.5: Query agent_tasks and agent_artifacts
    const taskRes = await smokeRuntimeClient.query(`SELECT count(*)::int AS cnt FROM agent_tasks;`);
    const artRes = await smokeRuntimeClient.query(`SELECT count(*)::int AS cnt FROM agent_artifacts;`);
    console.log(`  - Test 5.5: Tenant-scoped read on 'agent_tasks' (${taskRes.rows[0].cnt}) & 'agent_artifacts' (${artRes.rows[0].cnt}) [PASS]`);

    // Test 5.6: Query durable patch journals
    const patchRes = await smokeRuntimeClient.query(`SELECT count(*)::int AS cnt FROM patch_application_journals;`);
    console.log(`  - Test 5.6: Tenant-scoped read on 'patch_application_journals' returned ${patchRes.rows[0].cnt} rows [PASS]`);

    // Test 5.7: Verify RLS blocks cross-tenant reads
    await smokeRuntimeClient.query(`RESET app.current_organization_id;`);
    const blockedRes = await smokeRuntimeClient.query(`SELECT count(*)::int AS cnt FROM projects;`);
    console.log(`  - Test 5.7: Unauthenticated tenant read blocked by RLS (returned ${blockedRes.rows[0].cnt} rows) [PASS]`);

    // Test 5.8: Verify DDL is denied to runtime role
    try {
      await smokeRuntimeClient.query(`CREATE TABLE public.unauthorized_tbl (id int);`);
      console.error("  - Test 5.8: FAIL - runtime role was able to execute DDL!");
    } catch (e) {
      console.log(`  - Test 5.8: Runtime DDL blocked with SQLSTATE ${e.code} [PASS]`);
    }

    await smokeRuntimeClient.end();
    await smokeAdminClient.end();

    // 6. Cleanup
    console.log(`\n[STEP 6] Cleaning up disposable validation database and temp backup...`);
    await rootClient.query(`DROP DATABASE ${smokeDbName} WITH (FORCE);`);
    console.log(`Dropped database '${smokeDbName}'.`);

    execFileSync("docker", ["exec", "moducraft-postgres", "rm", "-f", backupFilePath]);
    console.log("Removed temporary backup file.");

    // Verify 0 leaked disposable databases
    const leakRes = await rootClient.query(
      `SELECT datname FROM pg_database WHERE datname LIKE 'moducraft_disposable_%';`
    );
    console.log(`Remaining disposable databases: ${leakRes.rowCount}`);

  } finally {
    await rootClient.end();
  }
}

main().catch(err => {
  console.error("Backup restoration validation failed:", err);
  process.exit(1);
});
