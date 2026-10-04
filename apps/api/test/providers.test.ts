import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import pg from "pg";
import * as jose from "jose";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { JoseJwtVerifier } from "../src/auth/verifier.js";
import { createDatabasePool } from "../src/db/pool.js";
import { getTestDatabaseUrls } from "./helpers/test-db-guard.js";
import {
  encryptSecret,
  decryptSecret,
  maskApiKey,
  validateProviderBaseUrl,
  AIProviderService,
  MockAIProviderAdapter,
  ProviderBudgetExceededError,
  ProviderAuthenticationError,
} from "../src/modules/providers/index.js";
import { ConfigurationError, ValidationError, ForbiddenError } from "../src/errors/app-errors.js";

const { Pool } = pg;

describe("AI Provider Abstraction Integration Tests (Phase 4B)", () => {
  // Test encryption key: 32 bytes (64 hex characters)
  const testEncryptionKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.PROVIDER_ENCRYPTION_KEY = testEncryptionKey;
  process.env.NODE_ENV = "test";

  const { runtimeDbUrl, superuserDbUrl } = getTestDatabaseUrls();

  const secretKey = "provider-abstraction-test-secret-key-4b!";
  const issuer = "https://auth.moducraft.test";
  const audience = "moducraft-api";

  // Test users (isolated bbbbbbbb prefix to avoid parallel test collisions)
  const userOwnerId = "bbbbbbbb-1111-4000-8000-000000000001";
  const userMemberId = "bbbbbbbb-2222-4000-8000-000000000002";
  const userViewerId = "bbbbbbbb-3333-4000-8000-000000000003";
  const userOtherOrgId = "bbbbbbbb-4444-4000-8000-000000000004";

  // Test organizations (isolated cccccccc prefix)
  const orgAlphaId = "cccccccc-aaaa-4000-8000-000000000001";
  const orgBetaId = "cccccccc-bbbb-4000-8000-000000000002";

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
        ($1, $5, 'sub-prov-owner', 'prov-owner@moducraft.test', 'Provider Owner'),
        ($2, $5, 'sub-prov-member', 'prov-member@moducraft.test', 'Provider Member'),
        ($3, $5, 'sub-prov-viewer', 'prov-viewer@moducraft.test', 'Provider Viewer'),
        ($4, $5, 'sub-prov-other', 'prov-other@moducraft.test', 'Other Org User')
      ON CONFLICT (id) DO NOTHING;
      `,
      [userOwnerId, userMemberId, userViewerId, userOtherOrgId, issuer]
    );

    // Seed organizations
    await adminPool.query(
      `
      INSERT INTO organizations(id, name, slug, created_by)
      VALUES 
        ($1, 'Provider Org Alpha', 'provider-org-alpha', $3),
        ($2, 'Provider Org Beta', 'provider-org-beta', $4)
      ON CONFLICT (id) DO NOTHING;
      `,
      [orgAlphaId, orgBetaId, userOwnerId, userOtherOrgId]
    );

    // Seed memberships
    await adminPool.query(
      `
      INSERT INTO organization_memberships(organization_id, user_id, role)
      VALUES 
        ($1, $2, 'owner'),
        ($1, $3, 'member'),
        ($1, $4, 'viewer'),
        ($5, $6, 'owner')
      ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role;
      `,
      [orgAlphaId, userOwnerId, userMemberId, userViewerId, orgBetaId, userOtherOrgId]
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
    await adminPool.query(`DELETE FROM provider_usage_records WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
    await adminPool.query(`DELETE FROM agent_tasks WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
    await adminPool.query(`DELETE FROM provider_configs WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
    await adminPool.query(`DELETE FROM organization_memberships WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
    await adminPool.query(`DELETE FROM organizations WHERE id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
    await adminPool.query(`DELETE FROM app_users WHERE id IN ($1, $2, $3, $4);`, [
      userOwnerId,
      userMemberId,
      userViewerId,
      userOtherOrgId,
    ]);
    await runtimePool.end();
    await adminPool.end();
  });

  const userMap: Record<string, { sub: string; email: string }> = {
    [userOwnerId]: { sub: "sub-prov-owner", email: "prov-owner@moducraft.test" },
    [userMemberId]: { sub: "sub-prov-member", email: "prov-member@moducraft.test" },
    [userViewerId]: { sub: "sub-prov-viewer", email: "prov-viewer@moducraft.test" },
    [userOtherOrgId]: { sub: "sub-prov-other", email: "prov-other@moducraft.test" },
  };

  async function createToken(userId: string): Promise<string> {
    const user = userMap[userId] ?? { sub: `sub-${userId}`, email: `${userId}@moducraft.test` };
    const rawSecret = new TextEncoder().encode(secretKey);
    return new jose.SignJWT({
      sub: user.sub,
      email: user.email,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("2h")
      .sign(rawSecret);
  }

  // =========================================================================
  // 1. CRYPTOGRAPHIC & SECRETS MANAGEMENT UNIT TESTS
  // =========================================================================
  describe("1. Cryptographic & Secrets Management (AES-256-GCM + Tenant AAD)", () => {
    it("should encrypt and decrypt secrets cleanly with matching tenant AAD", () => {
      const plaintext = "sk-live-moducraft-secret-api-key-123456789";
      const tenantAad = orgAlphaId;

      const encrypted = encryptSecret(plaintext, tenantAad);
      assert.ok(encrypted.startsWith("v1:"));
      assert.notEqual(encrypted, plaintext);

      const decrypted = decryptSecret(encrypted, tenantAad);
      assert.strictEqual(decrypted, plaintext);
    });

    it("should reject decryption if cross-tenant AAD mismatch occurs (tamper protection)", () => {
      const plaintext = "sk-live-moducraft-secret-key-org-alpha";
      const encrypted = encryptSecret(plaintext, orgAlphaId);

      // Attempting to decrypt with Org Beta's ID must fail
      assert.throws(
        () => {
          decryptSecret(encrypted, orgBetaId);
        },
        /Secret decryption failed/
      );
    });

    it("should reject decryption if ciphertext or auth tag is corrupted", () => {
      const plaintext = "sk-sensitive-value-to-corrupt";
      const encrypted = encryptSecret(plaintext, orgAlphaId);
      const parts = encrypted.split(":");
      // parts: [v1, ivHex, tagHex, cipherHex]
      // Corrupt 1 char in ciphertext
      const corruptedCipher = parts[3].slice(0, -2) + (parts[3].slice(-2) === "aa" ? "bb" : "aa");
      const corruptedPayload = `${parts[0]}:${parts[1]}:${parts[2]}:${corruptedCipher}`;

      assert.throws(
        () => {
          decryptSecret(corruptedPayload, orgAlphaId);
        },
        /Secret decryption failed/
      );
    });

    it("should fail closed if encryption key is missing or invalid length", () => {
      const oldKey = process.env.PROVIDER_ENCRYPTION_KEY;
      try {
        delete process.env.PROVIDER_ENCRYPTION_KEY;
        assert.throws(
          () => {
            encryptSecret("test-secret", orgAlphaId);
          },
          (err: any) => err instanceof ConfigurationError
        );

        process.env.PROVIDER_ENCRYPTION_KEY = "too-short-key";
        assert.throws(
          () => {
            encryptSecret("test-secret", orgAlphaId);
          },
          (err: any) => err instanceof ConfigurationError
        );
      } finally {
        process.env.PROVIDER_ENCRYPTION_KEY = oldKey;
      }
    });

    it("should safely mask API keys without leaking secrets", () => {
      const masked1 = maskApiKey("sk-proj-1234567890abcdef");
      assert.strictEqual(masked1.prefix, "sk-p");
      assert.strictEqual(masked1.suffix, "cdef");

      const maskedShort = maskApiKey("short");
      assert.strictEqual(maskedShort.prefix, "sh");
      assert.strictEqual(maskedShort.suffix, "rt");
    });
  });

  // =========================================================================
  // 2. SSRF VALIDATOR UNIT TESTS
  // =========================================================================
  describe("2. SSRF & Unsafe Endpoint Protection", () => {
    it("should block loopback and local addresses (127.0.0.1, localhost, ::1)", async () => {
      await assert.rejects(
        () => validateProviderBaseUrl("https://127.0.0.1:8080/v1"),
        (err: any) => err instanceof ValidationError && (err.message.includes("private") || err.message.includes("reserved"))
      );
      await assert.rejects(
        () => validateProviderBaseUrl("https://localhost:3000"),
        (err: any) => err instanceof ValidationError && (err.message.includes("private") || err.message.includes("reserved") || err.message.includes("SSRF"))
      );
    });

    it("should block RFC 1918 private IP addresses (10.x, 172.16.x, 192.168.x)", async () => {
      await assert.rejects(
        () => validateProviderBaseUrl("https://10.0.0.1/v1"),
        (err: any) => err instanceof ValidationError && err.message.includes("private")
      );
      await assert.rejects(
        () => validateProviderBaseUrl("https://172.16.0.1/v1"),
        (err: any) => err instanceof ValidationError && err.message.includes("private")
      );
      await assert.rejects(
        () => validateProviderBaseUrl("https://192.168.1.1/v1"),
        (err: any) => err instanceof ValidationError && err.message.includes("private")
      );
    });

    it("should block cloud metadata endpoints (169.254.169.254, metadata.google.internal)", async () => {
      await assert.rejects(
        () => validateProviderBaseUrl("https://169.254.169.254/latest/meta-data/"),
        (err: any) => err instanceof ValidationError && (err.message.includes("private") || err.message.includes("reserved"))
      );
      await assert.rejects(
        () => validateProviderBaseUrl("https://metadata.google.internal/computeMetadata/v1"),
        (err: any) => err instanceof ValidationError && err.message.includes("internal")
      );
    });

    it("should reject non-HTTP protocols and embedded userinfo credentials", async () => {
      await assert.rejects(
        () => validateProviderBaseUrl("file:///etc/passwd"),
        (err: any) => err instanceof ValidationError && err.message.includes("HTTPS")
      );
      await assert.rejects(
        () => validateProviderBaseUrl("https://admin:secret@example.com/v1"),
        (err: any) => err instanceof ValidationError && err.message.includes("credentials")
      );
    });

    it("should allow public HTTPS endpoints", async () => {
      const validated = await validateProviderBaseUrl("https://api.openai.com/v1", {
        dnsLookup: async () => [{ address: "104.18.7.192", family: 4 }],
      });
      assert.strictEqual(validated, "https://api.openai.com/v1");
    });
  });

  // =========================================================================
  // 3. PROVIDER CONFIG API INTEGRATION TESTS (CRUD + Authorization + Forced RLS)
  // =========================================================================
  describe("3. Provider Configuration CRUD API & Authorization", () => {
    let createdConfigId: string;

    it("should allow organization owner to create provider configuration", async () => {
      const token = await createToken(userOwnerId);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/provider-configs",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          organizationId: orgAlphaId,
          providerType: "mock",
          name: "Alpha Mock Provider",
          baseUrl: "https://api.moducraft.test/v1",
          modelId: "gpt-4o-mock",
          apiKey: "sk-alpha-mock-secret-key-12345",
          tokenBudgetMonthly: 50000,
        },
      });

      assert.strictEqual(res.statusCode, 201);
      const body = res.json();
      assert.ok(body.data.providerConfig.id);
      assert.strictEqual(body.data.providerConfig.name, "Alpha Mock Provider");
      assert.strictEqual(body.data.providerConfig.keyPrefix, "sk-a");
      assert.strictEqual(body.data.providerConfig.keySuffix, "2345");
      assert.strictEqual(body.data.providerConfig.tokenBudgetMonthly, 50000);
      assert.strictEqual(body.data.providerConfig.tokensUsedMonth, 0);

      // CRITICAL: Plaintext API key and ciphertext must NEVER be returned in response!
      assert.strictEqual((body.data.providerConfig as any).apiKey, undefined);
      assert.strictEqual((body.data.providerConfig as any).encryptedApiKey, undefined);

      createdConfigId = body.data.providerConfig.id;
    });

    it("should deny organization viewer from creating provider configuration (403)", async () => {
      const token = await createToken(userViewerId);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/provider-configs",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          organizationId: orgAlphaId,
          providerType: "mock",
          name: "Unauthorized Config",
          baseUrl: "https://api.moducraft.test/v1",
          modelId: "mock-model",
          apiKey: "sk-unauthorized",
        },
      });

      assert.strictEqual(res.statusCode, 403);
    });

    it("should allow organization member to read provider configuration list without secrets", async () => {
      const token = await createToken(userMemberId);
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/provider-configs?organizationId=${orgAlphaId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      assert.strictEqual(res.statusCode, 200);
      const body = res.json();
      assert.ok(Array.isArray(body.data.providerConfigs));
      assert.strictEqual(body.data.providerConfigs.length, 1);
      assert.strictEqual(body.data.providerConfigs[0].id, createdConfigId);
      assert.strictEqual(body.data.providerConfigs[0].keyPrefix, "sk-a");
      assert.strictEqual((body.data.providerConfigs[0] as any).apiKey, undefined);
    });

    it("should prevent cross-tenant access to provider configs (Org Beta user gets empty list/404)", async () => {
      const token = await createToken(userOtherOrgId); // Owner of Org Beta

      // Attempt to get Org Alpha's provider config directly
      const resGet = await app.inject({
        method: "GET",
        url: `/api/v1/provider-configs/${createdConfigId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.strictEqual(resGet.statusCode, 404);

      // Attempt to list Org Alpha's provider configs as Org Beta user: returns 404 (anti-enumeration)
      const resList = await app.inject({
        method: "GET",
        url: `/api/v1/provider-configs?organizationId=${orgAlphaId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.strictEqual(resList.statusCode, 404);

      // Listing Org Beta's own provider configs returns 200 with empty list
      const resListBeta = await app.inject({
        method: "GET",
        url: `/api/v1/provider-configs?organizationId=${orgBetaId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.strictEqual(resListBeta.statusCode, 200);
      assert.strictEqual(resListBeta.json().data.providerConfigs.length, 0);
    });

    it("should allow updating configuration and rotating API key", async () => {
      const token = await createToken(userOwnerId);
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/provider-configs/${createdConfigId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: "Alpha Mock Provider Updated",
          apiKey: "sk-rotated-new-key-9999",
          tokenBudgetMonthly: 100000,
        },
      });

      assert.strictEqual(res.statusCode, 200);
      const body = res.json();
      assert.strictEqual(body.data.providerConfig.name, "Alpha Mock Provider Updated");
      assert.strictEqual(body.data.providerConfig.keyPrefix, "sk-r");
      assert.strictEqual(body.data.providerConfig.keySuffix, "9999");
      assert.strictEqual(body.data.providerConfig.tokenBudgetMonthly, 100000);
    });

    it("should test connection to provider successfully without leaking secrets", async () => {
      const token = await createToken(userOwnerId);
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/provider-configs/${createdConfigId}/test-connection`,
        headers: { authorization: `Bearer ${token}` },
      });

      assert.strictEqual(res.statusCode, 200);
      const body = res.json();
      assert.strictEqual(body.data.testResult.success, true);
      assert.strictEqual(body.data.testResult.model, "gpt-4o-mock");
      assert.ok(typeof body.data.testResult.latencyMs === "number");
    });
  });

  // =========================================================================
  // 4. BUDGET ACCOUNTING & ATOMIC USAGE ENFORCEMENT
  // =========================================================================
  describe("4. Concurrency-Safe Budget Accounting & Usage Ledger", () => {
    let budgetTestConfigId: string;

    before(async () => {
      const token = await createToken(userOwnerId);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/provider-configs",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          organizationId: orgAlphaId,
          providerType: "mock",
          name: "Budget Test Provider",
          baseUrl: "https://api.moducraft.test/v1",
          modelId: "gpt-4o-mock",
          apiKey: "sk-budget-test-key-12345",
          tokenBudgetMonthly: 100, // Small budget: 100 tokens
        },
      });
      if (res.statusCode !== 201) {
        console.error("Suite 4 POST provider-configs returned:", res.statusCode, JSON.stringify(res.json()));
      }
      budgetTestConfigId = res.json().data?.providerConfig?.id;
    });

    it("should execute AI task and record usage within budget", async () => {
      const token = await createToken(userOwnerId);

      // Create an AI task referencing this provider config
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/agent-tasks",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          organizationId: orgAlphaId,
          providerConfigId: budgetTestConfigId,
          taskType: "ai_text_generation",
          title: "Generate AI Architecture Notes",
          inputData: {
            messages: [{ role: "user", content: "Summarize modular architecture" }],
          },
        },
      });

      assert.strictEqual(createRes.statusCode, 201);
      const taskId = createRes.json().data.task.id;
      assert.strictEqual(createRes.json().data.task.providerConfigId, budgetTestConfigId);

      // Run step 1 (ai_chat_completion)
      const runRes = await app.inject({
        method: "POST",
        url: `/api/v1/agent-tasks/${taskId}/run`,
        headers: { authorization: `Bearer ${token}` },
      });

      assert.strictEqual(runRes.statusCode, 200);
      const updatedTask = runRes.json().data.task;
      assert.strictEqual(updatedTask.status, "running");
      const step1 = updatedTask.steps.find((s: any) => s.stepKey === "generate_ai_response");
      assert.strictEqual(step1.status, "succeeded");
      assert.ok(step1.resultData.usage.totalTokens > 0);

      // Verify provider usage ledger in database
      const usageRes = await adminPool.query(
        `SELECT * FROM provider_usage_records WHERE provider_config_id = $1;`,
        [budgetTestConfigId]
      );
      assert.strictEqual(usageRes.rows.length, 1);
      assert.strictEqual(usageRes.rows[0].organization_id, orgAlphaId);
      assert.strictEqual(usageRes.rows[0].task_id, taskId);

      // Verify tokens_used_month incremented on provider config
      const configRes = await adminPool.query(
        `SELECT tokens_used_month FROM provider_configs WHERE id = $1;`,
        [budgetTestConfigId]
      );
      assert.ok(Number(configRes.rows[0].tokens_used_month) > 0);
    });

    it("should reject AI task execution when monthly token budget is exceeded", async () => {
      const token = await createToken(userOwnerId);

      // Manually set tokens_used_month to budget limit (100)
      await adminPool.query(
        `UPDATE provider_configs SET tokens_used_month = 100 WHERE id = $1;`,
        [budgetTestConfigId]
      );

      // Create new AI task
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/agent-tasks",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          organizationId: orgAlphaId,
          providerConfigId: budgetTestConfigId,
          taskType: "ai_text_generation",
          title: "Overbudget Task Attempt",
          inputData: {
            messages: [{ role: "user", content: "This should fail due to budget exhaustion" }],
          },
        },
      });

      const taskId = createRes.json().data.task.id;

      // Run task: step should fail with PROVIDER_BUDGET_EXCEEDED
      const runRes = await app.inject({
        method: "POST",
        url: `/api/v1/agent-tasks/${taskId}/run`,
        headers: { authorization: `Bearer ${token}` },
      });

      assert.strictEqual(runRes.statusCode, 200);
      const updatedTask = runRes.json().data.task;
      assert.strictEqual(updatedTask.status, "failed");
      const step1 = updatedTask.steps.find((s: any) => s.stepKey === "generate_ai_response");
      assert.strictEqual(step1.status, "failed");
      assert.strictEqual(step1.errorCode, "PROVIDER_BUDGET_EXCEEDED");
    });
  });

  // =========================================================================
  // 5. ORCHESTRATOR INTEGRATION & EXPLICIT APPROVAL HOOKS
  // =========================================================================
  describe("5. Orchestrator Integration & Approval Hooks", () => {
    it("should prevent task in Org Alpha from referencing provider config in Org Beta", async () => {
      const token = await createToken(userOtherOrgId); // Org Beta owner
      // Create a config in Org Beta
      const betaConfigRes = await app.inject({
        method: "POST",
        url: "/api/v1/provider-configs",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          organizationId: orgBetaId,
          providerType: "mock",
          name: "Beta Mock Provider",
          baseUrl: "https://api.moducraft.test/v1",
          modelId: "gpt-4o-mock",
          apiKey: "sk-beta-secret",
        },
      });
      const betaConfigId = betaConfigRes.json().data.providerConfig.id;

      // Attempt to create a task in Org Alpha pointing to Org Beta's providerConfigId
      const alphaOwnerToken = await createToken(userOwnerId);
      const attackRes = await app.inject({
        method: "POST",
        url: "/api/v1/agent-tasks",
        headers: { authorization: `Bearer ${alphaOwnerToken}` },
        payload: {
          organizationId: orgAlphaId,
          providerConfigId: betaConfigId,
          taskType: "project_summary",
          title: "Cross-Tenant Credential Attack",
        },
      });

      assert.strictEqual(attackRes.statusCode, 404);
    });

    it("should transition to waiting_for_approval when step requires approval, and resume on explicit approve", async () => {
      const token = await createToken(userOwnerId);

      // Create a standard deterministic task
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/agent-tasks",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          organizationId: orgAlphaId,
          taskType: "project_summary",
          title: "Approval Hook Test Task",
        },
      });

      const taskId = createRes.json().data.task.id;

      // Manually set step 1 inputData to require approval
      await adminPool.query(
        `UPDATE agent_task_steps SET input_data = '{"requiresApproval": true}'::jsonb WHERE task_id = $1 AND position = 1;`,
        [taskId]
      );

      // Run task: should pause in waiting_for_approval state
      const runRes = await app.inject({
        method: "POST",
        url: `/api/v1/agent-tasks/${taskId}/run`,
        headers: { authorization: `Bearer ${token}` },
      });

      assert.strictEqual(runRes.statusCode, 200);
      assert.strictEqual(runRes.json().data.task.status, "waiting_for_approval");

      // Attempting to run again while waiting for approval must not execute
      const reRunRes = await app.inject({
        method: "POST",
        url: `/api/v1/agent-tasks/${taskId}/run`,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.strictEqual(reRunRes.json().data.task.status, "waiting_for_approval");

      // Approve task via explicit approval hook: POST /api/v1/agent-tasks/:id/approve
      const approveRes = await app.inject({
        method: "POST",
        url: `/api/v1/agent-tasks/${taskId}/approve`,
        headers: { authorization: `Bearer ${token}` },
      });

      assert.strictEqual(approveRes.statusCode, 200);
      assert.strictEqual(approveRes.json().data.task.status, "running");

      // Now run again: step executes successfully
      const resumedRun = await app.inject({
        method: "POST",
        url: `/api/v1/agent-tasks/${taskId}/run`,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.strictEqual(resumedRun.statusCode, 200);
      const step1 = resumedRun.json().data.task.steps.find((s: any) => s.position === 1);
      assert.strictEqual(step1.status, "succeeded");
    });
  });

  // =========================================================================
  // 6. REVOCATION & AUDIT TRAIL VERIFICATION
  // =========================================================================
  describe("6. Revocation & Audit Verification", () => {
    it("should revoke provider configuration and verify audit logs contain no secrets", async () => {
      const token = await createToken(userOwnerId);

      // Create a temporary config to delete
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/provider-configs",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          organizationId: orgAlphaId,
          providerType: "mock",
          name: "Config to Revoke",
          baseUrl: "https://api.moducraft.test/v1",
          modelId: "gpt-4o-mock",
          apiKey: "sk-super-secret-to-revoke-12345",
        },
      });

      const configId = createRes.json().data.providerConfig.id;

      // Delete / Revoke
      const deleteRes = await app.inject({
        method: "DELETE",
        url: `/api/v1/provider-configs/${configId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      assert.strictEqual(deleteRes.statusCode, 200);

      // Subsequent get must return 404
      const getRes = await app.inject({
        method: "GET",
        url: `/api/v1/provider-configs/${configId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.strictEqual(getRes.statusCode, 404);

      // Verify audit events recorded for provider configs
      const auditRes = await adminPool.query(
        `SELECT action, resource_type, resource_id, outcome, metadata
         FROM audit_events
         WHERE organization_id = $1 AND resource_type = 'provider_config'
         ORDER BY created_at DESC;`,
        [orgAlphaId]
      );

      assert.ok(auditRes.rows.length >= 2);
      for (const row of auditRes.rows) {
        const metaStr = JSON.stringify(row.metadata);
        assert.ok(!metaStr.includes("sk-super-secret"), "Audit metadata must never contain secret keys");
        assert.ok(!metaStr.includes("sk-alpha-mock"), "Audit metadata must never contain secret keys");
        assert.ok(!metaStr.includes("encrypted_api_key"), "Audit metadata must never contain encrypted ciphertext");
      }
    });
  });
});
