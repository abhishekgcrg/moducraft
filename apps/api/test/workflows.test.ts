import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import * as jose from "jose";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { JoseJwtVerifier } from "../src/auth/verifier.js";
import { createDatabasePool } from "../src/db/pool.js";
import { getTestDatabaseUrls } from "./helpers/test-db-guard.js";
import { ArtifactsService } from "../src/modules/workflows/artifacts.service.js";
import { validateWorkspaceRelativePath } from "../src/modules/workflows/tools/sandbox.js";

const { Pool } = pg;

describe("Agent Workflow Integration Tests (Phase 4D)", () => {
  const { runtimeDbUrl, superuserDbUrl } = getTestDatabaseUrls();

  const secretKey = "workflow-integration-test-secret-key-4d!";
  const issuer = "https://auth.moducraft.test";
  const audience = "moducraft-api";

  // Test users (isolated dddddddd prefix)
  const userOwnerId = "dddddddd-1111-4000-8000-000000000001";
  const userMemberId = "dddddddd-2222-4000-8000-000000000002";
  const userBetaId = "dddddddd-3333-4000-8000-000000000003";

  // Test organizations (isolated eeeeeeee prefix to prevent test collision)
  const orgAlphaId = "eeeeeeee-aaaa-4000-8000-000000000001";
  const orgBetaId = "eeeeeeee-bbbb-4000-8000-000000000002";

  // Test projects (isolated 23232323 prefix)
  const projAlphaId = "23232323-aaaa-4000-8000-000000000001";
  const projBetaId = "23232323-bbbb-4000-8000-000000000002";

  let runtimePool: pg.Pool;
  let adminPool: pg.Pool;
  let app: FastifyInstance;
  let configuredVerifier: JoseJwtVerifier;

  before(async () => {
    runtimePool = createDatabasePool(runtimeDbUrl);
    adminPool = new Pool({ connectionString: superuserDbUrl, max: 2 });

    // Seed test users
    await adminPool.query(
      `
      INSERT INTO app_users(id, identity_issuer, identity_subject, email, display_name)
      VALUES 
        ($1, $4, 'sub-wf-owner', 'wf-owner@moducraft.test', 'Workflow Owner'),
        ($2, $4, 'sub-wf-member', 'wf-member@moducraft.test', 'Workflow Member'),
        ($3, $4, 'sub-wf-beta', 'wf-beta@moducraft.test', 'Beta User')
      ON CONFLICT (id) DO NOTHING;
      `,
      [userOwnerId, userMemberId, userBetaId, issuer]
    );

    // Seed organizations
    await adminPool.query(
      `
      INSERT INTO organizations(id, name, slug, created_by)
      VALUES 
        ($1, 'Workflow Org Alpha', 'wf-org-alpha', $3),
        ($2, 'Workflow Org Beta', 'wf-org-beta', $4)
      ON CONFLICT (id) DO NOTHING;
      `,
      [orgAlphaId, orgBetaId, userOwnerId, userBetaId]
    );

    // Seed memberships
    await adminPool.query(
      `
      INSERT INTO organization_memberships(organization_id, user_id, role)
      VALUES 
        ($1, $2, 'owner'),
        ($1, $3, 'member'),
        ($4, $5, 'owner')
      ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role;
      `,
      [orgAlphaId, userOwnerId, userMemberId, orgBetaId, userBetaId]
    );

    // Seed projects
    await adminPool.query(
      `
      INSERT INTO projects(id, organization_id, name, slug, created_by)
      VALUES 
        ($1, $2, 'Alpha Project', 'alpha-proj', $4),
        ($3, $5, 'Beta Project', 'beta-proj', $6)
      ON CONFLICT (id) DO NOTHING;
      `,
      [projAlphaId, orgAlphaId, projBetaId, userOwnerId, orgBetaId, userBetaId]
    );

    configuredVerifier = new JoseJwtVerifier({
      issuer,
      audience,
      secret: secretKey,
    });

    app = await buildApp({
      pool: runtimePool,
      authVerifier: configuredVerifier,
    });
  });

  after(async () => {
    if (app) await app.close();
    if (adminPool) {
      await adminPool.query(`DELETE FROM agent_approvals WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM agent_artifacts WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM agent_tasks WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM projects WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM organization_memberships WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM organizations WHERE id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM app_users WHERE id IN ($1, $2, $3);`, [userOwnerId, userMemberId, userBetaId]);
      await adminPool.end();
      if (runtimePool) await runtimePool.end();
    }
  });

  async function createToken(sub: string, email: string): Promise<string> {
    const rawSecret = new TextEncoder().encode(secretKey);
    return new jose.SignJWT({
      iss: issuer,
      aud: audience,
      sub,
      email,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(rawSecret);
  }

  // ---------------------------------------------------------------------------
  // 1. Multi-Agent Workflow Pipeline Execution
  // ---------------------------------------------------------------------------
  describe("1. Multi-Agent Workflow Pipeline Execution", () => {
    let workflowTaskId: string;
    let patchArtifactId: string;
    let patchContentHash: string;
    let pendingApprovalId: string;

    it("1.1 should start workflow and generate planning artifact", async () => {
      const token = await createToken("sub-wf-member", "wf-member@moducraft.test");

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/workflows/start",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          projectId: projAlphaId,
          title: "Implement Input Validation for API",
          requirements: ["Validate input parameters", "Return 400 on error", "Add unit tests"],
        },
      });

      assert.equal(res.statusCode, 201);
      const body = res.json();
      assert.ok(body.data.task.id);
      assert.equal(body.data.task.title, "Implement Input Validation for API");
      assert.equal(body.data.artifacts.length, 1);
      assert.equal(body.data.artifacts[0].artifactType, "plan");

      workflowTaskId = body.data.task.id;
    });

    it("1.2 should advance workflow through Coding, Testing, Review, and pause at Approval Gate", async () => {
      const token = await createToken("sub-wf-member", "wf-member@moducraft.test");

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/workflows/${workflowTaskId}/advance`,
        headers: { authorization: `Bearer ${token}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.data.status, "waiting_for_approval");
      assert.equal(body.data.requiresApproval, true);

      // Verify generated artifacts: patch_proposal, test_report, code_review, security_review
      const types = body.data.artifacts.map((a: any) => a.artifactType);
      assert.ok(types.includes("patch_proposal"));
      assert.ok(types.includes("test_report"));
      assert.ok(types.includes("code_review"));
      assert.ok(types.includes("security_review"));

      const patch = body.data.artifacts.find((a: any) => a.artifactType === "patch_proposal");
      assert.ok(patch);
      patchArtifactId = patch.id;
      patchContentHash = patch.contentHash;

      // Verify pending approval request was created
      assert.equal(body.data.approvals.length, 1);
      const approval = body.data.approvals[0];
      assert.equal(approval.status, "pending");
      assert.equal(approval.targetContentHash, patchContentHash);
      assert.equal(approval.action, "apply_patch");

      pendingApprovalId = approval.id;
    });

    it("1.3 should reject member from deciding approval (requires owner or admin)", async () => {
      const memberToken = await createToken("sub-wf-member", "wf-member@moducraft.test");

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/approvals/${pendingApprovalId}/decide`,
        headers: { authorization: `Bearer ${memberToken}` },
        payload: {
          decision: "approved",
          reason: "Approved by member",
        },
      });

      assert.ok(res.statusCode === 403 || res.statusCode === 404);
      assert.match(res.json().error.message, /(Insufficient permissions|not found)/i);
    });

    it("1.4 should allow organization owner to decide approval, resuming task", async () => {
      const ownerToken = await createToken("sub-wf-owner", "wf-owner@moducraft.test");

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/approvals/${pendingApprovalId}/decide`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          decision: "approved",
          reason: "Patch approved after security and code review passed.",
        },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.data.approval.status, "approved");
      assert.equal(body.data.approval.approvedBy, userOwnerId);

      // Verify linked patch artifact review_status is updated to approved
      const artRes = await app.inject({
        method: "GET",
        url: `/api/v1/artifacts/${patchArtifactId}`,
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(artRes.statusCode, 200);
      assert.equal(artRes.json().data.artifact.reviewStatus, "approved");
    });

    it("1.5 should complete workflow post-approval and generate documentation artifact", async () => {
      const token = await createToken("sub-wf-member", "wf-member@moducraft.test");

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/workflows/${workflowTaskId}/complete`,
        headers: { authorization: `Bearer ${token}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.data.status, "succeeded");
      assert.equal(body.data.requiresApproval, false);

      const types = body.data.artifacts.map((a: any) => a.artifactType);
      assert.ok(types.includes("documentation"));
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Hash-Bound Single-Use Approval Gates
  // ---------------------------------------------------------------------------
  describe("2. Hash-Bound Single-Use Approval Gates", () => {
    it("2.1 should reject replay attack on already-decided approval", async () => {
      const ownerToken = await createToken("sub-wf-owner", "wf-owner@moducraft.test");

      // Attempt to decide the already-approved approval request
      const listRes = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projAlphaId}/artifacts`,
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(listRes.statusCode, 200);

      // Create a fresh approval
      const createRes = await app.inject({
        method: "POST",
        url: `/api/v1/agent-tasks/${(listRes.json().data.artifacts[0] as any).taskId}/approvals`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          action: "apply_patch",
          targetContentHash: "a".repeat(64),
          requiredRole: "admin",
          expiresInSeconds: 3600,
        },
      });
      assert.equal(createRes.statusCode, 201);
      const approvalId = createRes.json().data.approval.id;

      // First decision succeeds
      const dec1 = await app.inject({
        method: "POST",
        url: `/api/v1/approvals/${approvalId}/decide`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { decision: "approved", reason: "First approve" },
      });
      assert.equal(dec1.statusCode, 200);

      // Replay attempt fails with 409 Conflict
      const dec2 = await app.inject({
        method: "POST",
        url: `/api/v1/approvals/${approvalId}/decide`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { decision: "rejected", reason: "Replay attempt" },
      });
      assert.equal(dec2.statusCode, 409);
      assert.match(dec2.json().error.message, /single-use/i);
    });

    it("2.2 should reject approval on expired request", async () => {
      const ownerToken = await createToken("sub-wf-owner", "wf-owner@moducraft.test");

      // Insert an expired approval directly in DB
      const expiredRes = await adminPool.query<{ id: string }>(
        `INSERT INTO agent_approvals (
          organization_id, task_id, action, target_content_hash,
          status, required_role, expires_at
        ) SELECT organization_id, id, 'apply_patch', $2, 'pending', 'admin', now() - interval '1 hour'
          FROM agent_tasks WHERE organization_id = $1 LIMIT 1
          RETURNING id;`,
        [orgAlphaId, "b".repeat(64)]
      );
      const expiredId = expiredRes.rows[0].id;

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/approvals/${expiredId}/decide`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { decision: "approved", reason: "Try approve expired" },
      });

      assert.equal(res.statusCode, 409);
      assert.match(res.json().error.message, /expired/i);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Controlled Tool Gateway & Workspace Security
  // ---------------------------------------------------------------------------
  describe("3. Controlled Tool Gateway & Workspace Security", () => {
    it("3.1 should list registered tools and schemas", async () => {
      const token = await createToken("sub-wf-member", "wf-member@moducraft.test");

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/workflows/tools",
        headers: { authorization: `Bearer ${token}` },
      });

      assert.equal(res.statusCode, 200);
      const tools = res.json().data.tools;
      assert.ok(tools.length >= 6);
      const names = tools.map((t: any) => t.name);
      assert.ok(names.includes("read_workflow_status"));
      assert.ok(names.includes("read_project_manifest"));
      assert.ok(names.includes("inspect_file"));
      assert.ok(names.includes("run_test_command"));
      assert.ok(names.includes("create_patch_proposal"));
      assert.ok(names.includes("produce_review_report"));
    });

    it("3.2 should read project manifest safely via tool gateway", async () => {
      const token = await createToken("sub-wf-member", "wf-member@moducraft.test");

      // Get an existing task in Org Alpha
      const taskRes = await adminPool.query<{ id: string }>(
        `SELECT id FROM agent_tasks WHERE organization_id = $1 LIMIT 1;`,
        [orgAlphaId]
      );
      const taskId = taskRes.rows[0].id;

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/workflows/tools/execute",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          toolName: "read_project_manifest",
          projectId: projAlphaId,
          taskId,
          parameters: {},
        },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json().data;
      assert.equal(body.success, true);
      assert.equal(body.output.manifest.name, "moducraft-sample-service");
    });

    it("3.3 should inspect scoped source file safely", async () => {
      const token = await createToken("sub-wf-member", "wf-member@moducraft.test");
      const taskRes = await adminPool.query<{ id: string }>(
        `SELECT id FROM agent_tasks WHERE organization_id = $1 LIMIT 1;`,
        [orgAlphaId]
      );
      const taskId = taskRes.rows[0].id;

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/workflows/tools/execute",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          toolName: "inspect_file",
          projectId: projAlphaId,
          taskId,
          parameters: { path: "src/index.ts" },
        },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().data.success, true);
      assert.match(res.json().data.output.content, /export function greet/);
    });

    it("3.4 should reject path traversal attacks (../../etc/passwd, C:\\Windows, null-bytes)", async () => {
      const attacks = [
        "../package.json",
        "../../etc/passwd",
        "/etc/shadow",
        "C:\\Windows\\System32\\cmd.exe",
        "src/../../../secret.env",
        "src/file.ts\0.js",
      ];

      for (const maliciousPath of attacks) {
        assert.throws(
          () => validateWorkspaceRelativePath(maliciousPath),
          (err: any) => err.statusCode === 403 || err.statusCode === 400
        );
      }
    });

    it("3.5 should execute allowlisted test command in workspace sandbox", async () => {
      const token = await createToken("sub-wf-member", "wf-member@moducraft.test");
      const taskRes = await adminPool.query<{ id: string }>(
        `SELECT id FROM agent_tasks WHERE organization_id = $1 LIMIT 1;`,
        [orgAlphaId]
      );
      const taskId = taskRes.rows[0].id;

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/workflows/tools/execute",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          toolName: "run_test_command",
          projectId: projAlphaId,
          taskId,
          parameters: { command: "test" },
        },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json().data;
      assert.equal(body.success, true);
      assert.equal(body.output.passed, true);
      assert.equal(body.output.exitCode, 0);
    });

    it("3.6 should reject unallowlisted commands (rm -rf, curl, bash)", async () => {
      const token = await createToken("sub-wf-member", "wf-member@moducraft.test");
      const taskRes = await adminPool.query<{ id: string }>(
        `SELECT id FROM agent_tasks WHERE organization_id = $1 LIMIT 1;`,
        [orgAlphaId]
      );
      const taskId = taskRes.rows[0].id;

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/workflows/tools/execute",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          toolName: "run_test_command",
          projectId: projAlphaId,
          taskId,
          parameters: { command: "rm -rf /" },
        },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().data.success, false);
      assert.equal(res.json().data.error.code, "FORBIDDEN");
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Tenant Isolation & Database Authorization
  // ---------------------------------------------------------------------------
  describe("4. Tenant Isolation & Database Authorization", () => {
    it("4.1 should prevent cross-tenant artifact access (Org Beta cannot read Org Alpha artifacts)", async () => {
      const betaToken = await createToken("sub-wf-beta", "wf-beta@moducraft.test");

      // Attempt to access Org Alpha project's artifacts using Beta user
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projAlphaId}/artifacts`,
        headers: { authorization: `Bearer ${betaToken}` },
      });

      // Must return 404 under RLS
      assert.equal(res.statusCode, 404);
    });

    it("4.2 should prevent cross-tenant approval decisions", async () => {
      const betaToken = await createToken("sub-wf-beta", "wf-beta@moducraft.test");

      // Find an approval in Org Alpha
      const appRes = await adminPool.query<{ id: string }>(
        `SELECT id FROM agent_approvals WHERE organization_id = $1 LIMIT 1;`,
        [orgAlphaId]
      );
      const alphaApprovalId = appRes.rows[0].id;

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/approvals/${alphaApprovalId}/decide`,
        headers: { authorization: `Bearer ${betaToken}` },
        payload: { decision: "approved", reason: "Cross-tenant attempt" },
      });

      // Denied with 404 or 403 under RLS
      assert.ok(res.statusCode === 404 || res.statusCode === 403);
    });

    it("4.3 should enforce immutable artifact content under runtime role (direct SQL attack fails)", async () => {
      // Connect as moducraft_runtime and attempt direct SQL UPDATE on content
      const client = new pg.Client({ connectionString: runtimeDbUrl });
      await client.connect();

      try {
        await client.query("BEGIN;");
        await client.query("SELECT set_config('app.current_organization_id', $1, true);", [orgAlphaId]);
        await client.query("SELECT set_config('app.user_id', $1, true);", [userOwnerId]);

        // Attempt to update content on an existing artifact
        let threwError = false;
        try {
          await client.query(
            `UPDATE agent_artifacts SET content = 'TAMPERED CONTENT' WHERE organization_id = $1;`,
            [orgAlphaId]
          );
        } catch (err: any) {
          threwError = true;
          // SQLSTATE 42501 = insufficient privilege (permission denied for table agent_artifacts)
          assert.equal(err.code, "42501");
        }
        assert.equal(threwError, true, "Direct SQL UPDATE on artifact content must be denied by column grants");
      } finally {
        await client.query("ROLLBACK;");
        await client.end();
      }
    });

    it("4.4 should enforce immutable approval action and target_content_hash under runtime role", async () => {
      const client = new pg.Client({ connectionString: runtimeDbUrl });
      await client.connect();

      try {
        await client.query("BEGIN;");
        await client.query("SELECT set_config('app.current_organization_id', $1, true);", [orgAlphaId]);
        await client.query("SELECT set_config('app.user_id', $1, true);", [userOwnerId]);

        let threwError = false;
        try {
          await client.query(
            `UPDATE agent_approvals SET target_content_hash = 'TAMPERED_HASH' WHERE organization_id = $1;`,
            [orgAlphaId]
          );
        } catch (err: any) {
          threwError = true;
          assert.equal(err.code, "42501");
        }
        assert.equal(threwError, true, "Direct SQL UPDATE on approval target_content_hash must be denied");
      } finally {
        await client.query("ROLLBACK;");
        await client.end();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Phase 4D.1 Adversarial Security & Execution Hardening Tests
  // ---------------------------------------------------------------------------
  describe("5. Phase 4D.1 Adversarial Security & Execution Hardening", () => {
    it("5.1 should reject single-use approval replay after consumption (complete twice fails with 409)", async () => {
      const ownerToken = await createToken("sub-wf-owner", "wf-owner@moducraft.test");
      const memberToken = await createToken("sub-wf-member", "wf-member@moducraft.test");

      // Start a fresh workflow
      const startRes = await app.inject({
        method: "POST",
        url: "/api/v1/workflows/start",
        headers: { authorization: `Bearer ${memberToken}` },
        payload: {
          projectId: projAlphaId,
          title: "Adversarial Approval Consumption Test",
          requirements: ["Feature requirement A"],
        },
      });
      assert.equal(startRes.statusCode, 201);
      const taskId = startRes.json().data.task.id;

      // Advance to approval gate
      const advRes = await app.inject({
        method: "POST",
        url: `/api/v1/workflows/${taskId}/advance`,
        headers: { authorization: `Bearer ${memberToken}` },
      });
      assert.equal(advRes.statusCode, 200);
      const approvalId = advRes.json().data.approvals[0].id;

      // Owner approves
      const decRes = await app.inject({
        method: "POST",
        url: `/api/v1/approvals/${approvalId}/decide`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { decision: "approved", reason: "Approved for replay test" },
      });
      assert.equal(decRes.statusCode, 200);

      // First complete consumes the approval -> succeeds (200)
      const comp1 = await app.inject({
        method: "POST",
        url: `/api/v1/workflows/${taskId}/complete`,
        headers: { authorization: `Bearer ${memberToken}` },
      });
      assert.equal(comp1.statusCode, 200);

      // Second complete attempt tries to consume the already-consumed approval -> rejected (409)
      const comp2 = await app.inject({
        method: "POST",
        url: `/api/v1/workflows/${taskId}/complete`,
        headers: { authorization: `Bearer ${memberToken}` },
      });
      assert.equal(comp2.statusCode, 409);
      assert.match(comp2.json().error.message, /(already completed|has already been completed|already been consumed)/i);
    });

    it("5.2 should reject inspecting sensitive credentials (.env, .git/config, id_rsa, .npmrc)", async () => {
      const sensitiveFiles = [
        ".env",
        ".env.local",
        ".env.production",
        ".git/config",
        ".ssh/id_rsa",
        "id_rsa",
        "cert.pem",
        "server.key",
        ".aws/credentials",
        ".npmrc",
        ".dockercfg",
      ];

      for (const secretFile of sensitiveFiles) {
        assert.throws(
          () => validateWorkspaceRelativePath(secretFile),
          (err: any) => err.statusCode === 403,
          `Expected 403 Forbidden for sensitive file: ${secretFile}`
        );
      }
    });

    it("5.3 should reject percent-encoded path traversal attacks (%2e%2e, %00)", async () => {
      const encodedAttacks = [
        "%2e%2e/package.json",
        "src/%2e%2e/%2e%2e/etc/passwd",
        "src/%2e%2e%2f%2e%2e%2fetc%2fshadow",
        "src/file%00.ts",
      ];

      for (const attack of encodedAttacks) {
        assert.throws(
          () => validateWorkspaceRelativePath(attack),
          (err: any) => err.statusCode === 403 || err.statusCode === 400,
          `Expected rejection for encoded attack: ${attack}`
        );
      }
    });

    it("5.4 should redact secrets, tokens, and private keys from tool output before response", async () => {
      const memberToken = await createToken("sub-wf-member", "wf-member@moducraft.test");
      const taskRes = await adminPool.query<{ id: string }>(
        `SELECT id FROM agent_tasks WHERE organization_id = $1 LIMIT 1;`,
        [orgAlphaId]
      );
      const taskId = taskRes.rows[0].id;

      // Create a review report containing an accidental leak of an API key and password
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/workflows/tools/execute",
        headers: { authorization: `Bearer ${memberToken}` },
        payload: {
          toolName: "produce_review_report",
          projectId: projAlphaId,
          taskId,
          parameters: {
            title: "Security Scan with Leaked Key",
            reportType: "security_review",
            score: 85,
            content: "Found sensitive token: Bearer sk-1234567890abcdef1234567890 and password: 'supersecretpassword123'",
          },
        },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json().data;
      assert.equal(body.success, true);

      // Verify the returned output had the bearer token redacted
      const outputStr = JSON.stringify(body.output);
      assert.doesNotMatch(outputStr, /sk-1234567890abcdef1234567890/);
    });

    it("5.5 should tag test commands as simulated and fail closed if MockWorkspaceRunner runs in production", async () => {
      const memberToken = await createToken("sub-wf-member", "wf-member@moducraft.test");
      const taskRes = await adminPool.query<{ id: string }>(
        `SELECT id FROM agent_tasks WHERE organization_id = $1 LIMIT 1;`,
        [orgAlphaId]
      );
      const taskId = taskRes.rows[0].id;

      // In dev/test: returns isSimulated: true, runnerType: 'mock'
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/workflows/tools/execute",
        headers: { authorization: `Bearer ${memberToken}` },
        payload: {
          toolName: "run_test_command",
          projectId: projAlphaId,
          taskId,
          parameters: { command: "test" },
        },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().data.output.isSimulated, true);
      assert.equal(res.json().data.output.runnerType, "mock");

      // Verify fail-closed in production
      const origEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = "production";
        const prodRes = await app.inject({
          method: "POST",
          url: "/api/v1/workflows/tools/execute",
          headers: { authorization: `Bearer ${memberToken}` },
          payload: {
            toolName: "run_test_command",
            projectId: projAlphaId,
            taskId,
            parameters: { command: "test" },
          },
        });
        assert.equal(prodRes.statusCode, 200);
        assert.equal(prodRes.json().data.success, false);
        assert.match(prodRes.json().data.error.message, /MockWorkspaceRunner is strictly disallowed in production/);
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    });

    it("5.6 should prevent regular members from updating artifact review status under runtime role", async () => {
      const client = new pg.Client({ connectionString: runtimeDbUrl });
      await client.connect();

      try {
        await client.query("BEGIN;");
        await client.query("SELECT set_config('app.current_organization_id', $1, true);", [orgAlphaId]);
        // Set user to member role
        await client.query("SELECT set_config('app.user_id', $1, true);", [userMemberId]);

        // Attempting to update review_status as a regular member must match 0 rows under RLS
        const updateRes = await client.query(
          `UPDATE agent_artifacts SET review_status = 'approved' WHERE organization_id = $1;`,
          [orgAlphaId]
        );
        assert.equal(updateRes.rowCount, 0, "Regular members must not be able to update artifact review_status under RLS");
      } finally {
        await client.query("ROLLBACK;");
        await client.end();
      }
    });

    it("5.7 should prevent deleting artifact referenced by approval (foreign key RESTRICT)", async () => {
      const client = new pg.Client({ connectionString: superuserDbUrl });
      await client.connect();

      try {
        await client.query("BEGIN;");
        // Attempt to delete an artifact that has a linked approval
        const artRes = await client.query<{ artifact_id: string }>(
          `SELECT artifact_id FROM agent_approvals WHERE artifact_id IS NOT NULL LIMIT 1;`
        );
        if (artRes.rowCount && artRes.rowCount > 0) {
          const artifactId = artRes.rows[0].artifact_id;
          let threwError = false;
          try {
            await client.query(`DELETE FROM agent_artifacts WHERE id = $1;`, [artifactId]);
          } catch (err: any) {
            threwError = true;
            // 23503 = foreign_key_violation
            assert.equal(err.code, "23503");
          }
          assert.equal(threwError, true, "Artifact referenced by approval must be protected by ON DELETE RESTRICT");
        }
      } finally {
        await client.query("ROLLBACK;");
        await client.end();
      }
    });
  });
});

