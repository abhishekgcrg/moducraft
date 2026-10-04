import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import * as jose from "jose";
import { buildApp } from "../src/app.js";
import { JoseJwtVerifier } from "../src/auth/verifier.js";
import { withAuthenticatedContext } from "../src/db/transaction.js";
import {
  getTestDatabaseUrls,
  getDisposableDatabaseUrl,
  getAdminRootDatabaseUrl,
} from "./helpers/test-db-guard.js";
import {
  ApprovedPatchService,
  MAX_BASELINE_FILE_SIZE_BYTES,
  MAX_PATCH_FILE_COUNT,
  MAX_PATCH_DIFF_SIZE_BYTES,
  MAX_AGGREGATE_BASELINE_SIZE_BYTES,
} from "../src/modules/workflows/patch.service.js";
import { ApprovalsService } from "../src/modules/workflows/approvals.service.js";
import { ArtifactsService } from "../src/modules/workflows/artifacts.service.js";
import {
  MigrationManager,
  MigrationChecksumDriftError,
  MigrationExecutionError,
} from "../src/db/migration-manager.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../src/errors/app-errors.js";
import type {
  IsolatedWorkspaceRunner,
  PatchApplicationJournalDto,
} from "../src/modules/workflows/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In-memory test workspace runner
class MockWorkspaceRunner implements IsolatedWorkspaceRunner {
  private files = new Map<string, Map<string, string>>();

  setFile(projectId: string, filePath: string, content: string): void {
    if (!this.files.has(projectId)) this.files.set(projectId, new Map());
    this.files.get(projectId)!.set(filePath, content);
  }

  async readFile(projectId: string, filePath: string): Promise<string> {
    const projectFiles = this.files.get(projectId);
    if (!projectFiles || !projectFiles.has(filePath)) {
      throw new NotFoundError(`File '${filePath}' not found in workspace.`);
    }
    return projectFiles.get(filePath)!;
  }

  async writeFile(projectId: string, filePath: string, content: string): Promise<void> {
    if (!this.files.has(projectId)) this.files.set(projectId, new Map());
    this.files.get(projectId)!.set(filePath, content);
  }

  async deleteFile(projectId: string, filePath: string): Promise<void> {
    const projectFiles = this.files.get(projectId);
    if (projectFiles) {
      projectFiles.delete(filePath);
    }
  }

  async executeCommand(): Promise<any> {
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

describe("Phase 4D.7: Independent Adversarial Verification & Recovery Authorization", () => {
  let app: FastifyInstance;
  let adminPool: pg.Pool;
  let runtimePool: pg.Pool;
  let approvalsService: ApprovalsService;
  let artifactsService: ArtifactsService;
  let patchService: ApprovedPatchService;
  let testRunner: MockWorkspaceRunner;

  const secretKey = "test-secret-key-at-least-32-chars-long!";
  const issuer = "https://auth.moducraft.test";
  const audience = "moducraft-api";

  // Identifiers for Org Alpha and Org Beta
  const orgAlphaId = "a0000000-0000-4000-8000-000000000001";
  const orgBetaId = "b0000000-0000-4000-8000-000000000002";

  const userOwnerId = "10000000-0000-4000-8000-000000000001";
  const userAdminId = "10000000-0000-4000-8000-000000000002";
  const userMemberId = "10000000-0000-4000-8000-000000000003";
  const userBetaAdminId = "20000000-0000-4000-8000-000000000001";

  const projAlphaId = "30000000-0000-4000-8000-000000000001";
  const projBetaId = "40000000-0000-4000-8000-000000000001";

  const taskAlphaId = "50000000-0000-4000-8000-000000000001";

  async function createToken(sub: string, email: string): Promise<string> {
    const rawSecret = new TextEncoder().encode(secretKey);
    return new jose.SignJWT({ iss: issuer, aud: audience, sub, email })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(rawSecret);
  }

  before(async () => {
    const { runtimeDbUrl, superuserDbUrl } = getTestDatabaseUrls();

    adminPool = new pg.Pool({
      connectionString: superuserDbUrl,
    });

    runtimePool = new pg.Pool({
      connectionString: runtimeDbUrl,
    });

    approvalsService = new ApprovalsService();
    artifactsService = new ArtifactsService();
    testRunner = new MockWorkspaceRunner();
    patchService = new ApprovedPatchService(approvalsService, artifactsService, testRunner);

    // Setup base users, tenants, and projects
    await adminPool.query(
      `INSERT INTO app_users (id, identity_issuer, identity_subject, email, display_name)
       VALUES ($1, $2, $3, $4, 'Alpha Owner'),
              ($5, $2, $6, $7, 'Alpha Admin'),
              ($8, $2, $9, $10, 'Alpha Member'),
              ($11, $2, $12, $13, 'Beta Admin')
       ON CONFLICT (id) DO NOTHING;`,
      [
        userOwnerId, issuer, userOwnerId, "alpha-owner@example.com",
        userAdminId, userAdminId, "alpha-admin@example.com",
        userMemberId, userMemberId, "alpha-member@example.com",
        userBetaAdminId, userBetaAdminId, "beta-admin@example.com",
      ]
    );

    await adminPool.query(
      `INSERT INTO organizations (id, name, slug, created_by)
       VALUES ($1, 'Alpha Org', 'alpha-org-4d7', $3),
              ($2, 'Beta Org', 'beta-org-4d7', $4)
       ON CONFLICT (id) DO NOTHING;`,
      [orgAlphaId, orgBetaId, userOwnerId, userBetaAdminId]
    );

    await adminPool.query(
      `INSERT INTO organization_memberships (organization_id, user_id, role)
       VALUES ($1, $2, 'owner'),
              ($1, $3, 'admin'),
              ($1, $4, 'member'),
              ($5, $6, 'admin')
       ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role;`,
      [orgAlphaId, userOwnerId, userAdminId, userMemberId, orgBetaId, userBetaAdminId]
    );

    await adminPool.query(
      `INSERT INTO projects (id, organization_id, name, slug, created_by)
       VALUES ($1, $2, 'Project Alpha', 'proj-alpha-4d7', $3),
              ($4, $5, 'Project Beta', 'proj-beta-4d7', $6)
       ON CONFLICT (id) DO NOTHING;`,
      [projAlphaId, orgAlphaId, userAdminId, projBetaId, orgBetaId, userBetaAdminId]
    );

    await adminPool.query(
      `INSERT INTO agent_tasks (id, organization_id, project_id, title, task_type, status, created_by, input_data)
       VALUES ($1, $2, $3, 'Alpha Patch Task', 'workflow', 'running', $4, '{"audit": true}'::jsonb)
       ON CONFLICT (id) DO UPDATE SET status = 'running';`,
      [taskAlphaId, orgAlphaId, projAlphaId, userAdminId]
    );

    const authVerifier = new JoseJwtVerifier({
      issuer,
      audience,
      secret: secretKey,
    });

    app = await buildApp({
      pool: runtimePool,
      authVerifier,
    });
  });

  after(async () => {
    if (app) await app.close();
    if (adminPool) {
      await adminPool.query(`DELETE FROM patch_application_journals WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM agent_approvals WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM agent_artifacts WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM agent_tasks WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM projects WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM organization_memberships WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM organizations WHERE id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM app_users WHERE id IN ($1, $2, $3, $4);`, [userOwnerId, userAdminId, userMemberId, userBetaAdminId]);
      await adminPool.end();
    }
    if (runtimePool) await runtimePool.end();
  });

  // Helper to construct artifact + approval scenario
  async function createPatchScenario(
    tx: any,
    targetFile: string,
    originalContent: string,
    patchedContent: string
  ) {
    testRunner.setFile(projAlphaId, targetFile, originalContent);
    const diff =
      `--- a/${targetFile}\n` +
      `+++ b/${targetFile}\n` +
      `@@ -1,1 +1,1 @@\n` +
      `-${originalContent.replace(/\n$/, "")}\n` +
      `+${patchedContent.replace(/\n$/, "")}\n`;

    const contentHash = crypto.createHash("sha256").update(diff, "utf-8").digest("hex");

    const artifact = await artifactsService.createArtifact(tx, userAdminId, orgAlphaId, {
      projectId: projAlphaId,
      taskId: taskAlphaId,
      artifactType: "patch_proposal",
      title: `Patch for ${targetFile}`,
      content: diff,
      metadata: { targetFiles: [targetFile] },
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
  // 1. HTTP API Recovery Routes & Authorization (Real DB + Fastify API)
  // ===========================================================================
  describe("1. HTTP API Recovery Routes & Authorization (Real DB + Fastify API)", () => {
    let journalId = "";

    before(async () => {
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const scenario = await createPatchScenario(
          tx,
          "src/api_recovery.ts",
          "export const v = 1;\n",
          "export const v = 2;\n"
        );

        const jRes = await tx.query<{ id: string }>(
          `INSERT INTO patch_application_journals (
             organization_id, project_id, task_id, patch_artifact_id, approval_id,
             target_content_hash, status, baseline_state, recovery_details, created_by
           ) VALUES (
             $1, $2, $3, $4, $5, $6, 'recovery_required', $7::jsonb, '{}'::jsonb, $8
           ) RETURNING id;`,
          [
            orgAlphaId,
            projAlphaId,
            taskAlphaId,
            scenario.artifact.id,
            scenario.approval.id,
            scenario.contentHash,
            JSON.stringify({
              targetFiles: ["src/api_recovery.ts"],
              files: {
                "src/api_recovery.ts": { existed: true, contentHash: "h1", content: "export const v = 1;\n" },
              },
            }),
            userAdminId,
          ]
        );
        journalId = jRes.rows[0].id;
      });
    });

    it("1.1 should reject unauthenticated requests with 401 Unauthorized", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projAlphaId}/patch-journals/${journalId}/recover`,
        payload: { resolution: "restore_baseline" },
      });

      assert.equal(res.statusCode, 401);
      const body = JSON.parse(res.payload);
      assert.ok(["UNAUTHORIZED", "MISSING_TOKEN"].includes(body.error.code));
    });

    it("1.2 should reject regular members attempting recovery with 403 Forbidden", async () => {
      const memberToken = await createToken(userMemberId, "alpha-member@example.com");

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projAlphaId}/patch-journals/${journalId}/recover`,
        headers: { authorization: `Bearer ${memberToken}` },
        payload: { resolution: "restore_baseline" },
      });

      assert.equal(res.statusCode, 403);
      const body = JSON.parse(res.payload);
      assert.equal(body.error.code, "FORBIDDEN");
    });

    it("1.3 should reject cross-tenant recovery with 404 Not Found (Beta Admin accessing Alpha Journal)", async () => {
      const betaToken = await createToken(userBetaAdminId, "beta-admin@example.com");

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projAlphaId}/patch-journals/${journalId}/recover`,
        headers: { authorization: `Bearer ${betaToken}` },
        payload: { resolution: "restore_baseline" },
      });

      // Under forced RLS, Alpha Project cannot be found in Beta tenant context
      assert.equal(res.statusCode, 404);
      const body = JSON.parse(res.payload);
      assert.equal(body.error.code, "NOT_FOUND");
    });

    it("1.4 should list patch journals scoped to project and tenant under forced RLS", async () => {
      const adminToken = await createToken(userAdminId, "alpha-admin@example.com");

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projAlphaId}/patch-journals`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(Array.isArray(body.data.journals));
      assert.ok(body.data.journals.some((j: any) => j.id === journalId));
    });

    it("1.5 should allow authorized admin to execute recovery and return 200 OK", async () => {
      const adminToken = await createToken(userAdminId, "alpha-admin@example.com");

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projAlphaId}/patch-journals/${journalId}/recover`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          resolution: "restore_baseline",
          reason: "Administrative baseline restore for verification test",
          force: true,
        },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.data.resolution, "restore_baseline");
      assert.equal(body.data.journalId, journalId);
    });
  });

  // ===========================================================================
  // 2. Forced Recovery Authorization & Justification Auditing (Real DB)
  // ===========================================================================
  describe("2. Forced Recovery Authorization & Justification Auditing (Real DB)", () => {
    beforeEach(async () => {
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
      await adminPool.query(
        `UPDATE agent_tasks SET status = 'running' WHERE id = $1;`,
        [taskAlphaId]
      );
    });

    it("2.1 should reject force: true recovery when reason is omitted", async () => {
      let journalId = "";
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const scenario = await createPatchScenario(
          tx,
          "src/force_test.ts",
          "const a = 1;\n",
          "const a = 2;\n"
        );

        const jRes = await tx.query<{ id: string }>(
          `INSERT INTO patch_application_journals (
             organization_id, project_id, task_id, patch_artifact_id, approval_id,
             target_content_hash, status, baseline_state, created_by
           ) VALUES ($1, $2, $3, $4, $5, $6, 'recovery_required', $7::jsonb, $8)
           RETURNING id;`,
          [
            orgAlphaId,
            projAlphaId,
            taskAlphaId,
            scenario.artifact.id,
            scenario.approval.id,
            scenario.contentHash,
            JSON.stringify({ targetFiles: ["src/force_test.ts"], files: {} }),
            userAdminId,
          ]
        );
        journalId = jRes.rows[0].id;
      });

      await assert.rejects(
        async () =>
          withAuthenticatedContext(runtimePool, userAdminId, async (tx) =>
            patchService.adminRecoverWorkspace(
              tx,
              {
                journalId,
                projectId: projAlphaId,
                resolution: "mark_recovered",
                force: true, // Missing reason!
              },
              userAdminId,
              orgAlphaId,
              testRunner
            )
          ),
        (err: any) =>
          err instanceof ValidationError &&
          err.message.includes("meaningful justification (at least 10 characters)")
      );
    });

    it("2.2 should reject force: true recovery when reason is too short (< 10 chars)", async () => {
      let journalId = "";
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const scenario = await createPatchScenario(
          tx,
          "src/force_short.ts",
          "const b = 1;\n",
          "const b = 2;\n"
        );

        const jRes = await tx.query<{ id: string }>(
          `INSERT INTO patch_application_journals (
             organization_id, project_id, task_id, patch_artifact_id, approval_id,
             target_content_hash, status, baseline_state, created_by
           ) VALUES ($1, $2, $3, $4, $5, $6, 'recovery_required', $7::jsonb, $8)
           RETURNING id;`,
          [
            orgAlphaId,
            projAlphaId,
            taskAlphaId,
            scenario.artifact.id,
            scenario.approval.id,
            scenario.contentHash,
            JSON.stringify({ targetFiles: ["src/force_short.ts"], files: {} }),
            userAdminId,
          ]
        );
        journalId = jRes.rows[0].id;
      });

      await assert.rejects(
        async () =>
          withAuthenticatedContext(runtimePool, userAdminId, async (tx) =>
            patchService.adminRecoverWorkspace(
              tx,
              {
                journalId,
                projectId: projAlphaId,
                resolution: "mark_recovered",
                reason: "short", // Only 5 characters!
                force: true,
              },
              userAdminId,
              orgAlphaId,
              testRunner
            )
          ),
        (err: any) =>
          err instanceof ValidationError &&
          err.message.includes("meaningful justification (at least 10 characters)")
      );
    });

    it("2.3 should accept force: true with valid justification and record audit event", async () => {
      let journalId = "";
      let patchArtifactId = "";
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const scenario = await createPatchScenario(
          tx,
          "src/force_valid.ts",
          "const c = 1;\n",
          "const c = 2;\n"
        );
        patchArtifactId = scenario.artifact.id;

        const jRes = await tx.query<{ id: string }>(
          `INSERT INTO patch_application_journals (
             organization_id, project_id, task_id, patch_artifact_id, approval_id,
             target_content_hash, status, baseline_state, created_by
           ) VALUES ($1, $2, $3, $4, $5, $6, 'recovery_required', $7::jsonb, $8)
           RETURNING id;`,
          [
            orgAlphaId,
            projAlphaId,
            taskAlphaId,
            scenario.artifact.id,
            scenario.approval.id,
            scenario.contentHash,
            JSON.stringify({ targetFiles: ["src/force_valid.ts"], files: {} }),
            userAdminId,
          ]
        );
        journalId = jRes.rows[0].id;

        const result = await patchService.adminRecoverWorkspace(
          tx,
          {
            journalId,
            projectId: projAlphaId,
            resolution: "mark_recovered",
            reason: "Valid admin override after post-mortem investigation",
            force: true,
          },
          userAdminId,
          orgAlphaId,
          testRunner
        );

        assert.equal(result.success, true);
        assert.equal(result.details.force, true);

        // Verify audit event contains force: true and sanitized reason
        const auditRes = await tx.query<{ metadata: any }>(
          `SELECT metadata FROM audit_events
           WHERE organization_id = $1 AND action = 'patch.admin_recovered'
           ORDER BY created_at DESC LIMIT 1;`,
          [orgAlphaId]
        );
        assert.equal(auditRes.rows[0].metadata.force, true);
        assert.equal(auditRes.rows[0].metadata.reason, "Valid admin override after post-mortem investigation");
      });
    });
  });

  // ===========================================================================
  // 3. State Machine & Tampering Integrity (Real DB Integration)
  // ===========================================================================
  describe("3. State Machine & Tampering Integrity (Real DB Integration)", () => {
    beforeEach(async () => {
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
      await adminPool.query(
        `UPDATE agent_tasks SET status = 'running' WHERE id = $1;`,
        [taskAlphaId]
      );
    });

    it("3.1 should reject recoverInterruptedPatchApplication when artifact project does not match requested project", async () => {
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const scenario = await createPatchScenario(
          tx,
          "src/cross_proj.ts",
          "const p = 1;\n",
          "const p = 2;\n"
        );

        await assert.rejects(
          async () =>
            patchService.recoverInterruptedPatchApplication(
              tx,
              {
                taskId: taskAlphaId,
                projectId: projBetaId, // Mismatched project ID!
                patchArtifactId: scenario.artifact.id,
                expectedHash: scenario.contentHash,
              },
              userAdminId,
              orgAlphaId,
              testRunner
            ),
          (err: any) =>
            err instanceof ConflictError &&
            err.message.includes("does not match requested project")
        );
      });
    });

    it("3.2 should prevent replay of already-applied patch proposals", async () => {
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const scenario = await createPatchScenario(
          tx,
          "src/replay_test.ts",
          "export const rep = 1;\n",
          "export const rep = 2;\n"
        );

        // Apply patch first time
        await patchService.applyApprovedPatch(
          tx,
          {
            taskId: taskAlphaId,
            projectId: projAlphaId,
            patchArtifactId: scenario.artifact.id,
            expectedHash: scenario.contentHash,
          },
          userAdminId,
          orgAlphaId,
          testRunner
        );

        // Attempt second application (replay)
        await assert.rejects(
          async () =>
            patchService.applyApprovedPatch(
              tx,
              {
                taskId: taskAlphaId,
                projectId: projAlphaId,
                patchArtifactId: scenario.artifact.id,
                expectedHash: scenario.contentHash,
              },
              userAdminId,
              orgAlphaId,
              testRunner
            ),
          (err: any) =>
            err instanceof ConflictError &&
            err.message.includes("Replay prevented")
        );
      });
    });
  });

  // ===========================================================================
  // 4. Resource Limits & Payload Safeguards (Real DB + Unit)
  // ===========================================================================
  describe("4. Resource Limits & Payload Safeguards (Real DB + Unit)", () => {
    beforeEach(async () => {
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
      await adminPool.query(
        `UPDATE agent_tasks SET status = 'running' WHERE id = $1;`,
        [taskAlphaId]
      );
    });

    it("4.1 should reject patch diff exceeding MAX_PATCH_DIFF_SIZE_BYTES (2 MB)", () => {
      const hugeDiff = "--- a/test.ts\n+++ b/test.ts\n" + "+line\n".repeat(400000); // > 2 MB
      const hugeHash = crypto.createHash("sha256").update(hugeDiff, "utf-8").digest("hex");

      const mockArtifact: any = {
        id: "art-huge",
        content: hugeDiff,
        contentHash: hugeHash,
        metadata: { targetFiles: ["test.ts"] },
      };

      assert.throws(
        () => patchService.validatePatchIntegrity(mockArtifact),
        (err: any) =>
          err instanceof ValidationError &&
          err.message.includes("Patch proposal exceeds maximum allowed diff size")
      );
    });

    it("4.2 should reject patch proposals modifying more than MAX_PATCH_FILE_COUNT (50 files)", () => {
      let multiFileDiff = "";
      const files: string[] = [];
      for (let i = 0; i < 55; i++) {
        const f = `src/file_${i}.ts`;
        files.push(f);
        multiFileDiff += `--- a/${f}\n+++ b/${f}\n@@ -1,1 +1,1 @@\n-1\n+2\n`;
      }
      const hash = crypto.createHash("sha256").update(multiFileDiff, "utf-8").digest("hex");

      const mockArtifact: any = {
        id: "art-many-files",
        content: multiFileDiff,
        contentHash: hash,
        metadata: { targetFiles: files },
      };

      assert.throws(
        () => patchService.validatePatchIntegrity(mockArtifact),
        (err: any) =>
          err instanceof ValidationError &&
          err.message.includes("exceeding limit of 50 files")
      );
    });

    it("4.3 should reject aggregate baseline snapshot exceeding MAX_AGGREGATE_BASELINE_SIZE_BYTES (10 MB)", async () => {
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        // Create 11 files of ~950 KB each (~10.45 MB total aggregate)
        const subFiles: string[] = [];
        let diff = "";
        const fileContent = "A\n" + "B".repeat(950 * 1024);

        for (let i = 0; i < 11; i++) {
          const f = `src/agg_${i}.ts`;
          subFiles.push(f);
          testRunner.setFile(projAlphaId, f, fileContent);
          diff += `--- a/${f}\n+++ b/${f}\n@@ -1,1 +1,1 @@\n-A\n+C\n`;
        }

        const hash = crypto.createHash("sha256").update(diff, "utf-8").digest("hex");

        const artifact = await artifactsService.createArtifact(tx, userAdminId, orgAlphaId, {
          projectId: projAlphaId,
          taskId: taskAlphaId,
          artifactType: "patch_proposal",
          title: "Large aggregate patch",
          content: diff,
          metadata: { targetFiles: subFiles },
        });

        const approval = await approvalsService.createApprovalRequest(tx, orgAlphaId, {
          taskId: taskAlphaId,
          artifactId: artifact.id,
          action: "apply_patch",
          targetContentHash: hash,
          requiredRole: "admin",
          expiresInSeconds: 3600,
        });

        await approvalsService.decideApproval(tx, approval.id, userAdminId, orgAlphaId, {
          decision: "approved",
        });

        await assert.rejects(
          async () =>
            patchService.applyApprovedPatch(
              tx,
              {
                taskId: taskAlphaId,
                projectId: projAlphaId,
                patchArtifactId: artifact.id,
                expectedHash: hash,
              },
              userAdminId,
              orgAlphaId,
              testRunner
            ),
          (err: any) =>
            err instanceof ValidationError &&
            err.message.includes("Aggregate baseline snapshot exceeds limit")
        );
      });
    });
  });

  // ===========================================================================
  // 5. Migration Management on Disposable Database (Real DB Integration)
  // ===========================================================================
  describe("5. Migration Management on Disposable Database (Real DB Integration)", () => {
    const disposableDbName = "moducraft_disposable_mgr_eval";
    const migrationsDir = path.resolve(__dirname, "../../../db/migrations");

    it("5.1 should track migrations in schema_migrations table and execute 0001-0010 with checksums", async () => {
      const rootClient = new pg.Client({
        connectionString: getAdminRootDatabaseUrl(),
      });
      await rootClient.connect();

      try {
        await rootClient.query(`DROP DATABASE IF EXISTS ${disposableDbName};`);
        await rootClient.query(`CREATE DATABASE ${disposableDbName};`);

        const dispClient = new pg.Client({
          connectionString: getDisposableDatabaseUrl(disposableDbName),
        });
        await dispClient.connect();

        try {
          const manager = new MigrationManager();
          const result = await manager.migrate(dispClient, migrationsDir);

          assert.equal(result.totalPending, 10, "All 10 migration files should be executed");
          assert.equal(result.applied.length, 10);

          // Verify schema_migrations table contents
          const applied = await manager.getAppliedMigrations(dispClient);
          assert.equal(applied.size, 10);
          for (let i = 1; i <= 10; i++) {
            const ver = String(i).padStart(4, "0");
            const rec = applied.get(ver);
            assert.ok(rec, `Migration version ${ver} must be tracked`);
            assert.equal(rec.status, "applied");
            assert.equal(rec.checksum.length, 64, "SHA-256 checksum must be recorded");
          }

          // 5.2 Re-running migration manager must detect 0 pending migrations (duplicate execution prevention)
          const secondRun = await manager.migrate(dispClient, migrationsDir);
          assert.equal(secondRun.totalPending, 0, "No pending migrations should execute on re-run");
          assert.equal(secondRun.applied.length, 0);

          // 5.3 Checksum drift detection: modifying a recorded checksum triggers error
          await dispClient.query(
            `UPDATE public.schema_migrations SET checksum = '0000000000000000000000000000000000000000000000000000000000000000' WHERE version = '0001';`
          );

          await assert.rejects(
            async () => manager.migrate(dispClient, migrationsDir),
            (err: any) =>
              err instanceof MigrationChecksumDriftError &&
              err.message.includes("Checksum drift detected for migration")
          );
        } finally {
          await dispClient.end();
        }
      } finally {
        await rootClient.query(`DROP DATABASE IF EXISTS ${disposableDbName};`);
        await rootClient.end();
      }
    });

    it("5.4 should roll back cleanly on migration execution error and record failed status", async () => {
      const faultDbName = "moducraft_disposable_fault_mgr";
      const rootClient = new pg.Client({
        connectionString: getAdminRootDatabaseUrl(),
      });
      await rootClient.connect();

      try {
        await rootClient.query(`DROP DATABASE IF EXISTS ${faultDbName};`);
        await rootClient.query(`CREATE DATABASE ${faultDbName};`);

        const dispClient = new pg.Client({
          connectionString: getDisposableDatabaseUrl(faultDbName),
        });
        await dispClient.connect();

        try {
          const manager = new MigrationManager();
          await manager.ensureMigrationTable(dispClient);

          // Create temporary directory with a faulty migration
          const tempDir = path.resolve(__dirname, "temp_migrations_test");
          fs.mkdirSync(tempDir, { recursive: true });
          fs.writeFileSync(
            path.join(tempDir, "0001_good.sql"),
            "CREATE TABLE test_good (id UUID PRIMARY KEY);"
          );
          fs.writeFileSync(
            path.join(tempDir, "0002_bad.sql"),
            "CREATE TABLE test_bad (id UUID PRIMARY KEY);\nSYNTAX_ERROR_FAIL;"
          );

          try {
            await manager.migrate(dispClient, tempDir);
            assert.fail("Should have thrown MigrationExecutionError");
          } catch (err: any) {
            assert.ok(err instanceof MigrationExecutionError);
          }

          // Confirm test_good exists, but test_bad was rolled back completely
          const t1 = await dispClient.query(
            `SELECT COUNT(*)::int as count FROM information_schema.tables WHERE table_name = 'test_good';`
          );
          assert.equal(t1.rows[0].count, 1, "0001 should be committed");

          const t2 = await dispClient.query(
            `SELECT COUNT(*)::int as count FROM information_schema.tables WHERE table_name = 'test_bad';`
          );
          assert.equal(t2.rows[0].count, 0, "0002 table should be completely rolled back");

          // Clean up tempDir
          fs.rmSync(tempDir, { recursive: true, force: true });
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
  // 6. Primary Database Safety & Zero-Drift Verification (Real DB Integration)
  // ===========================================================================
  describe("6. Primary Database Safety & Zero-Drift Verification (Real DB Integration)", () => {
    it("6.1 should verify test database isolation target", async () => {
      const dbRes = await adminPool.query<{ current_database: string }>(
        `SELECT current_database();`
      );
      assert.equal(dbRes.rows[0].current_database, "moducraft_test");
    });

    it("6.2 should verify all 16 public tables remain intact with relforcerowsecurity = t", async () => {
      const tablesRes = await adminPool.query<{ count: number }>(
        `SELECT COUNT(*)::int as count FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name != 'schema_migrations';`
      );
      assert.equal(tablesRes.rows[0].count, 16);

      const rlsRes = await adminPool.query<{ non_forced: number }>(
        `SELECT COUNT(*)::int as non_forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname != 'schema_migrations' AND (c.relrowsecurity = false OR c.relforcerowsecurity = false);`
      );
      assert.equal(rlsRes.rows[0].non_forced, 0, "All 16 tables must have relforcerowsecurity enabled");
    });

    it("6.3 should verify moducraft_runtime role possesses 0 DELETE grants on patch_application_journals", async () => {
      const permRes = await adminPool.query<{ privilege_type: string }>(
        `SELECT privilege_type
         FROM information_schema.role_table_grants
         WHERE grantee = 'moducraft_runtime' AND table_name = 'patch_application_journals';`
      );
      const privileges = permRes.rows.map((r) => r.privilege_type);
      assert.ok(!privileges.includes("DELETE"), "moducraft_runtime role must not have DELETE privilege");
    });
  });
});
