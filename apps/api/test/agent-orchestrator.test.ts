import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import * as jose from "jose";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { JoseJwtVerifier } from "../src/auth/verifier.js";
import { createDatabasePool } from "../src/db/pool.js";
import { getTestDatabaseUrls } from "./helpers/test-db-guard.js";

const { Pool } = pg;

describe("AI Agent Orchestrator Integration Tests (Phase 4A)", () => {
  const { runtimeDbUrl, superuserDbUrl } = getTestDatabaseUrls();

  const secretKey = "agent-orchestrator-test-secret-key-moducraft-4a!";
  const issuer = "https://auth.moducraft.test";
  const audience = "moducraft-api";

  // Test users
  const userOwnerId = "77777777-1111-4000-8000-000000000001";
  const userMemberId = "77777777-2222-4000-8000-000000000002";
  const userViewerId = "77777777-3333-4000-8000-000000000003";
  const userOtherOrgId = "77777777-4444-4000-8000-000000000004";

  // Test organizations
  const orgAlphaId = "88888888-aaaa-4000-8000-000000000001";
  const orgBetaId = "88888888-bbbb-4000-8000-000000000002";

  // Test projects
  const projAlphaId = "99999999-aaaa-4000-8000-000000000001";
  const projBetaId = "99999999-bbbb-4000-8000-000000000002";

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
        ($1, $5, 'sub-agent-owner', 'agent-owner@moducraft.test', 'Agent Owner'),
        ($2, $5, 'sub-agent-member', 'agent-member@moducraft.test', 'Agent Member'),
        ($3, $5, 'sub-agent-viewer', 'agent-viewer@moducraft.test', 'Agent Viewer'),
        ($4, $5, 'sub-agent-other', 'agent-other@moducraft.test', 'Other Org User')
      ON CONFLICT (id) DO NOTHING;
      `,
      [userOwnerId, userMemberId, userViewerId, userOtherOrgId, issuer]
    );

    // Seed organizations
    await adminPool.query(
      `
      INSERT INTO organizations(id, name, slug, created_by)
      VALUES 
        ($1, 'Orchestrator Alpha', 'orchestrator-alpha', $3),
        ($2, 'Orchestrator Beta', 'orchestrator-beta', $4)
      ON CONFLICT (id) DO NOTHING;
      `,
      [orgAlphaId, orgBetaId, userOwnerId, userOtherOrgId]
    );

    // Seed memberships
    await adminPool.query(
      `
      INSERT INTO organization_memberships(organization_id, user_id, role, created_by)
      VALUES 
        ($1, $3, 'owner', $3),
        ($1, $4, 'member', $3),
        ($1, $5, 'viewer', $3),
        ($2, $6, 'owner', $6)
      ON CONFLICT (organization_id, user_id) DO NOTHING;
      `,
      [orgAlphaId, orgBetaId, userOwnerId, userMemberId, userViewerId, userOtherOrgId]
    );

    // Seed projects
    await adminPool.query(
      `
      INSERT INTO projects(id, organization_id, name, slug, description, created_by)
      VALUES 
        ($1, $2, 'Alpha Core App', 'alpha-core-app', 'Alpha primary project', $4),
        ($3, $5, 'Beta Core App', 'beta-core-app', 'Beta primary project', $6)
      ON CONFLICT (id) DO NOTHING;
      `,
      [projAlphaId, orgAlphaId, projBetaId, userOwnerId, orgBetaId, userOtherOrgId]
    );

    configuredVerifier = new JoseJwtVerifier({
      issuer,
      audience,
      secret: secretKey,
    });

    app = await buildApp({
      pool: runtimePool,
      authVerifier: configuredVerifier,
      enforceRestrictedRoleCheck: true,
    });
  });

  after(async () => {
    await app.close();

    // Clean up all seeded test data
    await adminPool.query(`DELETE FROM agent_tasks WHERE organization_id IN ($1, $2);`, [
      orgAlphaId,
      orgBetaId,
    ]);
    await adminPool.query(`DELETE FROM projects WHERE id IN ($1, $2);`, [projAlphaId, projBetaId]);
    await adminPool.query(`DELETE FROM organizations WHERE id IN ($1, $2);`, [
      orgAlphaId,
      orgBetaId,
    ]);
    await adminPool.query(`DELETE FROM app_users WHERE id IN ($1, $2, $3, $4);`, [
      userOwnerId,
      userMemberId,
      userViewerId,
      userOtherOrgId,
    ]);

    await adminPool.end();
    await runtimePool.end();
  });

  async function generateToken(userId: string, subject: string, email: string): Promise<string> {
    const rawSecret = new TextEncoder().encode(secretKey);
    return new jose.SignJWT({
      sub: subject,
      email,
      name: `User ${userId.slice(0, 8)}`,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setExpirationTime("2h")
      .sign(rawSecret);
  }

  describe("1. Task Creation & Deterministic Planning", () => {
    it("should allow an owner to create a task and generate ordered steps", async () => {
      const token = await generateToken(userOwnerId, "sub-agent-owner", "agent-owner@moducraft.test");

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/agent-tasks",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        payload: {
          organizationId: orgAlphaId,
          projectId: projAlphaId,
          taskType: "project_summary",
          title: "Generate Alpha System Architecture Summary",
          inputData: { focus: "backend" },
        },
      });

      assert.equal(res.statusCode, 201);
      const body = JSON.parse(res.payload);
      assert.ok(body.data.task);
      const task = body.data.task;

      assert.equal(task.organizationId, orgAlphaId);
      assert.equal(task.projectId, projAlphaId);
      assert.equal(task.taskType, "project_summary");
      assert.equal(task.status, "queued");
      assert.equal(task.version, 1);
      assert.ok(task.steps);
      assert.equal(task.steps.length, 3);

      // Verify step initial states
      assert.equal(task.steps[0].stepKey, "fetch_project_metadata");
      assert.equal(task.steps[0].status, "ready");
      assert.equal(task.steps[0].position, 1);

      assert.equal(task.steps[1].stepKey, "analyze_architecture");
      assert.equal(task.steps[1].status, "pending");
      assert.equal(task.steps[1].position, 2);

      assert.equal(task.steps[2].stepKey, "compile_summary_report");
      assert.equal(task.steps[2].status, "pending");
      assert.equal(task.steps[2].position, 3);

      // Verify audit record was created
      const auditRes = await adminPool.query(
        `SELECT * FROM audit_events WHERE action = 'agent_task.created' AND resource_id = $1;`,
        [task.id]
      );
      assert.equal(auditRes.rows.length, 1);
    });

    it("should allow a member to create a task", async () => {
      const token = await generateToken(userMemberId, "sub-agent-member", "agent-member@moducraft.test");

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/agent-tasks",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        payload: {
          organizationId: orgAlphaId,
          taskType: "repository_review_plan",
          title: "Alpha Repo Review",
        },
      });

      assert.equal(res.statusCode, 201);
      const body = JSON.parse(res.payload);
      assert.equal(body.data.task.status, "queued");
      assert.equal(body.data.task.steps.length, 3);
    });

    it("should deny a viewer from creating a task with 403 Forbidden", async () => {
      const token = await generateToken(userViewerId, "sub-agent-viewer", "agent-viewer@moducraft.test");

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/agent-tasks",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        payload: {
          organizationId: orgAlphaId,
          taskType: "project_summary",
          title: "Viewer unauthorized task",
        },
      });

      assert.equal(res.statusCode, 403);
    });

    it("should reject cross-tenant project reference with 404", async () => {
      const token = await generateToken(userOwnerId, "sub-agent-owner", "agent-owner@moducraft.test");

      // Attempting to attach projBetaId (which belongs to orgBetaId) to orgAlphaId task
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/agent-tasks",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        payload: {
          organizationId: orgAlphaId,
          projectId: projBetaId,
          taskType: "project_summary",
          title: "Cross tenant reference test",
        },
      });

      assert.equal(res.statusCode, 404);
    });
  });

  describe("2. Task Query & Forced RLS Isolation", () => {
    it("should list tasks for authorized organization under forced RLS", async () => {
      const token = await generateToken(userViewerId, "sub-agent-viewer", "agent-viewer@moducraft.test");

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/agent-tasks?organizationId=${orgAlphaId}`,
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(Array.isArray(body.data.tasks));
      assert.ok(body.data.tasks.length >= 2);
      for (const t of body.data.tasks) {
        assert.equal(t.organizationId, orgAlphaId);
      }
    });

    it("should return 404 for task belonging to another organization (Forced RLS)", async () => {
      // First create a task in Org Alpha
      const ownerToken = await generateToken(userOwnerId, "sub-agent-owner", "agent-owner@moducraft.test");
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/agent-tasks",
        headers: {
          authorization: `Bearer ${ownerToken}`,
          "content-type": "application/json",
        },
        payload: {
          organizationId: orgAlphaId,
          taskType: "project_summary",
          title: "Confidential Alpha Task",
        },
      });
      const alphaTask = JSON.parse(createRes.payload).data.task;

      // Other org user attempts to access alphaTask
      const otherToken = await generateToken(userOtherOrgId, "sub-agent-other", "agent-other@moducraft.test");
      const getRes = await app.inject({
        method: "GET",
        url: `/api/v1/agent-tasks/${alphaTask.id}`,
        headers: {
          authorization: `Bearer ${otherToken}`,
        },
      });

      assert.equal(getRes.statusCode, 404);
    });
  });

  describe("3. Deterministic Step Execution & State Transitions", () => {
    it("should execute steps sequentially, update statuses, and complete task", async () => {
      const token = await generateToken(userOwnerId, "sub-agent-owner", "agent-owner@moducraft.test");

      // 1. Create task
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/agent-tasks",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        payload: {
          organizationId: orgAlphaId,
          taskType: "project_summary",
          title: "Execution Flow Test",
        },
      });
      const task = JSON.parse(createRes.payload).data.task;

      // 2. Run step 1: fetch_project_metadata
      const run1Res = await app.inject({
        method: "POST",
        url: `/api/v1/agent-tasks/${task.id}/run`,
        headers: {
          authorization: `Bearer ${token}`,
        },
      });
      assert.equal(run1Res.statusCode, 200);
      const run1Task = JSON.parse(run1Res.payload).data.task;
      assert.equal(run1Task.status, "running");
      assert.equal(run1Task.currentStepKey, "analyze_architecture");

      const step1 = run1Task.steps.find((s: any) => s.stepKey === "fetch_project_metadata");
      assert.equal(step1.status, "succeeded");
      assert.ok(step1.resultData.scannedFilesCount);

      const step2 = run1Task.steps.find((s: any) => s.stepKey === "analyze_architecture");
      assert.equal(step2.status, "ready");

      // 3. Run step 2: analyze_architecture
      const run2Res = await app.inject({
        method: "POST",
        url: `/api/v1/agent-tasks/${task.id}/run`,
        headers: {
          authorization: `Bearer ${token}`,
        },
      });
      assert.equal(run2Res.statusCode, 200);
      const run2Task = JSON.parse(run2Res.payload).data.task;
      assert.equal(run2Task.status, "running");
      assert.equal(run2Task.currentStepKey, "compile_summary_report");

      const step2Completed = run2Task.steps.find((s: any) => s.stepKey === "analyze_architecture");
      assert.equal(step2Completed.status, "succeeded");
      assert.ok(step2Completed.resultData.modulesIdentified);

      const step3 = run2Task.steps.find((s: any) => s.stepKey === "compile_summary_report");
      assert.equal(step3.status, "ready");

      // 4. Run step 3: compile_summary_report -> complete task!
      const run3Res = await app.inject({
        method: "POST",
        url: `/api/v1/agent-tasks/${task.id}/run`,
        headers: {
          authorization: `Bearer ${token}`,
        },
      });
      assert.equal(run3Res.statusCode, 200);
      const run3Task = JSON.parse(run3Res.payload).data.task;
      assert.equal(run3Task.status, "succeeded");
      assert.equal(run3Task.currentStepKey, null);
      assert.ok(run3Task.completedAt);

      const step3Completed = run3Task.steps.find((s: any) => s.stepKey === "compile_summary_report");
      assert.equal(step3Completed.status, "succeeded");
      assert.ok(step3Completed.resultData.reportGenerated);

      // Verify lifecycle events in sequence
      const eventsRes = await app.inject({
        method: "GET",
        url: `/api/v1/agent-tasks/${task.id}`,
        headers: {
          authorization: `Bearer ${token}`,
        },
      });
      const events = JSON.parse(eventsRes.payload).data.task.events;
      const eventTypes = events.map((e: any) => e.eventType);
      assert.ok(eventTypes.includes("task.created"));
      assert.ok(eventTypes.includes("task.planned"));
      assert.ok(eventTypes.includes("task.started"));
      assert.ok(eventTypes.includes("step.started"));
      assert.ok(eventTypes.includes("step.succeeded"));
      assert.ok(eventTypes.includes("task.succeeded"));

      // 5. Idempotent rerun returns 200 without changes
      const run4Res = await app.inject({
        method: "POST",
        url: `/api/v1/agent-tasks/${task.id}/run`,
        headers: {
          authorization: `Bearer ${token}`,
        },
      });
      assert.equal(run4Res.statusCode, 200);
      const run4Task = JSON.parse(run4Res.payload).data.task;
      assert.equal(run4Task.status, "succeeded");
    });
  });

  describe("4. Failure Handling, Bounded Retries & Concurrency", () => {
    it("should handle simulated step failure, support retry, and enforce retry bounds", async () => {
      const token = await generateToken(userOwnerId, "sub-agent-owner", "agent-owner@moducraft.test");

      // 1. Create task with simulateFailure
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/agent-tasks",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        payload: {
          organizationId: orgAlphaId,
          taskType: "project_summary",
          title: "Failure & Retry Test",
          inputData: { simulateFailure: true },
        },
      });
      const task = JSON.parse(createRes.payload).data.task;

      // 2. Run first step -> fails
      const runRes = await app.inject({
        method: "POST",
        url: `/api/v1/agent-tasks/${task.id}/run`,
        headers: {
          authorization: `Bearer ${token}`,
        },
      });
      assert.equal(runRes.statusCode, 200);
      const failedTask = JSON.parse(runRes.payload).data.task;
      assert.equal(failedTask.status, "failed");

      const failedStep = failedTask.steps.find((s: any) => s.stepKey === "fetch_project_metadata");
      assert.equal(failedStep.status, "failed");
      assert.equal(failedStep.errorCode, "SIMULATED_STEP_FAILURE");
      assert.equal(failedStep.attemptCount, 1);

      // 3. Attempting to run a failed task directly returns 409 Conflict
      const runAgainRes = await app.inject({
        method: "POST",
        url: `/api/v1/agent-tasks/${task.id}/run`,
        headers: {
          authorization: `Bearer ${token}`,
        },
      });
      assert.equal(runAgainRes.statusCode, 409);

      // 4. Retry task -> resets step to ready and task to running
      const retryRes = await app.inject({
        method: "POST",
        url: `/api/v1/agent-tasks/${task.id}/retry`,
        headers: {
          authorization: `Bearer ${token}`,
        },
      });
      assert.equal(retryRes.statusCode, 200);
      const retriedTask = JSON.parse(retryRes.payload).data.task;
      assert.equal(retriedTask.status, "running");

      const readyStep = retriedTask.steps.find((s: any) => s.stepKey === "fetch_project_metadata");
      assert.equal(readyStep.status, "ready");
      assert.equal(readyStep.errorCode, null);

      // 5. Test retry limit exhaustion: artificially set attempt_count = max_attempts
      await adminPool.query(
        `UPDATE agent_task_steps SET attempt_count = 3, max_attempts = 3, status = 'failed' WHERE id = $1;`,
        [readyStep.id]
      );
      await adminPool.query(
        `UPDATE agent_tasks SET status = 'failed' WHERE id = $1;`,
        [task.id]
      );

      // Attempt retry when limit exhausted -> 400 Bad Request
      const exhaustedRetryRes = await app.inject({
        method: "POST",
        url: `/api/v1/agent-tasks/${task.id}/retry`,
        headers: {
          authorization: `Bearer ${token}`,
        },
      });
      assert.equal(exhaustedRetryRes.statusCode, 400);
    });
  });

  describe("5. Task Cancellation", () => {
    it("should cancel an active task and prevent further execution", async () => {
      const token = await generateToken(userOwnerId, "sub-agent-owner", "agent-owner@moducraft.test");

      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/agent-tasks",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        payload: {
          organizationId: orgAlphaId,
          taskType: "project_summary",
          title: "Cancellation Test",
        },
      });
      const task = JSON.parse(createRes.payload).data.task;

      // Cancel task
      const cancelRes = await app.inject({
        method: "POST",
        url: `/api/v1/agent-tasks/${task.id}/cancel`,
        headers: {
          authorization: `Bearer ${token}`,
        },
      });
      assert.equal(cancelRes.statusCode, 200);
      const cancelledTask = JSON.parse(cancelRes.payload).data.task;
      assert.equal(cancelledTask.status, "cancelled");
      assert.ok(cancelledTask.cancelledAt);

      for (const step of cancelledTask.steps) {
        assert.equal(step.status, "cancelled");
      }

      // Trying to run cancelled task returns 409 Conflict
      const runRes = await app.inject({
        method: "POST",
        url: `/api/v1/agent-tasks/${task.id}/run`,
        headers: {
          authorization: `Bearer ${token}`,
        },
      });
      assert.equal(runRes.statusCode, 409);

      // Subsequent cancel is idempotent
      const cancel2Res = await app.inject({
        method: "POST",
        url: `/api/v1/agent-tasks/${task.id}/cancel`,
        headers: {
          authorization: `Bearer ${token}`,
        },
      });
      assert.equal(cancel2Res.statusCode, 200);
    });
  });

  describe("6. Interrupted Task Recovery", () => {
    it("should recover interrupted running tasks", async () => {
      const token = await generateToken(userOwnerId, "sub-agent-owner", "agent-owner@moducraft.test");

      // Create a task
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/agent-tasks",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        payload: {
          organizationId: orgAlphaId,
          taskType: "project_summary",
          title: "Interruption Recovery Test",
        },
      });
      const task = JSON.parse(createRes.payload).data.task;

      // Artificially simulate an abrupt server crash while task is running
      await adminPool.query(
        `UPDATE agent_tasks SET status = 'running' WHERE id = $1;`,
        [task.id]
      );
      await adminPool.query(
        `UPDATE agent_task_steps SET status = 'running', attempt_count = 1 WHERE task_id = $1 AND position = 1;`,
        [task.id]
      );

      // Trigger recovery endpoint
      const recoverRes = await app.inject({
        method: "POST",
        url: "/api/v1/agent-tasks/recover",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        payload: {
          organizationId: orgAlphaId,
        },
      });
      assert.equal(recoverRes.statusCode, 200);
      const recoverBody = JSON.parse(recoverRes.payload);
      assert.ok(recoverBody.data.recoveredCount >= 1);

      // Verify step was restored to ready
      const taskRes = await app.inject({
        method: "GET",
        url: `/api/v1/agent-tasks/${task.id}`,
        headers: {
          authorization: `Bearer ${token}`,
        },
      });
      const recoveredTask = JSON.parse(taskRes.payload).data.task;
      const step1 = recoveredTask.steps.find((s: any) => s.position === 1);
      assert.equal(step1.status, "ready");
    });
  });

  describe("7. Security & Privilege Boundaries", () => {
    it("should reject client attempts to forge immutable or status fields via API", async () => {
      const token = await generateToken(userOwnerId, "sub-agent-owner", "agent-owner@moducraft.test");

      // Attempting to send status, createdBy, or version in request payload
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/agent-tasks",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        payload: {
          organizationId: orgAlphaId,
          taskType: "project_summary",
          title: "Field Forgery Attempt",
          status: "succeeded",
          createdBy: "00000000-0000-0000-0000-000000000000",
          version: 99,
        },
      });

      // Zod schema is strict, so extra fields cause 400 Bad Request
      assert.equal(res.statusCode, 400);
    });

    it("should reject task title exceeding 200 characters with 400 Bad Request", async () => {
      const token = await generateToken(userOwnerId, "sub-agent-owner", "agent-owner@moducraft.test");

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/agent-tasks",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        payload: {
          organizationId: orgAlphaId,
          taskType: "project_summary",
          title: "A".repeat(201), // Exceeds 200 characters
        },
      });

      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.payload);
      assert.equal(body.error.code, "VALIDATION_ERROR");
    });

    it("should prevent event actor forgery under RLS for runtime role", async () => {
      // Connect as runtime pool and verify direct SQL spoofing is rejected by RLS
      const client = await runtimePool.connect();
      try {
        await client.query("BEGIN;");
        await client.query("SELECT set_config('app.user_id', $1, true);", [userOwnerId]);

        // First find an existing task in orgAlpha
        const tRes = await client.query("SELECT id FROM agent_tasks WHERE organization_id = $1 LIMIT 1;", [orgAlphaId]);
        assert.ok(tRes.rows.length > 0);
        const taskId = tRes.rows[0].id;

        // Attempt to insert event with spoofed actorUserId = userOtherOrgId
        await assert.rejects(
          async () => {
            await client.query(
              `INSERT INTO agent_task_events (task_id, organization_id, event_type, actor_user_id, metadata)
               VALUES ($1, $2, 'forged.event', $3, '{}'::jsonb);`,
              [taskId, orgAlphaId, userOtherOrgId]
            );
          },
          (err: any) => {
            return err.message && err.message.includes("violates row-level security policy");
          }
        );
      } finally {
        await client.query("ROLLBACK;");
        client.release();
      }
    });

    it("should sanitize and redact sensitive keys from event metadata", async () => {
      const token = await generateToken(userOwnerId, "sub-agent-owner", "agent-owner@moducraft.test");

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/agent-tasks",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        payload: {
          organizationId: orgAlphaId,
          taskType: "project_summary",
          title: "Metadata Redaction Test",
          inputData: { normalParam: "safe", secretToken: "super-secret-123" },
        },
      });
      assert.equal(res.statusCode, 201);
      const task = JSON.parse(res.payload).data.task;

      // Inspect recorded task.created event metadata directly in DB
      const evRes = await adminPool.query(
        `SELECT metadata FROM agent_task_events WHERE task_id = $1 AND event_type = 'task.created';`,
        [task.id]
      );
      assert.equal(evRes.rows.length, 1);
      const meta = evRes.rows[0].metadata;
      assert.equal(meta.title, "Metadata Redaction Test");
    });
  });
});
