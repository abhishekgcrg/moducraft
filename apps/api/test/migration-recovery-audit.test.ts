import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { createDatabasePool } from "../src/db/pool.js";
import { withAuthenticatedContext } from "../src/db/transaction.js";
import {
  getTestDatabaseUrls,
  getDisposableDatabaseUrl,
  getAdminRootDatabaseUrl,
} from "./helpers/test-db-guard.js";
import { ApprovedPatchService } from "../src/modules/workflows/patch.service.js";
import { ApprovalsService } from "../src/modules/workflows/approvals.service.js";
import { ArtifactsService } from "../src/modules/workflows/artifacts.service.js";
import { MockWorkspaceRunner } from "../src/modules/workflows/tools/sandbox.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../src/errors/app-errors.js";
import { redactSensitiveData } from "../src/modules/memory/redactor.js";
import type { IsolatedWorkspaceRunner, PatchApplicationJournalDto } from "../src/modules/workflows/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Phase 4D.6: Migration Integrity, Recovery Authorization & Sensitive Journal Audit Test Suite
 *
 * Covers:
 * 1. Disposable database migration replay and transactional DDL rollback
 * 2. Cross-tenant recovery rejection under real moducraft_runtime role and forced RLS
 * 3. Administrative recovery authorization and refusal to overwrite divergent user edits
 * 4. Sensitive credential redaction in recovery_details and unbounded payload bounding
 * 5. Immutable artifact hash verification and check-constraint state tampering protection
 * 6. Primary database protection and forced RLS preservation on all 16 public tables
 */
describe("Phase 4D.6: Migration Integrity, Recovery Authorization & Sensitive Journal Audit", () => {
  const { runtimeDbUrl, superuserDbUrl: adminDbUrl } = getTestDatabaseUrls();

  // Dedicated test UUIDs for Phase 4D.6
  const orgAlphaId = "ffffffff-4d60-4000-8000-000000000001";
  const orgBetaId = "ffffffff-4d60-4000-8000-000000000002";
  const userAdminId = "ffffffff-4d60-4000-8000-000000000010"; // Alpha Admin
  const userMemberId = "ffffffff-4d60-4000-8000-000000000011"; // Alpha Member
  const userBetaId = "ffffffff-4d60-4000-8000-000000000020"; // Beta Admin

  const projAlphaId = "ffffffff-4d60-4000-8000-000000000100";
  const taskAlphaId = "ffffffff-4d60-4000-8000-000000000200";

  let adminPool: pg.Pool;
  let runtimePool: pg.Pool;
  let patchService: ApprovedPatchService;
  let approvalsService: ApprovalsService;
  let artifactsService: ArtifactsService;
  let testWorkspaceRunner: MockWorkspaceRunner;

  before(async () => {
    adminPool = createDatabasePool(adminDbUrl);
    runtimePool = createDatabasePool(runtimeDbUrl);
    testWorkspaceRunner = new MockWorkspaceRunner();
    approvalsService = new ApprovalsService();
    artifactsService = new ArtifactsService();
    patchService = new ApprovedPatchService(approvalsService, artifactsService, testWorkspaceRunner);

    // Seed test users
    await adminPool.query(
      `
      INSERT INTO app_users(id, identity_issuer, identity_subject, email, display_name)
      VALUES 
        ($1, 'https://auth.moducraft.test', 'sub-4d6-admin', 'audit_alpha_admin@moducraft.test', 'Audit Alpha Admin'),
        ($2, 'https://auth.moducraft.test', 'sub-4d6-member', 'audit_alpha_member@moducraft.test', 'Audit Alpha Member'),
        ($3, 'https://auth.moducraft.test', 'sub-4d6-beta', 'audit_beta_admin@moducraft.test', 'Audit Beta Admin')
      ON CONFLICT (id) DO NOTHING;
      `,
      [userAdminId, userMemberId, userBetaId]
    );

    // Seed test organizations
    await adminPool.query(
      `
      INSERT INTO organizations(id, name, slug, created_by)
      VALUES 
        ($1, 'Audit Org Alpha', 'audit-org-alpha', $3),
        ($2, 'Audit Org Beta', 'audit-org-beta', $4)
      ON CONFLICT (id) DO NOTHING;
      `,
      [orgAlphaId, orgBetaId, userAdminId, userBetaId]
    );

    // Seed memberships
    await adminPool.query(
      `
      INSERT INTO organization_memberships(organization_id, user_id, role)
      VALUES 
        ($1, $2, 'admin'),
        ($1, $3, 'member'),
        ($4, $5, 'admin')
      ON CONFLICT (organization_id, user_id) DO NOTHING;
      `,
      [orgAlphaId, userAdminId, userMemberId, orgBetaId, userBetaId]
    );

    // Seed project
    await adminPool.query(
      `
      INSERT INTO projects(id, organization_id, name, slug, description, created_by)
      VALUES ($1, $2, 'Audit Test Project', 'audit-test-project', 'Project for migration & recovery audit', $3)
      ON CONFLICT (id) DO NOTHING;
      `,
      [projAlphaId, orgAlphaId, userAdminId]
    );

    // Seed task
    await adminPool.query(
      `
      INSERT INTO agent_tasks(id, organization_id, project_id, title, task_type, status, created_by, input_data)
      VALUES ($1, $2, $3, 'Audit Test Task', 'workflow', 'running', $4, '{"audit": true}'::jsonb)
      ON CONFLICT (id) DO NOTHING;
      `,
      [taskAlphaId, orgAlphaId, projAlphaId, userAdminId]
    );
  });

  beforeEach(async () => {
    // Strictly isolate test rows by organization_id
    if (adminPool) {
      await adminPool.query(`DELETE FROM patch_application_journals WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM agent_approvals WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM agent_artifacts WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`UPDATE agent_tasks SET status = 'running' WHERE id = $1;`, [taskAlphaId]);
    }
  });

  after(async () => {
    // Strictly isolate cleanup to test-specific UUIDs; never drop or truncate primary tables
    if (adminPool) {
      await adminPool.query(`DELETE FROM patch_application_journals WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM agent_approvals WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM agent_artifacts WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM agent_tasks WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM projects WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM organization_memberships WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM organizations WHERE id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM app_users WHERE id IN ($1, $2, $3);`, [userAdminId, userMemberId, userBetaId]);
      await adminPool.end();
    }
    if (runtimePool) {
      await runtimePool.end();
    }
  });

  async function setupPatchScenario(
    tx: any,
    filename: string,
    originalContent: string,
    patchedContent: string
  ) {
    testWorkspaceRunner.setFile(projAlphaId, filename, originalContent);

    const diff =
      `--- a/${filename}\n` +
      `+++ b/${filename}\n` +
      `@@ -1,1 +1,1 @@\n` +
      `-${originalContent}` +
      `+${patchedContent}`;

    const contentHash = crypto.createHash("sha256").update(diff, "utf-8").digest("hex");

    const artifact = await artifactsService.createArtifact(tx, userAdminId, orgAlphaId, {
      projectId: projAlphaId,
      taskId: taskAlphaId,
      artifactType: "patch_proposal",
      title: `Audit patch for ${filename}`,
      content: diff,
      metadata: { targetFiles: [filename] },
    });

    const approval = await approvalsService.createApprovalRequest(tx, orgAlphaId, {
      taskId: taskAlphaId,
      artifactId: artifact.id,
      action: "apply_patch",
      targetContentHash: contentHash,
      requiredRole: "admin",
      expiresInSeconds: 3600,
    });

    await approvalsService.decideApproval(tx, approval.id, userAdminId, orgAlphaId, {
      decision: "approved",
    });

    return { artifact, approval, contentHash, diff };
  }

  // ===========================================================================
  // 1. Disposable Database Migration Replay & DDL Atomicity (Real DB Integration)
  // ===========================================================================
  describe("1. Disposable Database Migration Replay & DDL Atomicity (Real DB Integration)", () => {
    const disposableDbName = "moducraft_disposable_migration_audit";

    it("1.1 should create disposable database, execute migrations 0001 through 0010 sequentially, and verify schema parity", async () => {
      // Connect to postgres root database to provision disposable DB
      const rootClient = new pg.Client({
        connectionString: getAdminRootDatabaseUrl(),
      });
      await rootClient.connect();

      try {
        await rootClient.query(`DROP DATABASE IF EXISTS ${disposableDbName};`);
        await rootClient.query(`CREATE DATABASE ${disposableDbName};`);

        // Connect to disposable database as admin
        const dispClient = new pg.Client({
          connectionString: getDisposableDatabaseUrl(disposableDbName),
        });
        await dispClient.connect();

        try {
          const migrationsDir = path.resolve(__dirname, "../../../db/migrations");
          const migrationFiles = fs
            .readdirSync(migrationsDir)
            .filter((f) => f.endsWith(".sql"))
            .sort();

          assert.ok(migrationFiles.length >= 10, "At least 10 migration files must exist");

          for (const file of migrationFiles) {
            const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
            await dispClient.query(sql);
          }

          // Verify total tables created in disposable db
          const tablesRes = await dispClient.query<{ count: number }>(
            `SELECT COUNT(*)::int as count FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';`
          );
          assert.equal(tablesRes.rows[0].count, 16, "All 16 tables must be successfully created in disposable database");

          // Verify forced RLS on patch_application_journals in disposable DB
          const rlsRes = await dispClient.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
            `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relname = 'patch_application_journals';`
          );
          assert.equal(rlsRes.rows[0].relrowsecurity, true);
          assert.equal(rlsRes.rows[0].relforcerowsecurity, true);

          // 1.2 Verify that re-running migration 0010 is idempotent
          const mig0010 = fs.readFileSync(path.join(migrationsDir, "0010_durable_patch_journal.sql"), "utf-8");
          await assert.doesNotReject(async () => dispClient.query(mig0010));
        } finally {
          await dispClient.end();
        }
      } finally {
        await rootClient.query(`DROP DATABASE IF EXISTS ${disposableDbName};`);
        await rootClient.end();
      }
    });

    it("1.3 should verify that transactional migration errors roll back DDL cleanly without partial table creation", async () => {
      const rootClient = new pg.Client({
        connectionString: getAdminRootDatabaseUrl(),
      });
      await rootClient.connect();

      const faultDbName = "moducraft_disposable_fault_test";
      try {
        await rootClient.query(`DROP DATABASE IF EXISTS ${faultDbName};`);
        await rootClient.query(`CREATE DATABASE ${faultDbName};`);

        const dispClient = new pg.Client({
          connectionString: getDisposableDatabaseUrl(faultDbName),
        });
        await dispClient.connect();

        try {
          // Attempt transactional DDL with injected syntax error in step 2
          const faultyMigration = `
            BEGIN;
            CREATE TABLE public.test_orphan_table (id UUID PRIMARY KEY);
            -- Injected syntax failure:
            THIS IS INVALID SQL ERROR;
            COMMIT;
          `;

          await assert.rejects(async () => dispClient.query(faultyMigration));

          // Confirm test_orphan_table was NOT committed (transactional DDL rollback)
          const checkRes = await dispClient.query<{ count: number }>(
            `SELECT COUNT(*)::int as count FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'test_orphan_table';`
          );
          assert.equal(checkRes.rows[0].count, 0, "Failed transactional migration must not leave orphan tables");
        } finally {
          await dispClient.end();
        }
      } finally {
        await rootClient.query(`DROP DATABASE IF EXISTS ${faultDbName};`);
        await rootClient.end();
      }
    });
  });

  // ===========================================================================
  // 2. Cross-Tenant Recovery Isolation & Unauthorized Access (Real DB Integration)
  // ===========================================================================
  describe("2. Cross-Tenant Recovery Isolation & Unauthorized Access (Real DB Integration)", () => {
    it("2.1 should reject cross-tenant recovery under runtime role (Org Beta user gets 404 for Org Alpha journal)", async () => {
      let artifactId = "";
      let contentHash = "";

      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const scenario = await setupPatchScenario(
          tx,
          "src/tenant_leak.ts",
          "export const v = 1;\n",
          "export const v = 2;\n"
        );
        artifactId = scenario.artifact.id;
        contentHash = scenario.contentHash;
      });

      // UserBeta (Org Beta) attempts to recover Org Alpha's patch under moducraft_runtime
      await withAuthenticatedContext(runtimePool, userBetaId, async (tx) => {
        await assert.rejects(
          async () =>
            patchService.recoverInterruptedPatchApplication(
              tx,
              {
                taskId: taskAlphaId,
                projectId: projAlphaId,
                patchArtifactId: artifactId,
                expectedHash: contentHash,
              },
              userBetaId,
              orgBetaId, // Claiming Org Beta
              testWorkspaceRunner
            ),
          (err: any) =>
            err instanceof NotFoundError &&
            err.message.includes("Patch proposal artifact not found in tenant")
        );
      });
    });

    it("2.2 should reject cross-tenant administrative recovery (admin of Org Beta cannot recover Org Alpha workspace)", async () => {
      let journalId = "";
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const scenario = await setupPatchScenario(
          tx,
          "src/admin_tenant.ts",
          "export const v = 1;\n",
          "export const v = 2;\n"
        );

        const jRes = await tx.query<{ id: string }>(
          `INSERT INTO patch_application_journals (
             organization_id, project_id, task_id, patch_artifact_id, approval_id,
             target_content_hash, status, baseline_state, created_by
           ) VALUES (
             $1, $2, $3, $4, $5, $6, 'recovery_required', $7::jsonb, $8
           ) RETURNING id;`,
          [
            orgAlphaId,
            projAlphaId,
            taskAlphaId,
            scenario.artifact.id,
            scenario.approval.id,
            scenario.contentHash,
            JSON.stringify({ targetFiles: ["src/admin_tenant.ts"], files: {} }),
            userAdminId,
          ]
        );
        journalId = jRes.rows[0].id;
      });

      // UserBeta is admin in Org Beta, but NOT in Org Alpha. Querying Org Alpha journal must fail closed
      await withAuthenticatedContext(runtimePool, userBetaId, async (tx) => {
        await assert.rejects(
          async () =>
            patchService.adminRecoverWorkspace(
              tx,
              {
                journalId,
                projectId: projAlphaId,
                resolution: "mark_recovered",
                reason: "Malicious cross-tenant resolution attempt",
              },
              userBetaId,
              orgBetaId, // Passing Org Beta
              testWorkspaceRunner
            ),
          (err: any) => err instanceof NotFoundError && err.message.includes("not found")
        );
      });
    });

    it("2.3 should prevent regular members from executing adminRecoverWorkspace (role enforcement)", async () => {
      let journalId = "";
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const scenario = await setupPatchScenario(
          tx,
          "src/role_enforce.ts",
          "export const v = 1;\n",
          "export const v = 2;\n"
        );

        const jRes = await tx.query<{ id: string }>(
          `INSERT INTO patch_application_journals (
             organization_id, project_id, task_id, patch_artifact_id, approval_id,
             target_content_hash, status, baseline_state, created_by
           ) VALUES (
             $1, $2, $3, $4, $5, $6, 'recovery_required', $7::jsonb, $8
           ) RETURNING id;`,
          [
            orgAlphaId,
            projAlphaId,
            taskAlphaId,
            scenario.artifact.id,
            scenario.approval.id,
            scenario.contentHash,
            JSON.stringify({ targetFiles: ["src/role_enforce.ts"], files: {} }),
            userAdminId,
          ]
        );
        journalId = jRes.rows[0].id;
      });

      // UserMember is 'member' (not 'admin' or 'owner') in Org Alpha
      await withAuthenticatedContext(runtimePool, userMemberId, async (tx) => {
        await assert.rejects(
          async () =>
            patchService.adminRecoverWorkspace(
              tx,
              {
                journalId,
                projectId: projAlphaId,
                resolution: "mark_recovered",
              },
              userMemberId,
              orgAlphaId,
              testWorkspaceRunner
            ),
          (err: any) => err instanceof ForbiddenError && err.message.includes("Insufficient permissions")
        );
      });
    });
  });

  // ===========================================================================
  // 3. Administrative Recovery Refusal on Divergent User Edits (Real DB Integration + Mock Runner)
  // ===========================================================================
  describe("3. Administrative Recovery Refusal on Divergent User Edits (Real DB Integration + Mock Runner)", () => {
    it("3.1 should refuse restore_baseline when user uncommitted edits have diverged from baseline and target (without force)", async () => {
      let journalId = "";
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const scenario = await setupPatchScenario(
          tx,
          "src/diverge_admin.ts",
          "export const base = 100;\n",
          "export const base = 200;\n"
        );

        const jRes = await tx.query<{ id: string }>(
          `INSERT INTO patch_application_journals (
             organization_id, project_id, task_id, patch_artifact_id, approval_id,
             target_content_hash, status, baseline_state, created_by
           ) VALUES (
             $1, $2, $3, $4, $5, $6, 'recovery_required', $7::jsonb, $8
           ) RETURNING id;`,
          [
            orgAlphaId,
            projAlphaId,
            taskAlphaId,
            scenario.artifact.id,
            scenario.approval.id,
            scenario.contentHash,
            JSON.stringify({
              targetFiles: ["src/diverge_admin.ts"],
              files: {
                "src/diverge_admin.ts": {
                  existed: true,
                  contentHash: "hash100",
                  content: "export const base = 100;\n",
                },
              },
            }),
            userAdminId,
          ]
        );
        journalId = jRes.rows[0].id;
      });

      // User made uncommitted edits during downtime (neither 100 nor 200)
      testWorkspaceRunner.setFile(projAlphaId, "src/diverge_admin.ts", "export const base = 'UNCOMMITTED_WORK';\n");

      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        // Without force: true, must fail closed
        await assert.rejects(
          async () =>
            patchService.adminRecoverWorkspace(
              tx,
              {
                journalId,
                projectId: projAlphaId,
                resolution: "restore_baseline",
                reason: "Attempt restore over user edits",
              },
              userAdminId,
              orgAlphaId,
              testWorkspaceRunner
            ),
          (err: any) =>
            err instanceof ConflictError &&
            err.message.includes("contains uncommitted user modifications that diverge") &&
            err.message.includes("Pass force=true to explicitly overwrite")
        );

        // Verify uncommitted edit was preserved!
        const preserved = await testWorkspaceRunner.readFile(projAlphaId, "src/diverge_admin.ts");
        assert.equal(preserved, "export const base = 'UNCOMMITTED_WORK';\n");
      });
    });

    it("3.2 should allow restore_baseline to overwrite divergent edits when force: true is explicitly provided", async () => {
      let journalId = "";
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const scenario = await setupPatchScenario(
          tx,
          "src/diverge_force.ts",
          "export const base = 100;\n",
          "export const base = 200;\n"
        );

        const jRes = await tx.query<{ id: string }>(
          `INSERT INTO patch_application_journals (
             organization_id, project_id, task_id, patch_artifact_id, approval_id,
             target_content_hash, status, baseline_state, created_by
           ) VALUES (
             $1, $2, $3, $4, $5, $6, 'recovery_required', $7::jsonb, $8
           ) RETURNING id;`,
          [
            orgAlphaId,
            projAlphaId,
            taskAlphaId,
            scenario.artifact.id,
            scenario.approval.id,
            scenario.contentHash,
            JSON.stringify({
              targetFiles: ["src/diverge_force.ts"],
              files: {
                "src/diverge_force.ts": {
                  existed: true,
                  contentHash: "hash100",
                  content: "export const base = 100;\n",
                },
              },
            }),
            userAdminId,
          ]
        );
        journalId = jRes.rows[0].id;
      });

      testWorkspaceRunner.setFile(projAlphaId, "src/diverge_force.ts", "export const base = 'DIRTY_CONTENT';\n");

      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        // With force: true, admin explicitly overrides
        const result = await patchService.adminRecoverWorkspace(
          tx,
          {
            journalId,
            projectId: projAlphaId,
            resolution: "restore_baseline",
            reason: "Admin confirmed discard of dirty content",
            force: true,
          },
          userAdminId,
          orgAlphaId,
          testWorkspaceRunner
        );

        assert.equal(result.success, true);
        assert.equal(result.resolution, "restore_baseline");

        // Verify baseline was restored
        const restored = await testWorkspaceRunner.readFile(projAlphaId, "src/diverge_force.ts");
        assert.equal(restored, "export const base = 100;\n");

        // Verify journal transitioned to 'recovered'
        const jRes = await tx.query<{ status: string }>(
          `SELECT status FROM patch_application_journals WHERE id = $1;`,
          [journalId]
        );
        assert.equal(jRes.rows[0].status, "recovered");
      });
    });

    it("3.3 should refuse commit_patch when user uncommitted edits have diverged from baseline and target (without force)", async () => {
      let journalId = "";
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const scenario = await setupPatchScenario(
          tx,
          "src/commit_diverge.ts",
          "export const val = 1;\n",
          "export const val = 99;\n"
        );

        const jRes = await tx.query<{ id: string }>(
          `INSERT INTO patch_application_journals (
             organization_id, project_id, task_id, patch_artifact_id, approval_id,
             target_content_hash, status, baseline_state, created_by
           ) VALUES (
             $1, $2, $3, $4, $5, $6, 'recovery_required', $7::jsonb, $8
           ) RETURNING id;`,
          [
            orgAlphaId,
            projAlphaId,
            taskAlphaId,
            scenario.artifact.id,
            scenario.approval.id,
            scenario.contentHash,
            JSON.stringify({
              targetFiles: ["src/commit_diverge.ts"],
              files: {
                "src/commit_diverge.ts": {
                  existed: true,
                  contentHash: "hash1",
                  content: "export const val = 1;\n",
                },
              },
            }),
            userAdminId,
          ]
        );
        journalId = jRes.rows[0].id;
      });

      testWorkspaceRunner.setFile(projAlphaId, "src/commit_diverge.ts", "export const val = 'DIVERGED_USER_EDIT';\n");

      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        await assert.rejects(
          async () =>
            patchService.adminRecoverWorkspace(
              tx,
              {
                journalId,
                projectId: projAlphaId,
                resolution: "commit_patch",
              },
              userAdminId,
              orgAlphaId,
              testWorkspaceRunner
            ),
          (err: any) =>
            err instanceof ConflictError &&
            err.message.includes("contains uncommitted user modifications that diverge")
        );
      });
    });
  });

  // ===========================================================================
  // 4. Tampering & State/Hash Mismatch Adversarial Tests (Real DB Integration)
  // ===========================================================================
  describe("4. Tampering & State/Hash Mismatch Adversarial Tests (Real DB Integration)", () => {
    it("4.1 should fail closed if journal target_content_hash does not match patch artifact content hash", async () => {
      let journalId = "";
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const scenario = await setupPatchScenario(
          tx,
          "src/tamper1.ts",
          "export const t = 1;\n",
          "export const t = 2;\n"
        );

        // Insert journal with forged / mismatched target_content_hash
        const forgedHash = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
        const jRes = await tx.query<{ id: string }>(
          `INSERT INTO patch_application_journals (
             organization_id, project_id, task_id, patch_artifact_id, approval_id,
             target_content_hash, status, baseline_state, created_by
           ) VALUES (
             $1, $2, $3, $4, $5, $6, 'recovery_required', $7::jsonb, $8
           ) RETURNING id;`,
          [
            orgAlphaId,
            projAlphaId,
            taskAlphaId,
            scenario.artifact.id,
            scenario.approval.id,
            forgedHash,
            JSON.stringify({ targetFiles: ["src/tamper1.ts"], files: {} }),
            userAdminId,
          ]
        );
        journalId = jRes.rows[0].id;
      });

      // adminRecoverWorkspace must detect hash mismatch and reject recovery
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        await assert.rejects(
          async () =>
            patchService.adminRecoverWorkspace(
              tx,
              {
                journalId,
                projectId: projAlphaId,
                resolution: "restore_baseline",
                reason: "Administrative recovery to test hash mismatch validation",
                force: true,
              },
              userAdminId,
              orgAlphaId,
              testWorkspaceRunner
            ),
          (err: any) =>
            err instanceof ConflictError &&
            err.message.includes("does not match journal target hash")
        );
      });
    });

    it("4.2 should reject invalid journal state transitions via database check constraint", async () => {
      await assert.rejects(
        async () => {
          await adminPool.query(
            `INSERT INTO patch_application_journals (
               organization_id, project_id, task_id, patch_artifact_id, approval_id,
               target_content_hash, status, baseline_state, created_by
             ) VALUES (
               $1, $2, $3, $4, $5,
               '3333333333333333333333333333333333333333333333333333333333333333',
               'INVALID_NON_EXISTENT_STATUS',
               '{}'::jsonb, $6
             );`,
            [
              orgAlphaId,
              projAlphaId,
              taskAlphaId,
              "ffffffff-4d60-4000-8000-000000000999",
              "ffffffff-4d60-4000-8000-000000000999",
              userAdminId,
            ]
          );
        },
        /patch_journals_status_check/
      );
    });

    it("4.3 should serialize concurrent adminRecoverWorkspace calls via row locking (exactly one wins)", async () => {
      let journalId = "";
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const scenario = await setupPatchScenario(
          tx,
          "src/concurrent_admin.ts",
          "export const c = 1;\n",
          "export const c = 2;\n"
        );

        const jRes = await tx.query<{ id: string }>(
          `INSERT INTO patch_application_journals (
             organization_id, project_id, task_id, patch_artifact_id, approval_id,
             target_content_hash, status, baseline_state, created_by
           ) VALUES (
             $1, $2, $3, $4, $5, $6, 'recovery_required', $7::jsonb, $8
           ) RETURNING id;`,
          [
            orgAlphaId,
            projAlphaId,
            taskAlphaId,
            scenario.artifact.id,
            scenario.approval.id,
            scenario.contentHash,
            JSON.stringify({
              targetFiles: ["src/concurrent_admin.ts"],
              files: {
                "src/concurrent_admin.ts": {
                  existed: true,
                  contentHash: "hash1",
                  content: "export const c = 1;\n",
                },
              },
            }),
            userAdminId,
          ]
        );
        journalId = jRes.rows[0].id;
      });

      // Fire 2 concurrent recovery operations
      const p1 = withAuthenticatedContext(runtimePool, userAdminId, async (tx) =>
        patchService.adminRecoverWorkspace(
          tx,
          {
            journalId,
            projectId: projAlphaId,
            resolution: "restore_baseline",
            reason: "Concurrent recovery conflict resolution",
            force: true,
          },
          userAdminId,
          orgAlphaId,
          testWorkspaceRunner
        )
      );

      const p2 = withAuthenticatedContext(runtimePool, userAdminId, async (tx) =>
        patchService.adminRecoverWorkspace(
          tx,
          {
            journalId,
            projectId: projAlphaId,
            resolution: "restore_baseline",
            reason: "Concurrent recovery conflict resolution",
            force: true,
          },
          userAdminId,
          orgAlphaId,
          testWorkspaceRunner
        )
      );

      const results = await Promise.allSettled([p1, p2]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      assert.equal(fulfilled.length, 1, "Exactly one concurrent recovery must succeed");
      assert.equal(rejected.length, 1, "Second concurrent recovery must be rejected");
      assert.ok(
        (rejected[0] as PromiseRejectedResult).reason instanceof ConflictError,
        "Rejected call must fail with ConflictError"
      );
    });
  });

  // ===========================================================================
  // 5. Sensitive Data Redaction & Unbounded Payload Safeguards (Real DB + Unit)
  // ===========================================================================
  describe("5. Sensitive Data Redaction & Unbounded Payload Safeguards (Real DB + Unit)", () => {
    it("5.1 should sanitize API keys, private keys, and credentials from recovery_details error strings", async () => {
      const rawErrorMessage =
        "Failed to write to runner: Authorization token Bearer sk-ant-api03-abcdef12345678901234567890 failed. DB connection: postgresql://admin:secretPass123@db.prod.internal:5432/secrets";

      const sanitized = redactSensitiveData(rawErrorMessage).text;

      assert.ok(!sanitized.includes("sk-ant-api03"), "Raw API key must not appear in sanitized text");
      assert.ok(!sanitized.includes("secretPass123"), "Database password must not appear in sanitized text");
      assert.ok(sanitized.includes("[REDACTED_API_KEY]") || sanitized.includes("[REDACTED_TOKEN]"));
      assert.ok(sanitized.includes("[REDACTED_CONNECTION_STRING]"));
    });

    it("5.2 should reject baseline snapshot when target file exceeds MAX_BASELINE_FILE_SIZE_BYTES (1 MB)", async () => {
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        // Construct diff targeting oversized file
        const largeContent = "A\n" + "B".repeat(1024 * 1024 + 100); // > 1 MB
        testWorkspaceRunner.setFile(projAlphaId, "src/oversized.ts", largeContent);

        const diff =
          `--- a/src/oversized.ts\n` +
          `+++ b/src/oversized.ts\n` +
          `@@ -1,1 +1,1 @@\n` +
          `-A\n` +
          `+B\n`;

        const contentHash = crypto.createHash("sha256").update(diff, "utf-8").digest("hex");

        const artifact = await artifactsService.createArtifact(tx, userAdminId, orgAlphaId, {
          projectId: projAlphaId,
          taskId: taskAlphaId,
          artifactType: "patch_proposal",
          title: "Large file patch",
          content: diff,
          metadata: { targetFiles: ["src/oversized.ts"] },
        });

        const approval = await approvalsService.createApprovalRequest(tx, orgAlphaId, {
          taskId: taskAlphaId,
          artifactId: artifact.id,
          action: "apply_patch",
          targetContentHash: contentHash,
          requiredRole: "admin",
          expiresInSeconds: 3600,
        });

        await approvalsService.decideApproval(tx, approval.id, userAdminId, orgAlphaId, {
          decision: "approved",
        });

        // applyApprovedPatch should fail with ValidationError regarding file size limit
        await assert.rejects(
          async () =>
            patchService.applyApprovedPatch(
              tx,
              {
                taskId: taskAlphaId,
                projectId: projAlphaId,
                patchArtifactId: artifact.id,
                expectedHash: contentHash,
              },
              userAdminId,
              orgAlphaId,
              testWorkspaceRunner
            ),
          (err: any) =>
            err instanceof ValidationError &&
            err.message.includes("exceeds maximum supported baseline snapshot size")
        );
      });
    });

    it("5.3 should sanitize sensitive tokens from admin recovery reason when recorded in journal", async () => {
      let journalId = "";
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const scenario = await setupPatchScenario(
          tx,
          "src/admin_redact.ts",
          "export const a = 1;\n",
          "export const a = 2;\n"
        );

        const jRes = await tx.query<{ id: string }>(
          `INSERT INTO patch_application_journals (
             organization_id, project_id, task_id, patch_artifact_id, approval_id,
             target_content_hash, status, baseline_state, created_by
           ) VALUES (
             $1, $2, $3, $4, $5, $6, 'recovery_required', $7::jsonb, $8
           ) RETURNING id;`,
          [
            orgAlphaId,
            projAlphaId,
            taskAlphaId,
            scenario.artifact.id,
            scenario.approval.id,
            scenario.contentHash,
            JSON.stringify({ targetFiles: ["src/admin_redact.ts"], files: {} }),
            userAdminId,
          ]
        );
        journalId = jRes.rows[0].id;

        // Admin recovery with reason containing an exposed API key
        await patchService.adminRecoverWorkspace(
          tx,
          {
            journalId,
            projectId: projAlphaId,
            resolution: "mark_recovered",
            reason: "Incident investigation key: sk-live-99887766554433221100aa",
          },
          userAdminId,
          orgAlphaId,
          testWorkspaceRunner
        );

        // Query database to inspect recovery_details
        const checkRes = await tx.query<{ recoveryDetails: any }>(
          `SELECT recovery_details as "recoveryDetails" FROM patch_application_journals WHERE id = $1;`,
          [journalId]
        );
        const reason = checkRes.rows[0].recoveryDetails.reason;
        assert.ok(!reason.includes("sk-live-998877"), "API key must not be persisted in journal recovery_details");
        assert.ok(reason.includes("[REDACTED_API_KEY]"), "Redacted token marker must be stored instead");
      });
    });
  });

  // ===========================================================================
  // 6. Primary Database Safety & Zero-Drift Verification (Real DB Integration)
  // ===========================================================================
  describe("6. Primary Database Safety & Zero-Drift Verification (Real DB Integration)", () => {
    it("6.1 should verify that the test database was targeted and isolated", async () => {
      // Confirm database name is moducraft_test
      const dbRes = await adminPool.query<{ current_database: string }>(
        `SELECT current_database();`
      );
      assert.equal(dbRes.rows[0].current_database, "moducraft_test");
    });

    it("6.2 should verify all 16 tables in public schema remain intact with relforcerowsecurity = t", async () => {
      const tablesRes = await adminPool.query<{ count: number }>(
        `
        SELECT COUNT(*)::int as count
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name != 'schema_migrations';
        `
      );
      assert.equal(tablesRes.rows[0].count, 16, "Primary database must retain exactly 16 public domain tables");

      // Verify all 16 tables have forced RLS active
      const rlsCheck = await adminPool.query<{ count: number }>(
        `
        SELECT COUNT(*)::int as count
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity = true;
        `
      );
      assert.equal(rlsCheck.rows[0].count, 16, "All 16 tables must have relforcerowsecurity = true");
    });

    it("6.3 should verify moducraft_runtime has no DELETE privilege on patch_application_journals", async () => {
      const grantRes = await adminPool.query<{ privilege_type: string }>(
        `
        SELECT privilege_type
        FROM information_schema.role_table_grants
        WHERE table_name = 'patch_application_journals' AND grantee = 'moducraft_runtime' AND privilege_type = 'DELETE';
        `
      );
      assert.equal(grantRes.rows.length, 0, "moducraft_runtime role must not have DELETE privilege on patch journals");
    });
  });
});
