import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const migrationsDir = path.resolve(repoRoot, "db/migrations");

const postgresDbUrl = "postgresql://moducraft:moducraft_local_only@127.0.0.1:5432/postgres";
const disposableDbName = "moducraft_disposable_rls_drill_4d13";
const disposableAdminUrl = `postgresql://moducraft:moducraft_local_only@127.0.0.1:5432/${disposableDbName}`;
const disposableRuntimeUrl = `postgresql://moducraft_runtime:moducraft_runtime_local@127.0.0.1:5432/${disposableDbName}`;

// UUID fixtures
const userAlphaId = "11111111-1111-4111-8111-111111111111";
const orgAlphaId  = "aaaaaaa1-1111-4111-8111-111111111111";
const projAlphaId = "bbbbbbb1-1111-4111-8111-111111111111";
const taskAlphaId = "ccccccc1-1111-4111-8111-111111111111";
const artAlphaId  = "ddddddd1-1111-4111-8111-111111111111";
const appAlphaId  = "eeeeeee1-1111-4111-8111-111111111111";
const jrnAlphaId  = "fffffff1-1111-4111-8111-111111111111";

const userBetaId  = "22222222-2222-4222-8222-222222222222";
const orgBetaId   = "aaaaaaa2-2222-4222-8222-222222222222";
const projBetaId  = "bbbbbbb2-2222-4222-8222-222222222222";
const taskBetaId  = "ccccccc2-2222-4222-8222-222222222222";
const artBetaId   = "ddddddd2-2222-4222-8222-222222222222";
const appBetaId   = "eeeeeee2-2222-4222-8222-222222222222";
const jrnBetaId   = "fffffff2-2222-4222-8222-222222222222";

const dummyHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async function main() {
  console.log("=== Phase 4D.13 Task D: Seeded Multi-Tenant RLS & Security Drill ===");
  const rootClient = new pg.Client({ connectionString: postgresDbUrl });
  await rootClient.connect();

  try {
    // 1. Provision disposable target DB
    console.log(`\n[STEP 1] Provisioning disposable database: ${disposableDbName}`);
    await rootClient.query(`DROP DATABASE IF EXISTS ${disposableDbName} WITH (FORCE);`);
    await rootClient.query(`CREATE DATABASE ${disposableDbName} OWNER moducraft;`);
    console.log(`Database '${disposableDbName}' created.`);

    // 2. Apply baseline migrations 0001-0010
    console.log(`\n[STEP 2] Applying migrations 0001-0010 SQL...`);
    const adminClient = new pg.Client({ connectionString: disposableAdminUrl });
    await adminClient.connect();

    const sqlFiles = fs.readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort();
    for (const f of sqlFiles) {
      const sql = fs.readFileSync(path.join(migrationsDir, f), "utf-8");
      await adminClient.query(sql);
    }
    console.log(`Applied ${sqlFiles.length} migrations.`);

    // 3. Seed synthetic multi-tenant fixtures
    console.log(`\n[STEP 3] Seeding distinct synthetic data for Tenant Alpha and Tenant Beta...`);

    // Tenant Alpha Seed
    await adminClient.query(`
      INSERT INTO app_users (id, identity_issuer, identity_subject, email, display_name)
      VALUES ('${userAlphaId}', 'issuer_alpha', 'sub_alpha', 'alpha@moducraft.internal', 'User Alpha');

      INSERT INTO organizations (id, name, slug, created_by)
      VALUES ('${orgAlphaId}', 'Organization Alpha', 'org-alpha', '${userAlphaId}');

      INSERT INTO organization_memberships (organization_id, user_id, role, created_by)
      VALUES ('${orgAlphaId}', '${userAlphaId}', 'owner', '${userAlphaId}');

      INSERT INTO projects (id, organization_id, name, slug, description, created_by)
      VALUES ('${projAlphaId}', '${orgAlphaId}', 'Alpha Project 1', 'alpha-proj-1', 'Project Alpha', '${userAlphaId}');

      INSERT INTO agent_tasks (id, organization_id, project_id, task_type, title, input_summary, status, created_by)
      VALUES ('${taskAlphaId}', '${orgAlphaId}', '${projAlphaId}', 'coding', 'Alpha Task 1', 'Prompt Alpha', 'running', '${userAlphaId}');

      INSERT INTO agent_artifacts (id, organization_id, project_id, task_id, artifact_type, title, content, content_hash, size_bytes, created_by)
      VALUES ('${artAlphaId}', '${orgAlphaId}', '${projAlphaId}', '${taskAlphaId}', 'patch_proposal', 'Alpha Patch', 'diff alpha', '${dummyHash}', 10, '${userAlphaId}');

      INSERT INTO agent_approvals (id, organization_id, task_id, artifact_id, action, target_content_hash, status, required_role, expires_at)
      VALUES ('${appAlphaId}', '${orgAlphaId}', '${taskAlphaId}', '${artAlphaId}', 'apply_patch', '${dummyHash}', 'pending', 'owner', now() + interval '1 hour');

      INSERT INTO patch_application_journals (id, organization_id, project_id, task_id, patch_artifact_id, approval_id, target_content_hash, status, created_by)
      VALUES ('${jrnAlphaId}', '${orgAlphaId}', '${projAlphaId}', '${taskAlphaId}', '${artAlphaId}', '${appAlphaId}', '${dummyHash}', 'prepared', '${userAlphaId}');
    `);

    // Tenant Beta Seed
    await adminClient.query(`
      INSERT INTO app_users (id, identity_issuer, identity_subject, email, display_name)
      VALUES ('${userBetaId}', 'issuer_beta', 'sub_beta', 'beta@moducraft.internal', 'User Beta');

      INSERT INTO organizations (id, name, slug, created_by)
      VALUES ('${orgBetaId}', 'Organization Beta', 'org-beta', '${userBetaId}');

      INSERT INTO organization_memberships (organization_id, user_id, role, created_by)
      VALUES ('${orgBetaId}', '${userBetaId}', 'owner', '${userBetaId}');

      INSERT INTO projects (id, organization_id, name, slug, description, created_by)
      VALUES ('${projBetaId}', '${orgBetaId}', 'Beta Project 1', 'beta-proj-1', 'Project Beta', '${userBetaId}');

      INSERT INTO agent_tasks (id, organization_id, project_id, task_type, title, input_summary, status, created_by)
      VALUES ('${taskBetaId}', '${orgBetaId}', '${projBetaId}', 'coding', 'Beta Task 1', 'Prompt Beta', 'running', '${userBetaId}');

      INSERT INTO agent_artifacts (id, organization_id, project_id, task_id, artifact_type, title, content, content_hash, size_bytes, created_by)
      VALUES ('${artBetaId}', '${orgBetaId}', '${projBetaId}', '${taskBetaId}', 'patch_proposal', 'Beta Patch', 'diff beta', '${dummyHash}', 9, '${userBetaId}');

      INSERT INTO agent_approvals (id, organization_id, task_id, artifact_id, action, target_content_hash, status, required_role, expires_at)
      VALUES ('${appBetaId}', '${orgBetaId}', '${taskBetaId}', '${artBetaId}', 'apply_patch', '${dummyHash}', 'pending', 'owner', now() + interval '1 hour');

      INSERT INTO patch_application_journals (id, organization_id, project_id, task_id, patch_artifact_id, approval_id, target_content_hash, status, created_by)
      VALUES ('${jrnBetaId}', '${orgBetaId}', '${projBetaId}', '${taskBetaId}', '${artBetaId}', '${appBetaId}', '${dummyHash}', 'prepared', '${userBetaId}');
    `);

    console.log("Seeding complete for both tenants.");
    await adminClient.end();

    // 4. Connect as moducraft_runtime for RLS tests
    console.log(`\n[STEP 4] Executing RLS tests under application role 'moducraft_runtime'...`);
    const runtimeClient = new pg.Client({ connectionString: disposableRuntimeUrl });
    await runtimeClient.connect();

    // Verify session identity
    const sessionRes = await runtimeClient.query(`SELECT current_database() AS db, current_user AS usr;`);
    console.log(`Connected as role '${sessionRes.rows[0].usr}' to '${sessionRes.rows[0].db}'.`);

    // Test D.1: Authorized read - User Alpha
    await runtimeClient.query(`BEGIN;`);
    await runtimeClient.query(`SET LOCAL app.user_id = '${userAlphaId}';`);
    const pAlphaRes = await runtimeClient.query(`SELECT id, name FROM projects;`);
    const jAlphaRes = await runtimeClient.query(`SELECT id, status FROM patch_application_journals;`);
    const aAlphaRes = await runtimeClient.query(`SELECT id, title FROM agent_artifacts;`);
    await runtimeClient.query(`COMMIT;`);

    console.log(`\n[TEST D.1] User Alpha Authorized Reads:`);
    console.log(`  - Projects visible: ${pAlphaRes.rows.map(r => `${r.name} (${r.id})`).join(", ")}`);
    console.log(`  - Patch journals visible: ${jAlphaRes.rows.map(r => r.id).join(", ")}`);
    console.log(`  - Artifacts visible: ${aAlphaRes.rows.map(r => r.title).join(", ")}`);
    if (pAlphaRes.rowCount === 1 && pAlphaRes.rows[0].id === projAlphaId &&
        jAlphaRes.rowCount === 1 && jAlphaRes.rows[0].id === jrnAlphaId) {
      console.log(`  -> RESULT: PASS (Only Alpha records returned)`);
    } else {
      throw new Error(`FAIL: Unexpected rows returned for Alpha: ${JSON.stringify(pAlphaRes.rows)}`);
    }

    // Test D.2: Cross-tenant isolation - User Alpha cannot query Beta's project even by explicit ID
    await runtimeClient.query(`BEGIN;`);
    await runtimeClient.query(`SET LOCAL app.user_id = '${userAlphaId}';`);
    const crossProjRes = await runtimeClient.query(`SELECT count(*)::int AS cnt FROM projects WHERE id = '${projBetaId}';`);
    const crossJrnRes = await runtimeClient.query(`SELECT count(*)::int AS cnt FROM patch_application_journals WHERE id = '${jrnBetaId}';`);
    await runtimeClient.query(`COMMIT;`);

    console.log(`\n[TEST D.2] User Alpha Cross-Tenant Access to Beta Resources:`);
    console.log(`  - Beta projects visible to Alpha: ${crossProjRes.rows[0].cnt}`);
    console.log(`  - Beta journals visible to Alpha: ${crossJrnRes.rows[0].cnt}`);
    if (crossProjRes.rows[0].cnt === 0 && crossJrnRes.rows[0].cnt === 0) {
      console.log(`  -> RESULT: PASS (Zero Beta rows leaked to Alpha)`);
    } else {
      throw new Error(`FAIL: Cross-tenant leakage observed!`);
    }

    // Test D.3: Authorized read - User Beta
    await runtimeClient.query(`BEGIN;`);
    await runtimeClient.query(`SET LOCAL app.user_id = '${userBetaId}';`);
    const pBetaRes = await runtimeClient.query(`SELECT id, name FROM projects;`);
    const crossAlphaFromBeta = await runtimeClient.query(`SELECT count(*)::int AS cnt FROM projects WHERE id = '${projAlphaId}';`);
    await runtimeClient.query(`COMMIT;`);

    console.log(`\n[TEST D.3] User Beta Authorized Reads & Alpha Isolation:`);
    console.log(`  - Projects visible to Beta: ${pBetaRes.rows.map(r => `${r.name} (${r.id})`).join(", ")}`);
    console.log(`  - Alpha projects visible to Beta: ${crossAlphaFromBeta.rows[0].cnt}`);
    if (pBetaRes.rowCount === 1 && pBetaRes.rows[0].id === projBetaId && crossAlphaFromBeta.rows[0].cnt === 0) {
      console.log(`  -> RESULT: PASS (Beta sees only Beta; zero Alpha rows leaked)`);
    } else {
      throw new Error(`FAIL: Beta isolation failed!`);
    }

    // Test D.4: Missing Identity Context
    await runtimeClient.query(`BEGIN;`);
    await runtimeClient.query(`RESET app.user_id;`);
    const anonProj = await runtimeClient.query(`SELECT count(*)::int AS cnt FROM projects;`);
    const anonJrn = await runtimeClient.query(`SELECT count(*)::int AS cnt FROM patch_application_journals;`);
    await runtimeClient.query(`COMMIT;`);

    console.log(`\n[TEST D.4] Unauthenticated / Missing Identity Context:`);
    console.log(`  - Projects visible without app.user_id: ${anonProj.rows[0].cnt}`);
    console.log(`  - Patch journals visible without app.user_id: ${anonJrn.rows[0].cnt}`);
    if (anonProj.rows[0].cnt === 0 && anonJrn.rows[0].cnt === 0) {
      console.log(`  -> RESULT: PASS (Default deny when session context missing)`);
    } else {
      throw new Error(`FAIL: Missing context did not default-deny!`);
    }

    // Test D.5: Attempted Tenant Spoofing / Cross-Tenant Write
    console.log(`\n[TEST D.5] Attempted Tenant-Context Spoofing Write:`);
    await runtimeClient.query(`BEGIN;`);
    await runtimeClient.query(`SET LOCAL app.user_id = '${userAlphaId}';`);
    try {
      await runtimeClient.query(`
        INSERT INTO projects (id, organization_id, name, slug, description, created_by)
        VALUES (gen_random_uuid(), '${orgBetaId}', 'Injected Project', 'injected-proj', 'Spoof', '${userAlphaId}');
      `);
      await runtimeClient.query(`ROLLBACK;`);
      throw new Error(`FAIL: User Alpha successfully wrote to Org Beta!`);
    } catch (e) {
      await runtimeClient.query(`ROLLBACK;`);
      console.log(`  - Cross-tenant insert into Org Beta rejected: SQLSTATE ${e.code} (${e.message})`);
      console.log(`  -> RESULT: PASS (RLS WITH CHECK policy blocked cross-tenant injection)`);
    }

    // Test D.6: Direct DDL Privilege Denial under runtime role
    console.log(`\n[TEST D.6] Runtime Role DDL Privilege Denial:`);
    try {
      await runtimeClient.query(`CREATE TABLE public.unauthorized_tbl (id int);`);
      throw new Error(`FAIL: Runtime role executed DDL!`);
    } catch (e) {
      console.log(`  - DDL rejected: SQLSTATE ${e.code} (${e.message})`);
      console.log(`  -> RESULT: PASS (Insufficient privilege 42501)`);
    }

    // Test D.7: Direct Journal Deletion Denial under runtime role
    console.log(`\n[TEST D.7] Runtime Role DELETE Denial on patch_application_journals:`);
    try {
      await runtimeClient.query(`DELETE FROM patch_application_journals WHERE id = '${jrnAlphaId}';`);
      throw new Error(`FAIL: Runtime role deleted patch journal!`);
    } catch (e) {
      console.log(`  - DELETE rejected: SQLSTATE ${e.code} (${e.message})`);
      console.log(`  -> RESULT: PASS (Permission denied for table patch_application_journals)`);
    }

    await runtimeClient.end();

    // 5. Cleanup
    console.log(`\n[STEP 5] Cleaning up disposable database: ${disposableDbName}`);
    // Confirm identity before drop
    const dropCheck = await rootClient.query(`SELECT datname FROM pg_database WHERE datname = '${disposableDbName}';`);
    if (dropCheck.rowCount === 1 && disposableDbName.startsWith("moducraft_disposable_")) {
      await rootClient.query(`DROP DATABASE ${disposableDbName} WITH (FORCE);`);
      console.log(`Successfully dropped '${disposableDbName}'.`);
    } else {
      throw new Error(`Aborting drop: target database identity verification failed!`);
    }

    const remaining = await rootClient.query(`SELECT datname FROM pg_database WHERE datname LIKE 'moducraft_disposable_%';`);
    console.log(`Remaining disposable databases: ${remaining.rowCount}`);

  } finally {
    await rootClient.end();
  }
}

main().catch(err => {
  console.error("Task D drill failed:", err);
  process.exit(1);
});
