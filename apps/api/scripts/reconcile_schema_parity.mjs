import pg from "pg";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const postgresDbUrl = "postgresql://moducraft:moducraft_local_only@127.0.0.1:5432/postgres";
const primaryDbUrl = "postgresql://moducraft:moducraft_local_only@127.0.0.1:5432/moducraft";
const parityDbName = "moducraft_disposable_parity_drill_4d13";
const parityDbUrl = `postgresql://moducraft:moducraft_local_only@127.0.0.1:5432/${parityDbName}`;

const dumpFile = "/tmp/moducraft_parity_4d13.dump";

async function getCatalog(client) {
  // 1. Tables & Columns
  const cols = await client.query(`
    SELECT table_name, column_name, ordinal_position, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position;
  `);

  // 2. Constraints from pg_constraint
  const constrs = await client.query(`
    SELECT c.conname, c.contype, cl.relname AS table_name, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = 'public'
    ORDER BY cl.relname, c.conname;
  `);

  // 3. Indexes
  const idxs = await client.query(`
    SELECT tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
    ORDER BY tablename, indexname;
  `);

  // 4. RLS flags and policies
  const rlsFlags = await client.query(`
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname;
  `);

  const policies = await client.query(`
    SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
    ORDER BY tablename, policyname;
  `);

  // 5. Functions
  const funcs = await client.query(`
    SELECT routine_name, routine_type, data_type
    FROM information_schema.routines
    WHERE routine_schema = 'public'
    ORDER BY routine_name;
  `);

  // 6. User Triggers
  const triggers = await client.query(`
    SELECT tgname, relname, pg_get_triggerdef(t.oid) AS def
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT tgisinternal
    ORDER BY relname, tgname;
  `);

  // 7. Extensions
  const exts = await client.query(`
    SELECT extname, extversion
    FROM pg_extension
    WHERE extname NOT IN ('plpgsql')
    ORDER BY extname;
  `);

  // 8. Grants for moducraft_runtime
  const grants = await client.query(`
    SELECT table_name, privilege_type
    FROM information_schema.table_privileges
    WHERE table_schema = 'public' AND grantee = 'moducraft_runtime'
    ORDER BY table_name, privilege_type;
  `);

  // 9. Tracking Table
  const tracking = await client.query(`
    SELECT to_regclass('public.schema_migrations') IS NOT NULL AS has_tracking;
  `);

  return {
    columns: cols.rows,
    constraints: constrs.rows,
    indexes: idxs.rows,
    rlsFlags: rlsFlags.rows,
    policies: policies.rows,
    functions: funcs.rows,
    triggers: triggers.rows,
    extensions: exts.rows,
    grants: grants.rows,
    hasTracking: tracking.rows[0]?.has_tracking ?? false
  };
}

async function main() {
  console.log("=== Phase 4D.13 Task E: Deep Backup Restoration & Schema Parity Verification ===");
  const rootClient = new pg.Client({ connectionString: postgresDbUrl });
  await rootClient.connect();

  try {
    // 1. Capture dump of primary
    console.log("[STEP 1] Generating custom-format backup from primary...");
    execFileSync("docker", ["exec", "moducraft-postgres", "pg_dump", "-U", "moducraft", "-Fc", "-d", "moducraft", "-f", dumpFile]);
    console.log("pg_dump complete.");

    // 2. Provision parity database
    console.log(`[STEP 2] Provisioning disposable parity target: ${parityDbName}`);
    await rootClient.query(`DROP DATABASE IF EXISTS ${parityDbName} WITH (FORCE);`);
    await rootClient.query(`CREATE DATABASE ${parityDbName} OWNER moducraft;`);
    console.log("Created target database.");

    // 3. Restore dump
    console.log("[STEP 3] Restoring backup archive into parity database...");
    execFileSync("docker", ["exec", "moducraft-postgres", "pg_restore", "-U", "moducraft", "-d", parityDbName, dumpFile]);
    console.log("pg_restore complete.");

    // 4. Query both databases
    console.log("[STEP 4] Collecting deep catalog state from Primary and Restored databases...");
    const primaryClient = new pg.Client({ connectionString: primaryDbUrl });
    const restoredClient = new pg.Client({ connectionString: parityDbUrl });
    await primaryClient.connect();
    await restoredClient.connect();

    const primaryCat = await getCatalog(primaryClient);
    const restoredCat = await getCatalog(restoredClient);

    await primaryClient.end();
    await restoredClient.end();

    // 5. Compare each dimension
    console.log("\n[STEP 5] Comparing Catalog Dimensions:");
    
    // Columns
    const colsDiff = JSON.stringify(primaryCat.columns) === JSON.stringify(restoredCat.columns);
    console.log(`  - Columns (${primaryCat.columns.length} items): ${colsDiff ? "EXACT MATCH (0 diff)" : "MISMATCH"}`);

    // Constraints
    const constrsDiff = JSON.stringify(primaryCat.constraints) === JSON.stringify(restoredCat.constraints);
    console.log(`  - Constraints (${primaryCat.constraints.length} items): ${constrsDiff ? "EXACT MATCH (0 diff)" : "MISMATCH"}`);

    // Indexes
    const idxDiff = JSON.stringify(primaryCat.indexes) === JSON.stringify(restoredCat.indexes);
    console.log(`  - Indexes (${primaryCat.indexes.length} items): ${idxDiff ? "EXACT MATCH (0 diff)" : "MISMATCH"}`);

    // RLS Flags
    const rlsFlagsDiff = JSON.stringify(primaryCat.rlsFlags) === JSON.stringify(restoredCat.rlsFlags);
    console.log(`  - RLS Flags (${primaryCat.rlsFlags.length} tables): ${rlsFlagsDiff ? "EXACT MATCH (0 diff)" : "MISMATCH"}`);

    // RLS Policies
    const policiesDiff = JSON.stringify(primaryCat.policies) === JSON.stringify(restoredCat.policies);
    console.log(`  - RLS Policies (${primaryCat.policies.length} items): ${policiesDiff ? "EXACT MATCH (0 diff)" : "MISMATCH"}`);

    // Functions
    const funcsDiff = JSON.stringify(primaryCat.functions) === JSON.stringify(restoredCat.functions);
    console.log(`  - Functions (${primaryCat.functions.length} items): ${funcsDiff ? "EXACT MATCH (0 diff)" : "MISMATCH"}`);

    // Triggers
    const triggersDiff = JSON.stringify(primaryCat.triggers) === JSON.stringify(restoredCat.triggers);
    console.log(`  - Triggers (${primaryCat.triggers.length} user triggers): ${triggersDiff ? "EXACT MATCH (0 diff)" : "MISMATCH"}`);

    // Extensions
    const extsDiff = JSON.stringify(primaryCat.extensions) === JSON.stringify(restoredCat.extensions);
    console.log(`  - Extensions (${primaryCat.extensions.length} items): ${extsDiff ? "EXACT MATCH (0 diff)" : "MISMATCH"}`);

    // Table Grants
    const grantsDiff = JSON.stringify(primaryCat.grants) === JSON.stringify(restoredCat.grants);
    console.log(`  - Grants (${primaryCat.grants.length} privileges): ${grantsDiff ? "EXACT MATCH (0 diff)" : "MISMATCH"}`);

    // Tracking table
    console.log(`  - Tracking table (schema_migrations): Primary=${primaryCat.hasTracking}, Restored=${restoredCat.hasTracking}`);

    const allMatched = colsDiff && constrsDiff && idxDiff && rlsFlagsDiff && policiesDiff && funcsDiff && triggersDiff && extsDiff && grantsDiff && (primaryCat.hasTracking === restoredCat.hasTracking);
    console.log(`\nOverall Parity Assessment: ${allMatched ? "100% IDENTICAL CATALOG PARITY" : "PARITY DEVIATION DETECTED"}`);

    // 6. Cleanup
    console.log(`\n[STEP 6] Cleaning up disposable database: ${parityDbName}`);
    await rootClient.query(`DROP DATABASE ${parityDbName} WITH (FORCE);`);
    console.log(`Dropped '${parityDbName}'.`);

    execFileSync("docker", ["exec", "moducraft-postgres", "rm", "-f", dumpFile]);
    console.log("Removed dump file.");

    const remaining = await rootClient.query(`SELECT datname FROM pg_database WHERE datname LIKE 'moducraft_disposable_%';`);
    console.log(`Remaining disposable databases: ${remaining.rowCount}`);

  } finally {
    await rootClient.end();
  }
}

main().catch(err => {
  console.error("Task E parity drill failed:", err);
  process.exit(1);
});
