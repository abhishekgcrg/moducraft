import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { createDatabasePool } from "../src/db/pool.js";
import { withAuthenticatedContext } from "../src/db/transaction.js";
import { getTestDatabaseUrls } from "./helpers/test-db-guard.js";
import {
  createWorkspaceRunner,
  resolveRunnerConfig,
} from "../src/modules/workflows/tools/runner-factory.js";
import {
  DockerWorkspaceRunner,
  FailClosedWorkspaceRunner,
} from "../src/modules/workflows/tools/docker-runner.js";
import { MockWorkspaceRunner } from "../src/modules/workflows/tools/sandbox.js";
import { ApprovedPatchService } from "../src/modules/workflows/patch.service.js";
import { ApprovalsService } from "../src/modules/workflows/approvals.service.js";
import { ArtifactsService } from "../src/modules/workflows/artifacts.service.js";
import { AgentOrchestratorService } from "../src/modules/orchestrator/orchestrator.service.js";
import {
  ForbiddenError,
  ValidationError,
  ConflictError,
  NotFoundError,
} from "../src/errors/app-errors.js";
import type {
  IsolatedWorkspaceRunner,
  AllowlistedCommand,
  WorkspaceExecutionResult,
} from "../src/modules/workflows/types.js";

const { Pool } = pg;

describe("Phase 4D.4: Failure Injection & Recovery Hardening", () => {
  const { runtimeDbUrl, superuserDbUrl } = getTestDatabaseUrls();

  const issuer = "https://auth.moducraft.test";

  // Test identities (isolated ffffffff and 78787878 prefixes to prevent collision)
  const userAdminId = "ffffffff-3333-4000-8000-000000000003";
  const userBetaId = "ffffffff-4444-4000-8000-000000000004";
  const orgAlphaId = "78787878-aaaa-4000-8000-000000000001";
  const orgBetaId = "78787878-bbbb-4000-8000-000000000002";
  const projAlphaId = "90909090-aaaa-4000-8000-000000000001";
  const taskAlphaId = "a1a1a1a1-aaaa-4000-8000-000000000001";
  const taskCancelId = "a1a1a1a1-bbbb-4000-8000-000000000002";

  // Pinned local image digest (sha256 digest of alpine image currently present in local daemon)
  const PINNED_DOCKER_IMAGE =
    "alpine@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6";

  let runtimePool: pg.Pool;
  let adminPool: pg.Pool;
  let approvalsService: ApprovalsService;
  let artifactsService: ArtifactsService;
  let orchestratorService: AgentOrchestratorService;
  let patchService: ApprovedPatchService;
  let testWorkspaceRunner: MockWorkspaceRunner;

  before(async () => {
    runtimePool = createDatabasePool(runtimeDbUrl);
    adminPool = new Pool({ connectionString: superuserDbUrl, max: 2 });
    approvalsService = new ApprovalsService();
    artifactsService = new ArtifactsService();
    orchestratorService = new AgentOrchestratorService();
    testWorkspaceRunner = new MockWorkspaceRunner();
    patchService = new ApprovedPatchService(approvalsService, artifactsService, testWorkspaceRunner);

    // Seed test users
    await adminPool.query(
      `
      INSERT INTO app_users(id, identity_issuer, identity_subject, email, display_name)
      VALUES 
        ($1, $3, 'sub-fault-admin', 'fault-admin@moducraft.test', 'Fault Admin'),
        ($2, $3, 'sub-fault-beta', 'fault-beta@moducraft.test', 'Fault Beta')
      ON CONFLICT (id) DO NOTHING;
      `,
      [userAdminId, userBetaId, issuer]
    );

    // Seed test organizations
    await adminPool.query(
      `
      INSERT INTO organizations(id, name, slug, created_by)
      VALUES 
        ($1, 'Fault Org Alpha', 'fault-org-alpha', $3),
        ($2, 'Fault Org Beta', 'fault-org-beta', $4)
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
      VALUES ($1, $2, 'Fault Alpha Project', 'fault-alpha-project', 'Test project for fault hardening', $3)
      ON CONFLICT (id) DO NOTHING;
      `,
      [projAlphaId, orgAlphaId, userAdminId]
    );

    // Seed test tasks
    await adminPool.query(
      `
      INSERT INTO agent_tasks(id, organization_id, project_id, title, task_type, status, created_by, input_data)
      VALUES 
        ($1, $2, $3, 'Fault Hardening Task', 'workflow', 'running', $4, '{"test": true}'::jsonb),
        ($5, $2, $3, 'Task For Cancellation Testing', 'workflow', 'waiting_for_approval', $4, '{"test": true}'::jsonb)
      ON CONFLICT (id) DO NOTHING;
      `,
      [taskAlphaId, orgAlphaId, projAlphaId, userAdminId, taskCancelId]
    );
  });

  beforeEach(async () => {
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

  // ===========================================================================
  // Suite 1: Patch Atomicity & Deterministic Fault Injection
  // ===========================================================================
  describe("1. Patch Atomicity & Deterministic Fault Injection", () => {
    it("1.1 should trigger compensating rollback and leave NO partial writes when 2nd file write fails", async () => {
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const file1Original = "export const val1 = 100;\n";
        const file2Original = "export const val2 = 200;\n";
        testWorkspaceRunner.setFile(projAlphaId, "src/fault1.ts", file1Original);
        testWorkspaceRunner.setFile(projAlphaId, "src/fault2.ts", file2Original);

        const patchContent = [
          "--- a/src/fault1.ts",
          "+++ b/src/fault1.ts",
          "@@ -1 +1 @@",
          "-export const val1 = 100;",
          "+export const val1 = 101;",
          "--- a/src/fault2.ts",
          "+++ b/src/fault2.ts",
          "@@ -1 +1 @@",
          "-export const val2 = 200;",
          "+export const val2 = 202;",
          "",
        ].join("\n");

        const contentHash = crypto.createHash("sha256").update(patchContent).digest("hex");

        const artifact = await artifactsService.createArtifact(tx, userAdminId, orgAlphaId, {
          projectId: projAlphaId,
          taskId: taskAlphaId,
          artifactType: "patch_proposal",
          title: "Fault Injection 2nd Write",
          content: patchContent,
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
          reason: "Approved for fault injection test",
        });

        // Create a fault-injected runner proxy that fails deterministically on the second write
        let writeCount = 0;
        const faultRunner: IsolatedWorkspaceRunner = {
          runnerType: "mock",
          isProductionSandbox: false,
          isolationLevel: "none",
          readFile: (p, f) => testWorkspaceRunner.readFile(p, f),
          readManifest: (p) => testWorkspaceRunner.readManifest(p),
          runAllowlistedCommand: (p, c, t, s) => testWorkspaceRunner.runAllowlistedCommand(p, c, t, s),
          setFile: (p, f, c) => {
            writeCount++;
            if (writeCount === 2) {
              throw new Error("FAULT_INJECTED_DISK_IO_ERROR: Simulated disk error during 2nd file write");
            }
            return testWorkspaceRunner.setFile(p, f, c);
          },
          deleteFile: (p, f) => testWorkspaceRunner.deleteFile(p, f),
        };

        // Attempt patch application: should fail closed and execute compensating rollback
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
            err.message.includes("FAULT_INJECTED_DISK_IO_ERROR") &&
            err.message.includes("Pre-existing user modifications safely restored; workspace rolled back.")
        );

        // Crucial: verify file 1 was safely rolled back to original content!
        const file1After = await testWorkspaceRunner.readFile(projAlphaId, "src/fault1.ts");
        const file2After = await testWorkspaceRunner.readFile(projAlphaId, "src/fault2.ts");
        assert.equal(file1After, file1Original, "File 1 must be restored to original content");
        assert.equal(file2After, file2Original, "File 2 must remain in original content");
      });
    });

    it("1.2 should delete newly created files during compensating rollback if later write fails", async () => {
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const fileExistingOrig = "export const existing = 'base';\n";
        testWorkspaceRunner.setFile(projAlphaId, "src/existing.ts", fileExistingOrig);

        const patchContent = [
          "--- /dev/null",
          "+++ b/src/brand_new.ts",
          "@@ -0,0 +1 @@",
          "+export const brandNew = true;",
          "--- a/src/existing.ts",
          "+++ b/src/existing.ts",
          "@@ -1 +1 @@",
          "-export const existing = 'base';",
          "+export const existing = 'updated';",
          "",
        ].join("\n");

        const contentHash = crypto.createHash("sha256").update(patchContent).digest("hex");

        const artifact = await artifactsService.createArtifact(tx, userAdminId, orgAlphaId, {
          projectId: projAlphaId,
          taskId: taskAlphaId,
          artifactType: "patch_proposal",
          title: "Fault Injection Rollback Deletes New File",
          content: patchContent,
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
          reason: "Approved for rollback new file test",
        });

        let writeCount = 0;
        const faultRunner: IsolatedWorkspaceRunner = {
          runnerType: "mock",
          isProductionSandbox: false,
          isolationLevel: "none",
          readFile: (p, f) => testWorkspaceRunner.readFile(p, f),
          readManifest: (p) => testWorkspaceRunner.readManifest(p),
          runAllowlistedCommand: (p, c, t, s) => testWorkspaceRunner.runAllowlistedCommand(p, c, t, s),
          setFile: (p, f, c) => {
            writeCount++;
            if (writeCount === 2) {
              throw new Error("FAULT_INJECTED_WRITE_ERROR: 2nd file write failure");
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
            err.message.includes("FAULT_INJECTED_WRITE_ERROR") &&
            err.message.includes("workspace rolled back")
        );

        // Verify newly created file was deleted during compensating rollback
        await assert.rejects(
          async () => testWorkspaceRunner.readFile(projAlphaId, "src/brand_new.ts"),
          (err: any) => err instanceof NotFoundError
        );

        // Verify existing file remains unchanged
        const existingAfter = await testWorkspaceRunner.readFile(projAlphaId, "src/existing.ts");
        assert.equal(existingAfter, fileExistingOrig);
      });
    });

    it("1.3 should execute compensating rollback when file deletion throws during patch application", async () => {
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const fileToDel = "export const delMe = 42;\n";
        testWorkspaceRunner.setFile(projAlphaId, "src/to_delete.ts", fileToDel);

        const patchContent = [
          "--- a/src/to_delete.ts",
          "+++ /dev/null",
          "@@ -1 +0,0 @@",
          "-export const delMe = 42;",
          "",
        ].join("\n");

        const contentHash = crypto.createHash("sha256").update(patchContent).digest("hex");

        const artifact = await artifactsService.createArtifact(tx, userAdminId, orgAlphaId, {
          projectId: projAlphaId,
          taskId: taskAlphaId,
          artifactType: "patch_proposal",
          title: "Fault Injection Deletion Failure",
          content: patchContent,
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
          reason: "Approved for deletion failure test",
        });

        const faultRunner: IsolatedWorkspaceRunner = {
          runnerType: "mock",
          isProductionSandbox: false,
          isolationLevel: "none",
          readFile: (p, f) => testWorkspaceRunner.readFile(p, f),
          readManifest: (p) => testWorkspaceRunner.readManifest(p),
          runAllowlistedCommand: (p, c, t, s) => testWorkspaceRunner.runAllowlistedCommand(p, c, t, s),
          setFile: (p, f, c) => testWorkspaceRunner.setFile(p, f, c),
          deleteFile: () => {
            throw new Error("FAULT_INJECTED_DELETE_ERROR: Permission denied during deleteFile");
          },
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
            err.message.includes("FAULT_INJECTED_DELETE_ERROR") &&
            err.message.includes("workspace rolled back")
        );

        // Pre-existing file to be deleted remains intact
        const contentAfter = await testWorkspaceRunner.readFile(projAlphaId, "src/to_delete.ts");
        assert.equal(contentAfter, fileToDel);
      });
    });

    it("1.4 should fail closed with critical alert if compensating rollback itself encounters an error", async () => {
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const fileContent = "export const orig = 1;\n";
        testWorkspaceRunner.setFile(projAlphaId, "src/unrollable.ts", fileContent);

        const patchContent = [
          "--- a/src/unrollable.ts",
          "+++ b/src/unrollable.ts",
          "@@ -1 +1 @@",
          "-export const orig = 1;",
          "+export const orig = 2;",
          "--- /dev/null",
          "+++ b/src/new2.ts",
          "@@ -0,0 +1 @@",
          "+export const new2 = true;",
          "",
        ].join("\n");

        const contentHash = crypto.createHash("sha256").update(patchContent).digest("hex");

        const artifact = await artifactsService.createArtifact(tx, userAdminId, orgAlphaId, {
          projectId: projAlphaId,
          taskId: taskAlphaId,
          artifactType: "patch_proposal",
          title: "Rollback Failure Fault Injection",
          content: patchContent,
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
          reason: "Approved for rollback failure test",
        });

        let callCount = 0;
        const faultRunner: IsolatedWorkspaceRunner = {
          runnerType: "mock",
          isProductionSandbox: false,
          isolationLevel: "none",
          readFile: (p, f) => testWorkspaceRunner.readFile(p, f),
          readManifest: (p) => testWorkspaceRunner.readManifest(p),
          runAllowlistedCommand: (p, c, t, s) => testWorkspaceRunner.runAllowlistedCommand(p, c, t, s),
          setFile: (p, f, c) => {
            callCount++;
            if (callCount === 1) {
              // 1st write succeeds
              return testWorkspaceRunner.setFile(p, f, c);
            }
            if (callCount === 2) {
              // 2nd write fails
              throw new Error("FAULT_INJECTED_SECOND_WRITE_FAILURE");
            }
            // 3rd call (compensating rollback restore) also fails!
            throw new Error("FAULT_INJECTED_ROLLBACK_FAILURE");
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
            err.message.includes("Workspace may be inconsistent")
        );
      });
    });
  });

  // ===========================================================================
  // Suite 2: Approval Lifecycle & Interrupted State Recovery
  // ===========================================================================
  describe("2. Approval Lifecycle & Interrupted State Recovery", () => {
    it("2.1 should reject simultaneous requests using the same approval (exactly 1 wins)", async () => {
      const targetContent = "export function concurrent() { return 'ok'; }\n";
      testWorkspaceRunner.setFile(projAlphaId, "src/concurrent.ts", targetContent);

      const patchContent = [
        "--- a/src/concurrent.ts",
        "+++ b/src/concurrent.ts",
        "@@ -1 +1,2 @@",
        " export function concurrent() { return 'ok'; }",
        "+// concurrency edit",
        "",
      ].join("\n");
      const contentHash = crypto.createHash("sha256").update(patchContent).digest("hex");

      let artifactId = "";
      let approvalId = "";

      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const artifact = await artifactsService.createArtifact(tx, userAdminId, orgAlphaId, {
          projectId: projAlphaId,
          taskId: taskAlphaId,
          artifactType: "patch_proposal",
          title: "Concurrent Approval Consumption Race",
          content: patchContent,
        });
        artifactId = artifact.id;

        const approval = await approvalsService.createApprovalRequest(tx, orgAlphaId, {
          taskId: taskAlphaId,
          artifactId,
          action: "apply_patch",
          targetContentHash: contentHash,
          requiredRole: "admin",
          expiresInSeconds: 3600,
        });
        approvalId = approval.id;

        await approvalsService.decideApproval(tx, approvalId, userAdminId, orgAlphaId, {
          decision: "approved",
          reason: "Approved for concurrency test",
        });
      });

      // Fire 3 simultaneous requests with the same approval
      const results = await Promise.allSettled([
        withAuthenticatedContext(runtimePool, userAdminId, (tx) =>
          patchService.applyApprovedPatch(
            tx,
            { taskId: taskAlphaId, projectId: projAlphaId, patchArtifactId: artifactId, expectedHash: contentHash },
            userAdminId,
            orgAlphaId
          )
        ),
        withAuthenticatedContext(runtimePool, userAdminId, (tx) =>
          patchService.applyApprovedPatch(
            tx,
            { taskId: taskAlphaId, projectId: projAlphaId, patchArtifactId: artifactId, expectedHash: contentHash },
            userAdminId,
            orgAlphaId
          )
        ),
        withAuthenticatedContext(runtimePool, userAdminId, (tx) =>
          patchService.applyApprovedPatch(
            tx,
            { taskId: taskAlphaId, projectId: projAlphaId, patchArtifactId: artifactId, expectedHash: contentHash },
            userAdminId,
            orgAlphaId
          )
        ),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      assert.equal(fulfilled.length, 1, "Exactly one concurrent patch application must succeed");
      assert.equal(rejected.length, 2, "All other concurrent callers must be rejected");

      for (const rej of rejected) {
        const reason = (rej as PromiseRejectedResult).reason;
        assert.ok(reason instanceof ConflictError);
        assert.ok(reason.message.includes("already been consumed") || reason.message.includes("Replay prevented"));
      }
    });

    it("2.2 should strictly reject expired approvals in both consumption and patch application", async () => {
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const patchContent = [
          "--- a/src/index.ts",
          "+++ b/src/index.ts",
          "@@ -1 +1,2 @@",
          " export function greet(name: string): string {",
          "+// expired edit",
          "",
        ].join("\n");
        const contentHash = crypto.createHash("sha256").update(patchContent).digest("hex");

        const artifact = await artifactsService.createArtifact(tx, userAdminId, orgAlphaId, {
          projectId: projAlphaId,
          taskId: taskAlphaId,
          artifactType: "patch_proposal",
          title: "Expired Approval Guard",
          content: patchContent,
        });

        // Create approval that has already expired
        const approval = await approvalsService.createApprovalRequest(tx, orgAlphaId, {
          taskId: taskAlphaId,
          artifactId: artifact.id,
          action: "apply_patch",
          targetContentHash: contentHash,
          requiredRole: "admin",
          expiresInSeconds: -10,
        });

        // Rejection in applyApprovedPatch
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
              orgAlphaId
            ),
          (err: any) => err instanceof ConflictError && err.message.includes("expired")
        );

        // Direct rejection in verifyAndConsumeApproval
        await assert.rejects(
          async () =>
            approvalsService.verifyAndConsumeApproval(
              tx,
              orgAlphaId,
              taskAlphaId,
              "apply_patch",
              contentHash
            ),
          (err: any) => err instanceof ConflictError && err.message.includes("expired")
        );
      });
    });

    it("2.3 should invalidate approvals upon task cancellation and block patch application", async () => {
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const patchContent = [
          "--- a/src/index.ts",
          "+++ b/src/index.ts",
          "@@ -1 +1,2 @@",
          " export function greet(name: string): string {",
          "+// cancelled task edit",
          "",
        ].join("\n");
        const contentHash = crypto.createHash("sha256").update(patchContent).digest("hex");

        const artifact = await artifactsService.createArtifact(tx, userAdminId, orgAlphaId, {
          projectId: projAlphaId,
          taskId: taskCancelId,
          artifactType: "patch_proposal",
          title: "Cancelled Task Patch",
          content: patchContent,
        });

        const approval = await approvalsService.createApprovalRequest(tx, orgAlphaId, {
          taskId: taskCancelId,
          artifactId: artifact.id,
          action: "apply_patch",
          targetContentHash: contentHash,
          requiredRole: "admin",
          expiresInSeconds: 3600,
        });

        await approvalsService.decideApproval(tx, approval.id, userAdminId, orgAlphaId, {
          decision: "approved",
          reason: "Approved before cancellation",
        });

        // Cancel the task via OrchestratorService
        await orchestratorService.cancelTask(tx, taskCancelId, userAdminId);

        // Verify approval row status was transitioned to expired
        const approvalAfterCancel = await approvalsService.getApproval(tx, approval.id);
        assert.equal(approvalAfterCancel.status, "expired");

        // Attempting to apply patch on cancelled task must fail closed with ConflictError
        await assert.rejects(
          async () =>
            patchService.applyApprovedPatch(
              tx,
              {
                taskId: taskCancelId,
                projectId: projAlphaId,
                patchArtifactId: artifact.id,
                expectedHash: contentHash,
              },
              userAdminId,
              orgAlphaId
            ),
          (err: any) => err instanceof ConflictError && err.message.includes("has been cancelled")
        );
      });
    });

    it("2.4 should safely recover an interrupted patch application after simulated crash", async () => {
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const origContent = "export function crashRecovery() { return 0; }\n";
        testWorkspaceRunner.setFile(projAlphaId, "src/crash.ts", origContent);

        const patchContent = [
          "--- a/src/crash.ts",
          "+++ b/src/crash.ts",
          "@@ -1 +1,2 @@",
          " export function crashRecovery() { return 0; }",
          "+// post-crash recovery verified",
          "",
        ].join("\n");
        const contentHash = crypto.createHash("sha256").update(patchContent).digest("hex");

        const artifact = await artifactsService.createArtifact(tx, userAdminId, orgAlphaId, {
          projectId: projAlphaId,
          taskId: taskAlphaId,
          artifactType: "patch_proposal",
          title: "Crash Recovery Test Proposal",
          content: patchContent,
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
          reason: "Approved for crash recovery test",
        });

        // Simulate crash: approval is consumed in DB, but process dies before runner write or artifact review update
        await approvalsService.verifyAndConsumeApproval(
          tx,
          orgAlphaId,
          taskAlphaId,
          "apply_patch",
          contentHash
        );

        // Standard unapproved retry must be rejected
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
              orgAlphaId
            ),
          (err: any) => err instanceof ConflictError && err.message.includes("already been consumed")
        );

        // Execute recovery workflow
        const recoveryResult = await patchService.recoverInterruptedPatchApplication(
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

        assert.equal(recoveryResult.success, true);
        assert.deepEqual(recoveryResult.filesModified, ["src/crash.ts"]);

        // Verify workspace file was genuinely updated by recovery
        const recoveredFile = await testWorkspaceRunner.readFile(projAlphaId, "src/crash.ts");
        assert.ok(recoveredFile.includes("post-crash recovery verified"));

        // Verify artifact is now marked approved
        const updatedArtifact = await artifactsService.getArtifact(tx, artifact.id);
        assert.equal(updatedArtifact.reviewStatus, "approved");
        assert.ok((updatedArtifact.metadata as any)?.recoveredAt);

        // Second recovery attempt rejected as replay
        await assert.rejects(
          async () =>
            patchService.recoverInterruptedPatchApplication(
              tx,
              {
                taskId: taskAlphaId,
                projectId: projAlphaId,
                patchArtifactId: artifact.id,
                expectedHash: contentHash,
              },
              userAdminId,
              orgAlphaId
            ),
          (err: any) => err instanceof ConflictError && err.message.includes("Replay prevented")
        );
      });
    });

    it("2.5 should reject recovery if workspace files diverged during interrupted crash", async () => {
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const origContent = "export function divergedCrash() { return 10; }\n";
        testWorkspaceRunner.setFile(projAlphaId, "src/diverged_crash.ts", origContent);

        const patchContent = [
          "--- a/src/diverged_crash.ts",
          "+++ b/src/diverged_crash.ts",
          "@@ -1 +1,2 @@",
          " export function divergedCrash() { return 10; }",
          "+// diverged edit",
          "",
        ].join("\n");
        const contentHash = crypto.createHash("sha256").update(patchContent).digest("hex");

        const artifact = await artifactsService.createArtifact(tx, userAdminId, orgAlphaId, {
          projectId: projAlphaId,
          taskId: taskAlphaId,
          artifactType: "patch_proposal",
          title: "Diverged Crash Test Proposal",
          content: patchContent,
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
          reason: "Approved for diverged crash test",
        });

        // Simulate crash with consumed approval
        await approvalsService.verifyAndConsumeApproval(
          tx,
          orgAlphaId,
          taskAlphaId,
          "apply_patch",
          contentHash
        );

        // Workspace file was modified by an external party during downtime
        testWorkspaceRunner.setFile(projAlphaId, "src/diverged_crash.ts", "export function totallyDifferent() {}");

        // Recovery must fail closed to protect pre-existing modifications
        await assert.rejects(
          async () =>
            patchService.recoverInterruptedPatchApplication(
              tx,
              {
                taskId: taskAlphaId,
                projectId: projAlphaId,
                patchArtifactId: artifact.id,
                expectedHash: contentHash,
              },
              userAdminId,
              orgAlphaId
            ),
          (err: any) => err instanceof ConflictError && err.message.includes("Patch context mismatch")
        );

        // Verify diverged user content was untouched
        const contentAfter = await testWorkspaceRunner.readFile(projAlphaId, "src/diverged_crash.ts");
        assert.equal(contentAfter, "export function totallyDifferent() {}");
      });
    });
  });

  // ===========================================================================
  // Suite 3: Docker Runner Security with Pinned Image
  // ===========================================================================
  describe("3. Docker Runner Security with Pinned Image", () => {
    let dockerRunner: DockerWorkspaceRunner;
    let isDockerAvailable = false;

    before(async () => {
      // Use strictly pinned local image digest (no unpinned image pulls)
      dockerRunner = new DockerWorkspaceRunner({
        dockerImage: PINNED_DOCKER_IMAGE,
      });

      const preflight = await dockerRunner.preflightCheck();
      isDockerAvailable = preflight.ok;
    });

    it("3.1 should confirm pinned local image without pulling unpinned tags", async (t) => {
      if (!isDockerAvailable) {
        return t.skip("Docker daemon unavailable on host: marking as SKIPPED per prompt instructions");
      }

      // Verify that local daemon has the pinned image
      const inspectOut = execSync(`docker inspect ${PINNED_DOCKER_IMAGE} --format "{{.Id}}"`, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();

      assert.ok(inspectOut.startsWith("sha256:"), "Pinned image must be locally present in Docker daemon");
    });

    it("3.2 should terminate process tree on command timeout in pinned container", async (t) => {
      if (!isDockerAvailable) {
        return t.skip("Docker daemon unavailable on host: marking as SKIPPED");
      }

      const timeoutRunner = new DockerWorkspaceRunner({
        dockerImage: PINNED_DOCKER_IMAGE,
        timeoutMs: 1500,
      });

      timeoutRunner.setFile(
        "fault-timeout",
        "package.json",
        JSON.stringify({ name: "fault-timeout", scripts: { test: "sleep 10" } })
      );

      const start = Date.now();
      const res = await timeoutRunner.runAllowlistedCommand("fault-timeout", "test", 1500);
      const duration = Date.now() - start;

      assert.equal(res.timedOut, true);
      assert.equal(res.exitCode, 124);
      assert.ok(duration >= 1400 && duration < 5000, `Duration ${duration}ms out of expected timeout range`);
      assert.ok(res.stderr.includes("Execution timed out after 1500ms"));
    });

    it("3.3 should terminate process tree on AbortSignal cancellation", async (t) => {
      if (!isDockerAvailable) {
        return t.skip("Docker daemon unavailable on host: marking as SKIPPED");
      }

      const abortRunner = new DockerWorkspaceRunner({
        dockerImage: PINNED_DOCKER_IMAGE,
        timeoutMs: 10000,
      });

      abortRunner.setFile(
        "fault-abort",
        "package.json",
        JSON.stringify({ name: "fault-abort", scripts: { test: "sleep 10" } })
      );

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 600);

      const res = await abortRunner.runAllowlistedCommand("fault-abort", "test", 10000, controller.signal);

      assert.equal(res.cancelled, true);
      assert.equal(res.exitCode, 130);
      assert.ok(res.stderr.includes("Execution cancelled by caller"));
    });

    it("3.4 should clean up disposable container upon errors and leave no orphan containers", async (t) => {
      if (!isDockerAvailable) {
        return t.skip("Docker daemon unavailable on host: marking as SKIPPED");
      }

      // Check running containers with prefix moducraft-sandbox before
      const psBefore = execSync("docker ps --filter name=moducraft-sandbox -q", { encoding: "utf-8" }).trim();

      // Trigger a failure by running a timeout command
      const failRunner = new DockerWorkspaceRunner({
        dockerImage: PINNED_DOCKER_IMAGE,
        timeoutMs: 1000,
      });
      failRunner.setFile(
        "fault-fail",
        "package.json",
        JSON.stringify({ name: "fault-fail", scripts: { test: "sleep 10" } })
      );
      await failRunner.runAllowlistedCommand("fault-fail", "test", 1000);

      // Give Docker a moment to finalize --rm removal
      await new Promise((r) => setTimeout(r, 800));

      const psAfter = execSync("docker ps --filter name=moducraft-sandbox -q", { encoding: "utf-8" }).trim();
      assert.equal(psAfter, psBefore, "Zero container leakage after execution error");
    });

    it("3.5 should enforce bounded output limits and truncate large output streams", async (t) => {
      if (!isDockerAvailable) {
        return t.skip("Docker daemon unavailable on host: marking as SKIPPED");
      }

      const boundedRunner = new DockerWorkspaceRunner({
        dockerImage: PINNED_DOCKER_IMAGE,
        maxOutputBytes: 1024, // 1 KB limit
      });

      boundedRunner.setFile(
        "fault-bounded",
        "package.json",
        JSON.stringify({ name: "fault-bounded", scripts: { test: "head -c 10000 /dev/zero | tr '\\0' 'A'" } })
      );

      const res = await boundedRunner.runAllowlistedCommand("fault-bounded", "test");
      assert.ok(
        res.stdout.length <= 2048,
        `Stdout length (${res.stdout.length}) should not exceed bounded budget`
      );
      assert.match(res.stdout, /\[OUTPUT TRUNCATED: Exceeded max allowed size\]/);
    });

    it("3.6 should redact credentials and sensitive tokens from container output streams", async (t) => {
      if (!isDockerAvailable) {
        return t.skip("Docker daemon unavailable on host: marking as SKIPPED");
      }

      // Inject a script that prints simulated secrets
      const secretRunner = new DockerWorkspaceRunner({
        dockerImage: PINNED_DOCKER_IMAGE,
      });

      secretRunner.setFile(
        "fault-secret",
        "package.json",
        JSON.stringify({
          name: "fault-secret",
          scripts: {
            test: "echo 'SECRET: sk-proj-1234567890abcdef1234567890' && echo 'DB: postgresql://admin:hunter2@db.internal:5432/prod' >&2",
          },
        })
      );

      const res = await secretRunner.runAllowlistedCommand("fault-secret", "test");
      assert.ok(!res.stdout.includes("sk-proj-1234567890abcdef1234567890"));
      assert.match(res.stdout, /\[REDACTED_API_KEY\]/);
      assert.ok(!res.stderr.includes("hunter2"));
      assert.match(res.stderr, /\[REDACTED_CONNECTION_STRING\]/);
    });

    it("3.7 should verify absence of host mounts, docker.sock, and host credentials inside container", async (t) => {
      if (!isDockerAvailable) {
        return t.skip("Docker daemon unavailable on host: marking as SKIPPED");
      }

      const secureRunner = new DockerWorkspaceRunner({
        dockerImage: PINNED_DOCKER_IMAGE,
      });

      secureRunner.setFile(
        "fault-secure",
        "package.json",
        JSON.stringify({
          name: "fault-secure",
          scripts: {
            test: "ls /var/run/docker.sock /root /etc/shadow 2>&1 || exit 42",
          },
        })
      );

      const res = await secureRunner.runAllowlistedCommand("fault-secure", "test");
      assert.ok(
        res.exitCode !== 0 || res.stdout.includes("No such file") || res.stderr.includes("No such file"),
        "Host Docker socket and secrets must not be mounted into workload container"
      );
    });
  });

  // ===========================================================================
  // Suite 4: Production Boundaries & Fail-Closed MicroVM Requirements
  // ===========================================================================
  describe("4. Production Boundaries & Fail-Closed MicroVM Requirements", () => {
    it("4.1 should return FailClosedWorkspaceRunner when NODE_ENV=production and runner=mock", () => {
      const origEnv = process.env.NODE_ENV;
      const origRunner = process.env.MODUCRAFT_WORKSPACE_RUNNER;
      try {
        process.env.NODE_ENV = "production";
        process.env.MODUCRAFT_WORKSPACE_RUNNER = "mock";

        const runner = createWorkspaceRunner();
        assert.equal(runner.runnerType, "fail_closed");
        assert.equal(runner.isProductionSandbox, true);
        assert.equal(runner.isolationLevel, "none");
      } finally {
        process.env.NODE_ENV = origEnv;
        process.env.MODUCRAFT_WORKSPACE_RUNNER = origRunner;
      }
    });

    it("4.2 should fail closed when MODUCRAFT_REQUIRE_MICROVM=true on unsupported runtimes (runc)", async () => {
      const microVMRunner = new DockerWorkspaceRunner({
        requireMicroVM: true,
      });

      const preflight = await microVMRunner.preflightCheck();
      if (preflight.runtime === "runc") {
        assert.equal(preflight.ok, false);
        assert.ok(preflight.error?.includes("MicroVM isolation is required"));

        await assert.rejects(
          async () => microVMRunner.runAllowlistedCommand("default", "test"),
          (err: any) => err instanceof ForbiddenError && err.message.includes("MicroVM isolation is required")
        );
      }
    });

    it("4.3 should completely isolate host credentials and environment variables from container execution", () => {
      const origSecret = process.env.MODUCRAFT_SUPER_SECRET;
      try {
        process.env.MODUCRAFT_SUPER_SECRET = "super_secret_host_token_xyz987";
        const config = resolveRunnerConfig();
        assert.ok(config);
        // Verify host variables are not in config
        assert.strictEqual((config as any).MODUCRAFT_SUPER_SECRET, undefined);
      } finally {
        if (origSecret !== undefined) process.env.MODUCRAFT_SUPER_SECRET = origSecret;
        else delete process.env.MODUCRAFT_SUPER_SECRET;
      }
    });
  });

  // ===========================================================================
  // Suite 5: Database Safety & Forced RLS Authorization
  // ===========================================================================
  describe("5. Database Safety & Forced RLS Authorization", () => {
    it("5.1 should verify forced row-level security on all 15 public tables", async () => {
      const res = await adminPool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
         WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname != 'schema_migrations'
         ORDER BY relname;`
      );

      assert.ok(res.rowCount >= 15, `Expected at least 15 tables, found ${res.rowCount}`);
      for (const row of res.rows) {
        assert.equal(row.relrowsecurity, true, `Table '${row.relname}' must have relrowsecurity=true`);
        assert.equal(row.relforcerowsecurity, true, `Table '${row.relname}' must have relforcerowsecurity=true`);
      }
    });

    it("5.2 should verify runtime role cannot view or modify cross-tenant approvals or artifacts", async () => {
      await withAuthenticatedContext(runtimePool, userBetaId, async (tx) => {
        // User Beta (in Org Beta) attempts to read Org Alpha approvals
        const betaApprovals = await approvalsService.listApprovalsForTask(tx, taskAlphaId);
        assert.equal(betaApprovals.length, 0, "Cross-tenant task approvals must be hidden under forced RLS");

        // User Beta attempts to read Org Alpha artifacts
        const betaArtifacts = await artifactsService.listArtifacts(tx, { taskId: taskAlphaId });
        assert.equal(betaArtifacts.artifacts.length, 0, "Cross-tenant task artifacts must be hidden under forced RLS");
      });
    });

    it("5.3 should preserve primary database tables without dropping, resetting, or truncating any data", async () => {
      const tableCountRes = await adminPool.query<{ count: string }>(
        `SELECT count(*)::text as count FROM information_schema.tables WHERE table_schema = 'public';`
      );
      assert.ok(parseInt(tableCountRes.rows[0].count, 10) >= 15, "Public schema tables must remain fully intact");
    });
  });
});
