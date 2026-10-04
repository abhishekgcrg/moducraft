import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDatabasePool } from "../src/db/pool.js";
import { withAuthenticatedContext } from "../src/db/transaction.js";
import { getTestDatabaseUrls } from "./helpers/test-db-guard.js";
import {
  createWorkspaceRunner,
} from "../src/modules/workflows/tools/runner-factory.js";
import { MockWorkspaceRunner } from "../src/modules/workflows/tools/sandbox.js";
import {
  ApprovedPatchService,
  parseUnifiedDiff,
  applyHunksToFile,
} from "../src/modules/workflows/patch.service.js";
import { ApprovalsService } from "../src/modules/workflows/approvals.service.js";
import { ArtifactsService } from "../src/modules/workflows/artifacts.service.js";
import {
  ConflictError,
  ValidationError,
  ForbiddenError,
  NotFoundError,
} from "../src/errors/app-errors.js";
import type {
  IsolatedWorkspaceRunner,
  PatchApplicationJournalDto,
} from "../src/modules/workflows/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Phase 4D.5: Durable Patch Recovery & Crash Consistency", () => {
  let adminPool: pg.Pool;
  let runtimePool: pg.Pool;
  let testWorkspaceRunner: MockWorkspaceRunner;
  let patchService: ApprovedPatchService;
  let approvalsService: ApprovalsService;
  let artifactsService: ArtifactsService;

  // Isolated test UUIDs with specific 4D.5 prefix
  const orgAlphaId = "ffffffff-4d50-4000-8000-000000000010";
  const orgBetaId = "ffffffff-4d50-4000-8000-000000000020";
  const userAdminId = "ffffffff-4d50-4000-8000-000000000001";
  const userBetaId = "ffffffff-4d50-4000-8000-000000000002";
  const projAlphaId = "ffffffff-4d50-4000-8000-000000000100";
  const taskAlphaId = "ffffffff-4d50-4000-8000-000000000200";
  const taskCancelId = "ffffffff-4d50-4000-8000-000000000201";

  const { runtimeDbUrl, superuserDbUrl } = getTestDatabaseUrls();

  const issuer = "https://auth.moducraft.test";

  before(async () => {
    adminPool = new pg.Pool({ connectionString: superuserDbUrl, max: 2 });
    runtimePool = createDatabasePool(runtimeDbUrl);

    testWorkspaceRunner = new MockWorkspaceRunner();
    approvalsService = new ApprovalsService();
    artifactsService = new ArtifactsService();
    patchService = new ApprovedPatchService(
      approvalsService,
      artifactsService,
      testWorkspaceRunner
    );

    // Seed test users
    await adminPool.query(
      `
      INSERT INTO app_users(id, identity_issuer, identity_subject, email, display_name)
      VALUES 
        ($1, $3, 'sub-4d5-admin', 'admin-4d5@moducraft.test', 'Admin 4D5 User'),
        ($2, $3, 'sub-4d5-beta', 'beta-4d5@moducraft.test', 'Beta 4D5 User')
      ON CONFLICT (id) DO NOTHING;
      `,
      [userAdminId, userBetaId, issuer]
    );

    // Seed organizations
    await adminPool.query(
      `
      INSERT INTO organizations(id, name, slug, created_by)
      VALUES 
        ($1, 'Org 4D5 Alpha', 'org-4d5-alpha', $3),
        ($2, 'Org 4D5 Beta', 'org-4d5-beta', $4)
      ON CONFLICT (id) DO NOTHING;
      `,
      [orgAlphaId, orgBetaId, userAdminId, userBetaId]
    );

    // Seed memberships (Admin in Org Alpha, Member in Org Beta)
    await adminPool.query(
      `
      INSERT INTO organization_memberships(organization_id, user_id, role)
      VALUES 
        ($1, $2, 'admin'),
        ($3, $4, 'member')
      ON CONFLICT (organization_id, user_id) DO NOTHING;
      `,
      [orgAlphaId, userAdminId, orgBetaId, userBetaId]
    );

    // Seed test project
    await adminPool.query(
      `
      INSERT INTO projects(id, organization_id, name, slug, description, created_by)
      VALUES ($1, $2, 'Crash Consistency Project', 'crash-consistency-project', 'Test project for crash consistency', $3)
      ON CONFLICT (id) DO NOTHING;
      `,
      [projAlphaId, orgAlphaId, userAdminId]
    );

    // Seed test tasks
    await adminPool.query(
      `
      INSERT INTO agent_tasks(id, organization_id, project_id, title, task_type, status, created_by, input_data)
      VALUES 
        ($1, $2, $3, 'Crash Consistency Task', 'workflow', 'running', $4, '{"test": true}'::jsonb),
        ($5, $2, $3, 'Task For Cancellation Testing', 'workflow', 'waiting_for_approval', $4, '{"test": true}'::jsonb)
      ON CONFLICT (id) DO NOTHING;
      `,
      [taskAlphaId, orgAlphaId, projAlphaId, userAdminId, taskCancelId]
    );
  });

  beforeEach(async () => {
    // Clean test-specific rows between each test for full test isolation
    if (adminPool) {
      await adminPool.query(
        `DELETE FROM patch_application_journals WHERE organization_id IN ($1, $2);`,
        [orgAlphaId, orgBetaId]
      );
      await adminPool.query(
        `DELETE FROM agent_approvals WHERE organization_id IN ($1, $2);`,
        [orgAlphaId, orgBetaId]
      );
      await adminPool.query(
        `DELETE FROM agent_artifacts WHERE organization_id IN ($1, $2);`,
        [orgAlphaId, orgBetaId]
      );
      // Reset task status to running
      await adminPool.query(
        `UPDATE agent_tasks SET status = 'running' WHERE id = $1;`,
        [taskAlphaId]
      );
    }
  });

  after(async () => {
    // Strictly isolate test teardown to test-specific rows; never drop or truncate primary tables
    if (adminPool) {
      await adminPool.query(`DELETE FROM patch_application_journals WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM agent_approvals WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM agent_artifacts WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM agent_tasks WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM projects WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM organization_memberships WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM organizations WHERE id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM app_users WHERE id IN ($1, $2);`, [userAdminId, userBetaId]);
      await adminPool.end();
    }
    if (runtimePool) {
      await runtimePool.end();
    }
  });

  // Helper to create test artifact and approval
  async function setupPatchScenario(tx: any, filename: string, originalContent: string, patchedContent: string) {
    testWorkspaceRunner.setFile(projAlphaId, filename, originalContent);

    const diff =
      `--- a/${filename}\n` +
      `+++ b/${filename}\n` +
      `@@ -1,1 +1,1 @@\n` +
      `-${originalContent.trim()}\n` +
      `+${patchedContent.trim()}\n`;

    const contentHash = crypto.createHash("sha256").update(diff, "utf-8").digest("hex");

    const artifact = await artifactsService.createArtifact(tx, userAdminId, orgAlphaId, {
      projectId: projAlphaId,
      taskId: taskAlphaId,
      artifactType: "patch_proposal",
      title: `Patch for ${filename}`,
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
      reason: "Automated test approval",
    });

    return { artifact, approval, contentHash, diff };
  }

  // ===========================================================================
  // Suite 1: Durable Patch Journal State Machine & Boundary Transitions
  // ===========================================================================
  describe("1. Durable Patch Journal State Machine & Boundary Transitions", () => {
    it("1.1 should create journal entry in 'applied' status with baseline snapshot upon successful patch", async () => {
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const { artifact, contentHash } = await setupPatchScenario(
          tx,
          "src/journal1.ts",
          "export const v1 = 1;\n",
          "export const v1 = 2;\n"
        );

        const result = await patchService.applyApprovedPatch(
          tx,
          {
            taskId: taskAlphaId,
            projectId: projAlphaId,
            patchArtifactId: artifact.id,
            expectedHash: contentHash,
          },
          userAdminId,
          orgAlphaId
        );

        assert.equal(result.success, true);
        assert.ok(result.journalId);

        // Query database to inspect durable journal row
        const journalRes = await tx.query<PatchApplicationJournalDto>(
          `SELECT id, status, baseline_state, applied_files, target_content_hash
           FROM patch_application_journals
           WHERE id = $1;`,
          [result.journalId]
        );
        const journal = journalRes.rows[0];
        assert.ok(journal);
        assert.equal(journal.status, "applied");
        assert.equal(journal.target_content_hash, contentHash);
        assert.deepEqual(journal.applied_files, ["src/journal1.ts"]);
        assert.ok(journal.baseline_state.files["src/journal1.ts"].existed);
        assert.equal(
          journal.baseline_state.files["src/journal1.ts"].content,
          "export const v1 = 1;\n"
        );
      });
    });

    it("1.2 should transition journal to 'rolled_back' when runner write fails and rollback succeeds", async () => {
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        testWorkspaceRunner.setFile(projAlphaId, "src/f1.ts", "const f1 = 10;\n");
        testWorkspaceRunner.setFile(projAlphaId, "src/f2.ts", "const f2 = 20;\n");

        const multiDiff =
          `--- a/src/f1.ts\n` +
          `+++ b/src/f1.ts\n` +
          `@@ -1,1 +1,1 @@\n` +
          `-const f1 = 10;\n` +
          `+const f1 = 11;\n` +
          `--- a/src/f2.ts\n` +
          `+++ b/src/f2.ts\n` +
          `@@ -1,1 +1,1 @@\n` +
          `-const f2 = 20;\n` +
          `+const f2 = 21;\n`;

        const contentHash = crypto.createHash("sha256").update(multiDiff, "utf-8").digest("hex");

        const artifact = await artifactsService.createArtifact(tx, userAdminId, orgAlphaId, {
          projectId: projAlphaId,
          taskId: taskAlphaId,
          artifactType: "patch_proposal",
          title: "Multi-file patch",
          content: multiDiff,
          metadata: { targetFiles: ["src/f1.ts", "src/f2.ts"] },
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

        // Fault runner: 1st write succeeds, 2nd write fails
        let writeCount = 0;
        const faultRunner: IsolatedWorkspaceRunner = {
          runnerType: "mock",
          isProductionSandbox: false,
          isolationLevel: "none",
          readFile: (p, f) => testWorkspaceRunner.readFile(p, f),
          readManifest: (p) => testWorkspaceRunner.readManifest(p),
          runAllowlistedCommand: (p, c) => testWorkspaceRunner.runAllowlistedCommand(p, c),
          setFile: async (p, f, c) => {
            writeCount++;
            if (writeCount === 2) {
              throw new Error("FAULT_INJECTED_SECOND_FILE_FAILURE");
            }
            return testWorkspaceRunner.setFile(p, f, c);
          },
          deleteFile: (p, f) => testWorkspaceRunner.deleteFile(p, f),
        };

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
              faultRunner
            ),
          (err: any) =>
            err instanceof ConflictError &&
            err.message.includes("Pre-existing user modifications safely restored; workspace rolled back.")
        );

        // Verify journal row recorded status = 'rolled_back'
        const journalRes = await tx.query<PatchApplicationJournalDto>(
          `SELECT status, recovery_details FROM patch_application_journals
           WHERE organization_id = $1 AND task_id = $2
           ORDER BY created_at DESC LIMIT 1;`,
          [orgAlphaId, taskAlphaId]
        );
        const journal = journalRes.rows[0];
        assert.ok(journal);
        assert.equal(journal.status, "rolled_back");
        assert.ok(journal.recovery_details.rolledBackAt);
      });
    });

    it("1.3 should transition journal to 'recovery_required' when compensating rollback fails", async () => {
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        testWorkspaceRunner.setFile(projAlphaId, "src/cat1.ts", "const c1 = 1;\n");
        testWorkspaceRunner.setFile(projAlphaId, "src/cat2.ts", "const c2 = 2;\n");

        const multiDiff =
          `--- a/src/cat1.ts\n` +
          `+++ b/src/cat1.ts\n` +
          `@@ -1,1 +1,1 @@\n` +
          `-const c1 = 1;\n` +
          `+const c1 = 9;\n` +
          `--- a/src/cat2.ts\n` +
          `+++ b/src/cat2.ts\n` +
          `@@ -1,1 +1,1 @@\n` +
          `-const c2 = 2;\n` +
          `+const c2 = 9;\n`;

        const contentHash = crypto.createHash("sha256").update(multiDiff, "utf-8").digest("hex");

        const artifact = await artifactsService.createArtifact(tx, userAdminId, orgAlphaId, {
          projectId: projAlphaId,
          taskId: taskAlphaId,
          artifactType: "patch_proposal",
          title: "Catastrophic multi-file patch",
          content: multiDiff,
          metadata: { targetFiles: ["src/cat1.ts", "src/cat2.ts"] },
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

        // Fault runner: 1st write succeeds, 2nd write fails, rollback write also fails!
        let callCount = 0;
        const faultRunner: IsolatedWorkspaceRunner = {
          runnerType: "mock",
          isProductionSandbox: false,
          isolationLevel: "none",
          readFile: (p, f) => testWorkspaceRunner.readFile(p, f),
          readManifest: (p) => testWorkspaceRunner.readManifest(p),
          runAllowlistedCommand: (p, c) => testWorkspaceRunner.runAllowlistedCommand(p, c),
          setFile: async (p, f, c) => {
            callCount++;
            if (callCount === 1) return testWorkspaceRunner.setFile(p, f, c);
            if (callCount === 2) throw new Error("INJECTED_WRITE_ERROR");
            throw new Error("INJECTED_ROLLBACK_ERROR");
          },
          deleteFile: (p, f) => testWorkspaceRunner.deleteFile(p, f),
        };

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
              faultRunner
            ),
          (err: any) =>
            err instanceof ConflictError &&
            err.message.includes("Critical patch application failure") &&
            err.message.includes("Workspace may be inconsistent and is fenced")
        );

        // Verify journal row transitioned to 'recovery_required'
        const journalRes = await tx.query<PatchApplicationJournalDto>(
          `SELECT id, status, recovery_details FROM patch_application_journals
           WHERE organization_id = $1 AND task_id = $2
           ORDER BY created_at DESC LIMIT 1;`,
          [orgAlphaId, taskAlphaId]
        );
        const journal = journalRes.rows[0];
        assert.ok(journal);
        assert.equal(journal.status, "recovery_required");
        assert.ok(journal.recovery_details.rollbackErrors);
      });
    });
  });

  // ===========================================================================
  // Suite 2: Deterministic Fault & Crash Injection across Lifecycle Boundaries
  // ===========================================================================
  describe("2. Deterministic Fault & Crash Injection across Lifecycle Boundaries", () => {
    it("2.1 Boundary 1 (before approval consumption): state remains clean and approval remains approved", async () => {
      const { artifact, approval, contentHash } = await withAuthenticatedContext(
        runtimePool,
        userAdminId,
        async (tx) =>
          setupPatchScenario(
            tx,
            "src/b1.ts",
            "export const b1 = 'initial';\n",
            "export const b1 = 'updated';\n"
          )
      );

      // Execute durable patch with crashHook at "before_approval"
      await assert.rejects(
        async () =>
          patchService.applyApprovedPatchDurable(
            runtimePool,
            {
              taskId: taskAlphaId,
              projectId: projAlphaId,
              patchArtifactId: artifact.id,
              expectedHash: contentHash,
            },
            userAdminId,
            orgAlphaId,
            testWorkspaceRunner,
            async (stage) => {
              if (stage === "before_approval") {
                throw new Error("SIMULATED_CRASH_BEFORE_APPROVAL");
              }
            }
          ),
        /SIMULATED_CRASH_BEFORE_APPROVAL/
      );

      // Verify approval was NOT consumed
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const appRes = await tx.query<{ status: string }>(
          `SELECT status FROM agent_approvals WHERE id = $1;`,
          [approval.id]
        );
        assert.equal(appRes.rows[0]?.status, "approved");

        // Verify no journal was committed
        const jRes = await tx.query(
          `SELECT COUNT(*)::int as count FROM patch_application_journals WHERE approval_id = $1;`,
          [approval.id]
        );
        assert.equal(jRes.rows[0]?.count, 0);

        // Verify workspace was not modified
        const fileContent = await testWorkspaceRunner.readFile(projAlphaId, "src/b1.ts");
        assert.equal(fileContent, "export const b1 = 'initial';\n");
      });
    });

    it("2.2 Boundary 2 (after approval consumption, before writes): journal committed in 'applying', recovery completes cleanly", async () => {
      const { artifact, approval, contentHash } = await withAuthenticatedContext(
        runtimePool,
        userAdminId,
        async (tx) =>
          setupPatchScenario(
            tx,
            "src/b2.ts",
            "export const b2 = 'old';\n",
            "export const b2 = 'new';\n"
          )
      );

      // Execute durable patch with crashHook at "after_approval_before_writes"
      await assert.rejects(
        async () =>
          patchService.applyApprovedPatchDurable(
            runtimePool,
            {
              taskId: taskAlphaId,
              projectId: projAlphaId,
              patchArtifactId: artifact.id,
              expectedHash: contentHash,
            },
            userAdminId,
            orgAlphaId,
            testWorkspaceRunner,
            async (stage) => {
              if (stage === "after_approval_before_writes") {
                throw new Error("SIMULATED_CRASH_AFTER_APPROVAL_BEFORE_WRITES");
              }
            }
          ),
        /SIMULATED_CRASH_AFTER_APPROVAL_BEFORE_WRITES/
      );

      // Verify approval IS consumed and journal IS in 'applying'
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const appRes = await tx.query<{ status: string }>(
          `SELECT status FROM agent_approvals WHERE id = $1;`,
          [approval.id]
        );
        assert.equal(appRes.rows[0]?.status, "consumed");

        const jRes = await tx.query<PatchApplicationJournalDto>(
          `SELECT status, baseline_state FROM patch_application_journals WHERE approval_id = $1;`,
          [approval.id]
        );
        assert.equal(jRes.rows[0]?.status, "applying");

        // Now perform recovery from the simulated crash
        const recoveryResult = await patchService.recoverInterruptedPatchApplication(
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
        );

        assert.equal(recoveryResult.success, true);
        assert.deepEqual(recoveryResult.filesModified, ["src/b2.ts"]);

        // Verify workspace is now patched
        const fileContent = await testWorkspaceRunner.readFile(projAlphaId, "src/b2.ts");
        assert.equal(fileContent, "export const b2 = 'new';\n");

        // Verify journal transitioned to 'applied'
        const jRes2 = await tx.query<{ status: string }>(
          `SELECT status FROM patch_application_journals WHERE approval_id = $1;`,
          [approval.id]
        );
        assert.equal(jRes2.rows[0]?.status, "applied");
      });
    });

    it("2.3 Boundary 3 (after first file write): recovery detects partial write, restores or completes safely", async () => {
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        testWorkspaceRunner.setFile(projAlphaId, "src/part1.ts", "const p1 = 'v1';\n");
        testWorkspaceRunner.setFile(projAlphaId, "src/part2.ts", "const p2 = 'v2';\n");

        const multiDiff =
          `--- a/src/part1.ts\n` +
          `+++ b/src/part1.ts\n` +
          `@@ -1,1 +1,1 @@\n` +
          `-const p1 = 'v1';\n` +
          `+const p1 = 'v1-updated';\n` +
          `--- a/src/part2.ts\n` +
          `+++ b/src/part2.ts\n` +
          `@@ -1,1 +1,1 @@\n` +
          `-const p2 = 'v2';\n` +
          `+const p2 = 'v2-updated';\n`;

        const contentHash = crypto.createHash("sha256").update(multiDiff, "utf-8").digest("hex");

        const artifact = await artifactsService.createArtifact(tx, userAdminId, orgAlphaId, {
          projectId: projAlphaId,
          taskId: taskAlphaId,
          artifactType: "patch_proposal",
          title: "Partial write patch",
          content: multiDiff,
          metadata: { targetFiles: ["src/part1.ts", "src/part2.ts"] },
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
      });

      // Fetch artifact details for outside transaction
      const artifactRes = await adminPool.query<any>(
        `SELECT id, content_hash as "contentHash" FROM agent_artifacts WHERE task_id = $1 LIMIT 1;`,
        [taskAlphaId]
      );
      const artifact = artifactRes.rows[0];

      // Execute with crashHook at "after_first_write"
      await assert.rejects(
        async () =>
          patchService.applyApprovedPatchDurable(
            runtimePool,
            {
              taskId: taskAlphaId,
              projectId: projAlphaId,
              patchArtifactId: artifact.id,
              expectedHash: artifact.contentHash,
            },
            userAdminId,
            orgAlphaId,
            testWorkspaceRunner,
            async (stage) => {
              if (stage === "after_first_write") {
                throw new Error("SIMULATED_CRASH_AFTER_FIRST_WRITE");
              }
            }
          ),
        /SIMULATED_CRASH_AFTER_FIRST_WRITE/
      );

      // Verify partial state on runner: part1 is updated, part2 is not yet updated
      const f1 = await testWorkspaceRunner.readFile(projAlphaId, "src/part1.ts");
      const f2 = await testWorkspaceRunner.readFile(projAlphaId, "src/part2.ts");
      assert.equal(f1, "const p1 = 'v1-updated';\n");
      assert.equal(f2, "const p2 = 'v2';\n");

      // Now run recovery: it should detect partial write and complete part2 cleanly!
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const recoveryResult = await patchService.recoverInterruptedPatchApplication(
          tx,
          {
            taskId: taskAlphaId,
            projectId: projAlphaId,
            patchArtifactId: artifact.id,
            expectedHash: artifact.contentHash,
          },
          userAdminId,
          orgAlphaId,
          testWorkspaceRunner
        );

        assert.equal(recoveryResult.success, true);

        // Verify both files are now updated
        const final1 = await testWorkspaceRunner.readFile(projAlphaId, "src/part1.ts");
        const final2 = await testWorkspaceRunner.readFile(projAlphaId, "src/part2.ts");
        assert.equal(final1, "const p1 = 'v1-updated';\n");
        assert.equal(final2, "const p2 = 'v2-updated';\n");

        // Verify journal is applied
        const jRes = await tx.query<{ status: string }>(
          `SELECT status FROM patch_application_journals WHERE task_id = $1;`,
          [taskAlphaId]
        );
        assert.equal(jRes.rows[0]?.status, "applied");
      });
    });
  });

  // ===========================================================================
  // Suite 3: Child-Process Termination & Real Process-Restart Durability
  // ===========================================================================
  describe("3. Child-Process Termination & Real Process-Restart Durability", () => {
    it("3.1 should survive abrupt child process termination (process.exit) mid-flight and recover in fresh parent process", async () => {
      // 1. Setup scenario in parent DB transaction
      let artifactId = "";
      let contentHash = "";
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const { artifact, contentHash: hash } = await setupPatchScenario(
          tx,
          "src/process_crash.ts",
          "export const processStatus = 'initial';\n",
          "export const processStatus = 'crashed_and_recovered';\n"
        );
        artifactId = artifact.id;
        contentHash = hash;
      });

      // 2. Spawn child process that crashes at breakpoint "after_approval_before_writes"
      const workerScript = path.join(__dirname, "fixtures", "crash-worker.ts");
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--import",
          pathToFileURL(path.join(__dirname, "helpers", "test-bootstrap.ts")).href,
          workerScript,
          "after_approval_before_writes",
          taskAlphaId,
          projAlphaId,
          artifactId,
          contentHash,
          userAdminId,
          orgAlphaId,
          JSON.stringify({ "src/process_crash.ts": "export const processStatus = 'initial';\n" }),
        ],
        {
          stdio: "pipe",
          env: {
            ...process.env,
            NODE_ENV: "test",
            DATABASE_URL: runtimeDbUrl,
          },
        }
      );

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));

      const exitCode = await new Promise<number | null>((resolve) => {
        child.on("close", (code) => resolve(code));
      });

      // 3. Confirm child process terminated abnormally with exit code 99 (injected exit)
      assert.equal(exitCode, 99, `Child worker should have exited with code 99. stderr: ${stderr}`);
      assert.ok(stdout.includes("CRASH_BREAKPOINT_REACHED:after_approval_before_writes"));

      // 4. In a completely NEW transaction (simulating restarted API instance), inspect durable PostgreSQL state
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const jRes = await tx.query<PatchApplicationJournalDto>(
          `SELECT id, status, baseline_state FROM patch_application_journals
           WHERE organization_id = $1 AND task_id = $2;`,
          [orgAlphaId, taskAlphaId]
        );

        assert.equal(jRes.rows.length, 1);
        const journal = jRes.rows[0];
        assert.equal(journal.status, "applying");
        assert.ok(journal.baseline_state.files["src/process_crash.ts"]);

        // 5. Execute recovery in the new process
        const recoveryResult = await patchService.recoverInterruptedPatchApplication(
          tx,
          {
            taskId: taskAlphaId,
            projectId: projAlphaId,
            patchArtifactId: artifactId,
            expectedHash: contentHash,
          },
          userAdminId,
          orgAlphaId,
          testWorkspaceRunner
        );

        assert.equal(recoveryResult.success, true);

        // 6. Verify workspace files were successfully updated
        const recoveredContent = await testWorkspaceRunner.readFile(
          projAlphaId,
          "src/process_crash.ts"
        );
        assert.equal(
          recoveredContent,
          "export const processStatus = 'crashed_and_recovered';\n"
        );

        // 7. Verify journal transitioned to 'applied'
        const jFinal = await tx.query<{ status: string }>(
          `SELECT status FROM patch_application_journals WHERE id = $1;`,
          [journal.id]
        );
        assert.equal(jFinal.rows[0]?.status, "applied");
      });
    });
  });

  // ===========================================================================
  // Suite 4: Idempotent Recovery & Divergence Detection (Fail-Closed)
  // ===========================================================================
  describe("4. Idempotent Recovery & Divergence Detection (Fail-Closed)", () => {
    it("4.1 should return idempotent success without duplicate writes when already applied", async () => {
      let artifactId = "";
      let contentHash = "";

      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const { artifact, contentHash: hash } = await setupPatchScenario(
          tx,
          "src/idempotent.ts",
          "export const state = 0;\n",
          "export const state = 1;\n"
        );
        artifactId = artifact.id;
        contentHash = hash;

        // Apply normally
        await patchService.applyApprovedPatch(
          tx,
          {
            taskId: taskAlphaId,
            projectId: projAlphaId,
            patchArtifactId: artifact.id,
            expectedHash: hash,
          },
          userAdminId,
          orgAlphaId
        );
      });

      // Call recovery with idempotent: true
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const result = await patchService.recoverInterruptedPatchApplication(
          tx,
          {
            taskId: taskAlphaId,
            projectId: projAlphaId,
            patchArtifactId: artifactId,
            expectedHash: contentHash,
          },
          userAdminId,
          orgAlphaId,
          testWorkspaceRunner,
          { idempotent: true }
        );

        assert.equal(result.success, true);
        assert.ok(result.diffSummary?.includes("idempotent recovery"));

        // Second recovery call is also idempotent
        const result2 = await patchService.recoverInterruptedPatchApplication(
          tx,
          {
            taskId: taskAlphaId,
            projectId: projAlphaId,
            patchArtifactId: artifactId,
            expectedHash: contentHash,
          },
          userAdminId,
          orgAlphaId,
          testWorkspaceRunner,
          { idempotent: true }
        );
        assert.equal(result2.success, true);
      });
    });

    it("4.2 should fail closed with ConflictError if workspace files diverged from both baseline and target", async () => {
      let artifactId = "";
      let contentHash = "";

      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const { artifact, contentHash: hash } = await setupPatchScenario(
          tx,
          "src/diverge.ts",
          "export const baseVal = 'original';\n",
          "export const baseVal = 'patched';\n"
        );
        artifactId = artifact.id;
        contentHash = hash;
      });

      // Simulate crash after approval: journal is in 'applying'
      await assert.rejects(
        async () =>
          patchService.applyApprovedPatchDurable(
            runtimePool,
            {
              taskId: taskAlphaId,
              projectId: projAlphaId,
              patchArtifactId: artifactId,
              expectedHash: contentHash,
            },
            userAdminId,
            orgAlphaId,
            testWorkspaceRunner,
            async (stage) => {
              if (stage === "after_approval_before_writes") {
                throw new Error("SIMULATED_CRASH");
              }
            }
          ),
        /SIMULATED_CRASH/
      );

      // Simulate external user edit during downtime (diverged from BOTH original AND patched!)
      testWorkspaceRunner.setFile(
        projAlphaId,
        "src/diverge.ts",
        "export const baseVal = 'USER_UNCOMMITTED_EDIT';\n"
      );

      // Attempt recovery: must FAIL CLOSED without overwriting user edit
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
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
              userAdminId,
              orgAlphaId,
              testWorkspaceRunner
            ),
          (err: any) =>
            err instanceof ConflictError &&
            err.message.includes("Recovery aborted: target file 'src/diverge.ts' has diverged")
        );

        // Verify user edit was preserved!
        const preservedContent = await testWorkspaceRunner.readFile(projAlphaId, "src/diverge.ts");
        assert.equal(preservedContent, "export const baseVal = 'USER_UNCOMMITTED_EDIT';\n");

        // Verify journal transitioned to 'recovery_required'
        const jRes = await tx.query<{ status: string }>(
          `SELECT status FROM patch_application_journals WHERE task_id = $1;`,
          [taskAlphaId]
        );
        assert.equal(jRes.rows[0]?.status, "recovery_required");
      });
    });
  });

  // ===========================================================================
  // Suite 5: Fenced Project Isolation & Administrative Workspace Recovery
  // ===========================================================================
  describe("5. Fenced Project Isolation & Administrative Workspace Recovery", () => {
    it("5.1 should block subsequent patch requests on a project fenced with 'recovery_required'", async () => {
      let artifactId = "";
      let approvalId = "";
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const scenario = await setupPatchScenario(
          tx,
          "src/fenced.ts",
          "export const f = 1;\n",
          "export const f = 2;\n"
        );
        artifactId = scenario.artifact.id;
        approvalId = scenario.approval.id;
      });

      // Create a journal row in recovery_required for projAlphaId
      await adminPool.query(
        `
        INSERT INTO patch_application_journals (
          organization_id, project_id, task_id, patch_artifact_id, approval_id,
          target_content_hash, status, baseline_state, created_by
        ) VALUES (
          $1, $2, $3, $4, $5,
          '1111111111111111111111111111111111111111111111111111111111111111',
          'recovery_required', '{}'::jsonb, $6
        );
        `,
        [orgAlphaId, projAlphaId, taskAlphaId, artifactId, approvalId, userAdminId]
      );

      // Attempt to apply a new patch on this project: must fail closed
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        await assert.rejects(
          async () =>
            patchService.checkProjectFenced(tx, orgAlphaId, projAlphaId),
          (err: any) =>
            err instanceof ConflictError &&
            err.message.includes("Project workspace is fenced due to an unrecovered patch failure")
        );
      });
    });

    it("5.2 should perform administrative recovery with 'restore_baseline' and clear project fence", async () => {
      testWorkspaceRunner.setFile(projAlphaId, "src/admin_restore.ts", "const original = 100;\n");

      let journalId = "";
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const { artifact, approval, contentHash } = await setupPatchScenario(
          tx,
          "src/admin_restore.ts",
          "const original = 100;\n",
          "const original = 200;\n"
        );

        // Manually create journal in recovery_required with known baseline
        const jRes = await tx.query<{ id: string }>(
          `INSERT INTO patch_application_journals (
             organization_id, project_id, task_id, patch_artifact_id, approval_id,
             target_content_hash, status, baseline_state, created_by
           ) VALUES (
             $1, $2, $3, $4, $5, $6, 'recovery_required',
             $7::jsonb, $8
           ) RETURNING id;`,
          [
            orgAlphaId,
            projAlphaId,
            taskAlphaId,
            artifact.id,
            approval.id,
            contentHash,
            JSON.stringify({
              targetFiles: ["src/admin_restore.ts"],
              files: {
                "src/admin_restore.ts": {
                  existed: true,
                  contentHash: "hash",
                  content: "const original = 100;\n",
                },
              },
            }),
            userAdminId,
          ]
        );
        journalId = jRes.rows[0].id;

        // Dirty the runner file
        testWorkspaceRunner.setFile(projAlphaId, "src/admin_restore.ts", "corrupted dirty content");

        // Execute administrative recovery
        const adminResult = await patchService.adminRecoverWorkspace(
          tx,
          {
            journalId,
            projectId: projAlphaId,
            resolution: "restore_baseline",
            reason: "Admin manual baseline restore after crash",
            force: true,
          },
          userAdminId,
          orgAlphaId,
          testWorkspaceRunner
        );

        assert.equal(adminResult.success, true);
        assert.equal(adminResult.resolution, "restore_baseline");

        // Verify file was restored to baseline
        const restored = await testWorkspaceRunner.readFile(projAlphaId, "src/admin_restore.ts");
        assert.equal(restored, "const original = 100;\n");

        // Verify journal transitioned to 'recovered'
        const jRes2 = await tx.query<{ status: string }>(
          `SELECT status FROM patch_application_journals WHERE id = $1;`,
          [journalId]
        );
        assert.equal(jRes2.rows[0]?.status, "recovered");

        // Verify project is no longer fenced
        await assert.doesNotReject(async () =>
          patchService.checkProjectFenced(tx, orgAlphaId, projAlphaId)
        );
      });
    });

    it("5.3 should reject administrative recovery by non-admin users (role enforcement)", async () => {
      let artifactId = "";
      let approvalId = "";
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const scenario = await setupPatchScenario(
          tx,
          "src/nonadmin.ts",
          "export const na = 1;\n",
          "export const na = 2;\n"
        );
        artifactId = scenario.artifact.id;
        approvalId = scenario.approval.id;
      });

      let journalId = "";
      await adminPool.query(
        `
        INSERT INTO patch_application_journals (
          organization_id, project_id, task_id, patch_artifact_id, approval_id,
          target_content_hash, status, baseline_state, created_by
        ) VALUES (
          $1, $2, $3, $4, $5,
          '2222222222222222222222222222222222222222222222222222222222222222',
          'recovery_required', '{}'::jsonb, $6
        ) RETURNING id;
        `,
        [orgBetaId, projAlphaId, taskAlphaId, artifactId, approvalId, userBetaId]
      ).then((res) => (journalId = res.rows[0].id));

      // UserBeta is member, not admin or owner
      await withAuthenticatedContext(runtimePool, userBetaId, async (tx) => {
        await assert.rejects(
          async () =>
            patchService.adminRecoverWorkspace(
              tx,
              {
                journalId,
                projectId: projAlphaId,
                resolution: "restore_baseline",
              },
              userBetaId,
              orgBetaId,
              testWorkspaceRunner
            ),
          (err: any) =>
            err instanceof ForbiddenError &&
            err.message.includes("Insufficient permissions")
        );
      });
    });
  });

  // ===========================================================================
  // Suite 6: Concurrency & Race-Condition Serialization on Journal Row Lock
  // ===========================================================================
  describe("6. Concurrency & Race-Condition Serialization on Journal Row Lock", () => {
    it("6.1 should serialize concurrent recovery requests under row locking without corrupting state", async () => {
      let artifactId = "";
      let contentHash = "";

      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const { artifact, contentHash: hash } = await setupPatchScenario(
          tx,
          "src/concurrent_rec.ts",
          "export const conc = 1;\n",
          "export const conc = 2;\n"
        );
        artifactId = artifact.id;
        contentHash = hash;
      });

      // Crash hook after approval to leave journal in 'applying'
      await assert.rejects(
        async () =>
          patchService.applyApprovedPatchDurable(
            runtimePool,
            {
              taskId: taskAlphaId,
              projectId: projAlphaId,
              patchArtifactId: artifactId,
              expectedHash: contentHash,
            },
            userAdminId,
            orgAlphaId,
            testWorkspaceRunner,
            async (stage) => {
              if (stage === "after_approval_before_writes") {
                throw new Error("SIMULATED_CONCURRENT_CRASH");
              }
            }
          ),
        /SIMULATED_CONCURRENT_CRASH/
      );

      // Launch 3 simultaneous recovery requests in parallel across separate pool transactions
      const rec1 = withAuthenticatedContext(runtimePool, userAdminId, (tx) =>
        patchService.recoverInterruptedPatchApplication(
          tx,
          {
            taskId: taskAlphaId,
            projectId: projAlphaId,
            patchArtifactId: artifactId,
            expectedHash: contentHash,
          },
          userAdminId,
          orgAlphaId,
          testWorkspaceRunner,
          { idempotent: true }
        )
      );

      const rec2 = withAuthenticatedContext(runtimePool, userAdminId, (tx) =>
        patchService.recoverInterruptedPatchApplication(
          tx,
          {
            taskId: taskAlphaId,
            projectId: projAlphaId,
            patchArtifactId: artifactId,
            expectedHash: contentHash,
          },
          userAdminId,
          orgAlphaId,
          testWorkspaceRunner,
          { idempotent: true }
        )
      );

      const rec3 = withAuthenticatedContext(runtimePool, userAdminId, (tx) =>
        patchService.recoverInterruptedPatchApplication(
          tx,
          {
            taskId: taskAlphaId,
            projectId: projAlphaId,
            patchArtifactId: artifactId,
            expectedHash: contentHash,
          },
          userAdminId,
          orgAlphaId,
          testWorkspaceRunner,
          { idempotent: true }
        )
      );

      const results = await Promise.all([rec1, rec2, rec3]);

      // All 3 completed safely without throwing deadlock or race exceptions
      assert.equal(results[0].success, true);
      assert.equal(results[1].success, true);
      assert.equal(results[2].success, true);

      // Workspace content matches target exactly
      const finalFile = await testWorkspaceRunner.readFile(projAlphaId, "src/concurrent_rec.ts");
      assert.equal(finalFile, "export const conc = 2;\n");
    });

    it("6.2 should fail closed if task was cancelled and roll back partial writes to baseline", async () => {
      let artifactId = "";
      let contentHash = "";

      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const { artifact, contentHash: hash } = await setupPatchScenario(
          tx,
          "src/cancel_rec.ts",
          "export const cancelTest = 'clean_baseline';\n",
          "export const cancelTest = 'partial_write';\n"
        );
        artifactId = artifact.id;
        contentHash = hash;
      });

      // Crash hook after approval to leave journal in 'applying'
      await assert.rejects(
        async () =>
          patchService.applyApprovedPatchDurable(
            runtimePool,
            {
              taskId: taskAlphaId,
              projectId: projAlphaId,
              patchArtifactId: artifactId,
              expectedHash: contentHash,
            },
            userAdminId,
            orgAlphaId,
            testWorkspaceRunner,
            async (stage) => {
              if (stage === "after_approval_before_writes") {
                throw new Error("CRASH_BEFORE_WRITES");
              }
            }
          ),
        /CRASH_BEFORE_WRITES/
      );

      // Simulate partial write on runner
      testWorkspaceRunner.setFile(
        projAlphaId,
        "src/cancel_rec.ts",
        "export const cancelTest = 'partial_write';\n"
      );

      // Now cancel the task
      await adminPool.query(
        `UPDATE agent_tasks SET status = 'cancelled' WHERE id = $1;`,
        [taskAlphaId]
      );

      // Attempt recovery: must reject because task is cancelled AND rollback runner to baseline!
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
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
              userAdminId,
              orgAlphaId,
              testWorkspaceRunner
            ),
          (err: any) =>
            err instanceof ConflictError &&
            err.message.includes("Cannot recover patch: Task") &&
            err.message.includes("has been cancelled")
        );

        // Verify workspace was rolled back to baseline!
        const restored = await testWorkspaceRunner.readFile(projAlphaId, "src/cancel_rec.ts");
        assert.equal(restored, "export const cancelTest = 'clean_baseline';\n");

        // Verify journal transitioned to 'rolled_back'
        const jRes = await tx.query<{ status: string }>(
          `SELECT status FROM patch_application_journals WHERE task_id = $1;`,
          [taskAlphaId]
        );
        assert.equal(jRes.rows[0]?.status, "rolled_back");
      });
    });
  });

  // ===========================================================================
  // Suite 7: Database Safety & Forced Row-Level Security Verification
  // ===========================================================================
  describe("7. Database Safety & Forced Row-Level Security Verification", () => {
    it("7.1 should verify forced row-level security on public.patch_application_journals", async () => {
      const rlsRes = await adminPool.query<{ relname: string; relforcerowsecurity: boolean; relrowsecurity: boolean }>(
        `
        SELECT c.relname, c.relforcerowsecurity, c.relrowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'patch_application_journals';
        `
      );

      assert.equal(rlsRes.rows.length, 1);
      const table = rlsRes.rows[0];
      assert.equal(table.relrowsecurity, true, "Row level security must be enabled");
      assert.equal(table.relforcerowsecurity, true, "Forced row security must be active");
    });

    it("7.2 should verify cross-tenant journal isolation under RLS", async () => {
      let artifactId = "";
      let approvalId = "";
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const scenario = await setupPatchScenario(
          tx,
          "src/rls.ts",
          "export const r = 1;\n",
          "export const r = 2;\n"
        );
        artifactId = scenario.artifact.id;
        approvalId = scenario.approval.id;
      });

      // Insert journal in Org Alpha
      let journalAlphaId = "";
      await adminPool.query(
        `
        INSERT INTO patch_application_journals (
          organization_id, project_id, task_id, patch_artifact_id, approval_id,
          target_content_hash, status, baseline_state, created_by
        ) VALUES (
          $1, $2, $3, $4, $5,
          '3333333333333333333333333333333333333333333333333333333333333333',
          'applied', '{}'::jsonb, $6
        ) RETURNING id;
        `,
        [orgAlphaId, projAlphaId, taskAlphaId, artifactId, approvalId, userAdminId]
      ).then((res) => (journalAlphaId = res.rows[0].id));

      // UserBeta is in Org Beta only; querying patch_application_journals must return 0 rows
      await withAuthenticatedContext(runtimePool, userBetaId, async (tx) => {
        const queryRes = await tx.query(
          `SELECT id FROM patch_application_journals WHERE id = $1;`,
          [journalAlphaId]
        );
        assert.equal(queryRes.rows.length, 0, "Cross-tenant journal rows must be invisible under RLS");
      });
    });

    it("7.3 should preserve all 16 primary database tables without drops or resets", async () => {
      const tablesRes = await adminPool.query<{ count: number }>(
        `
        SELECT COUNT(*)::int as count
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name != 'schema_migrations';
        `
      );

      assert.equal(tablesRes.rows[0].count, 16, "All 16 tables in public schema must be preserved intact");
    });
  });
});
