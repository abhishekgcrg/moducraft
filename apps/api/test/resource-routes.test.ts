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

describe("Cloud Resource Inventory & Credentials API Integration Tests (Task 5.3)", () => {
  const { runtimeDbUrl, superuserDbUrl } = getTestDatabaseUrls();

  const secretKey = "resource-api-test-secret-key-moducraft-53!";
  const issuer = "https://auth.moducraft.test";
  const audience = "moducraft-api";

  // Test users
  const userOwnerId = "55555555-1111-4000-8000-000000000001";
  const userMemberId = "55555555-2222-4000-8000-000000000002";
  const userViewerId = "55555555-3333-4000-8000-000000000003";
  const userBetaOwnerId = "55555555-4444-4000-8000-000000000004";

  // Test organizations
  const orgAlphaId = "66666666-aaaa-4000-8000-000000000001";
  const orgBetaId = "66666666-bbbb-4000-8000-000000000002";

  // Test projects
  const projectAlphaId = "77777777-aaaa-4000-8000-000000000001";
  const projectBetaId = "77777777-bbbb-4000-8000-000000000002";

  let runtimePool: pg.Pool;
  let adminPool: pg.Pool;
  let app: FastifyInstance;
  let configuredVerifier: JoseJwtVerifier;

  let createdResourceId: string;

  before(async () => {
    runtimePool = createDatabasePool(runtimeDbUrl);
    adminPool = new Pool({ connectionString: superuserDbUrl, max: 2 });

    await cleanupTestData();

    // Seed test users
    await adminPool.query(
      `
      INSERT INTO app_users(id, identity_issuer, identity_subject, email, display_name)
      VALUES 
        ($1, $5, 'sub-route-res-owner', 'owner@route-res-test.test', 'Res Route Owner'),
        ($2, $5, 'sub-route-res-member', 'member@route-res-test.test', 'Res Route Member'),
        ($3, $5, 'sub-route-res-viewer', 'viewer@route-res-test.test', 'Res Route Viewer'),
        ($4, $5, 'sub-route-res-beta', 'beta@route-res-test.test', 'Beta Route Owner')
      ON CONFLICT (id) DO NOTHING;
      `,
      [userOwnerId, userMemberId, userViewerId, userBetaOwnerId, issuer]
    );

    // Seed organizations
    await adminPool.query(
      `
      INSERT INTO organizations(id, name, slug, created_by)
      VALUES 
        ($1, 'Alpha Route Cloud Corp', 'alpha-route-cloud', $3),
        ($2, 'Beta Route Cloud Corp', 'beta-route-cloud', $4)
      ON CONFLICT (id) DO NOTHING;
      `,
      [orgAlphaId, orgBetaId, userOwnerId, userBetaOwnerId]
    );

    // Seed memberships:
    // Org Alpha: Owner, Member, Viewer
    // Org Beta: Beta Owner
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
      [orgAlphaId, orgBetaId, userOwnerId, userMemberId, userViewerId, userBetaOwnerId]
    );

    // Seed projects
    await adminPool.query(
      `
      INSERT INTO projects(id, organization_id, name, slug, created_by)
      VALUES 
        ($1, $3, 'Alpha Route Project', 'alpha-route-project', $5),
        ($2, $4, 'Beta Route Project', 'beta-route-project', $6)
      ON CONFLICT (id) DO NOTHING;
      `,
      [projectAlphaId, projectBetaId, orgAlphaId, orgBetaId, userOwnerId, userBetaOwnerId]
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

  async function cleanupTestData() {
    const userIds = [userOwnerId, userMemberId, userViewerId, userBetaOwnerId];
    const orgIds = [orgAlphaId, orgBetaId];

    await adminPool.query(
      `DELETE FROM resource_credentials WHERE created_by IN ($1, $2, $3, $4) OR organization_id IN ($5, $6);`,
      [...userIds, ...orgIds]
    );
    await adminPool.query(
      `DELETE FROM project_resources WHERE created_by IN ($1, $2, $3, $4) OR organization_id IN ($5, $6);`,
      [...userIds, ...orgIds]
    );
    await adminPool.query(
      `DELETE FROM projects WHERE created_by IN ($1, $2, $3, $4) OR organization_id IN ($5, $6);`,
      [...userIds, ...orgIds]
    );
    await adminPool.query(
      `DELETE FROM organization_memberships WHERE user_id IN ($1, $2, $3, $4) OR organization_id IN ($5, $6);`,
      [...userIds, ...orgIds]
    );
    await adminPool.query(
      `DELETE FROM organizations WHERE created_by IN ($1, $2, $3, $4) OR id IN ($5, $6);`,
      [...userIds, ...orgIds]
    );
    await adminPool.query(
      `DELETE FROM app_users WHERE id IN ($1, $2, $3, $4) OR (identity_issuer = $5 AND identity_subject IN ('sub-route-res-owner', 'sub-route-res-member', 'sub-route-res-viewer', 'sub-route-res-beta'));`,
      [...userIds, issuer]
    );
  }

  after(async () => {
    await app.close();
    await cleanupTestData();
    await adminPool.end();
    await runtimePool.end();
  });

  async function createTestToken(sub: string) {
    const secretBytes = new TextEncoder().encode(secretKey);
    return new jose.SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(sub)
      .setExpirationTime("1h")
      .sign(secretBytes);
  }

  // =========================================================================
  // 1. AUTHENTICATION & INPUT VALIDATION
  // =========================================================================
  describe("1. Authentication & Security Gate", () => {
    it("1.1 should reject unauthenticated requests with 401 Unauthorized", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectAlphaId}/resources`,
        payload: {
          providerId: "docker-postgres",
          resourceType: "database",
          name: "unauth-db",
        },
      });

      assert.strictEqual(res.statusCode, 401);
    });

    it("1.2 should reject invalid project UUID with 400 Bad Request", async () => {
      const token = await createTestToken("sub-route-res-owner");
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/projects/not-a-uuid/resources`,
        headers: { authorization: `Bearer ${token}` },
      });

      assert.strictEqual(res.statusCode, 400);
    });
  });

  // =========================================================================
  // 2. RESOURCE PROVISIONING & SECRET PREVENTION (SEC-5.2-01)
  // =========================================================================
  describe("2. Resource Provisioning & Secret Leak Prevention", () => {
    it("2.1 should allow organization owner to provision database resource with initial password", async () => {
      const token = await createTestToken("sub-route-res-owner");
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectAlphaId}/resources`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          providerId: "docker-postgres",
          resourceType: "database",
          name: "alpha-primary-db",
          configuration: {
            engine: "postgres",
            version: "16",
            ports: [5432],
            public_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5",
          },
          endpoint: {
            host: "127.0.0.1",
            port: 5432,
            database: "alpha_prod",
          },
          initialPassword: "super-secret-password-initial",
          username: "db_admin",
          connectionStringTemplate: "postgresql://{username}:{password}@127.0.0.1:5432/alpha_prod",
        },
      });

      assert.strictEqual(res.statusCode, 201);
      const body = res.json();
      assert.ok(body.data.resource.id);
      assert.strictEqual(body.data.resource.name, "alpha-primary-db");
      assert.strictEqual(body.data.resource.resourceType, "database");
      assert.strictEqual(body.data.resource.status, "active");

      // CRITICAL: Ensure plaintext initialPassword is NOT returned in public resource DTO!
      assert.strictEqual(body.data.resource.password, undefined);
      assert.strictEqual(body.data.resource.encrypted_password, undefined);
      assert.strictEqual(body.data.resource.initialPassword, undefined);

      createdResourceId = body.data.resource.id;
    });

    it("2.2 should reject plaintext password in configuration with 400 Bad Request (SEC-5.2-01)", async () => {
      const token = await createTestToken("sub-route-res-owner");
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectAlphaId}/resources`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          providerId: "docker-postgres",
          resourceType: "database",
          name: "leak-attempt-1",
          configuration: {
            password: "raw-password-forbidden",
          },
        },
      });

      assert.strictEqual(res.statusCode, 400);
      const body = res.json();
      assert.ok(body.error.message.includes("password"));
      // Security invariant: secret value MUST NOT be reflected in error message!
      assert.ok(!body.error.message.includes("raw-password-forbidden"));
    });

    it("2.3 should reject array-nested secrets in configuration with 400 Bad Request (SEC-5.2-01)", async () => {
      const token = await createTestToken("sub-route-res-owner");
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectAlphaId}/resources`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          providerId: "docker-postgres",
          resourceType: "database",
          name: "leak-attempt-2",
          configuration: {
            connectors: [
              { name: "replica-1", host: "10.0.0.1" },
              { name: "replica-2", password: "array-password-leak" },
            ],
          },
        },
      });

      assert.strictEqual(res.statusCode, 400);
      const body = res.json();
      assert.ok(body.error.message.includes("password"));
      assert.ok(body.error.message.includes("configuration.connectors[1]"));
      assert.ok(!body.error.message.includes("array-password-leak"));
    });

    it("2.4 should reject delimiter key variant (api-key) with 400 Bad Request", async () => {
      const token = await createTestToken("sub-route-res-owner");
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectAlphaId}/resources`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          providerId: "docker-postgres",
          resourceType: "database",
          name: "leak-attempt-3",
          configuration: {
            "api-key": "secret-api-token",
          },
        },
      });

      assert.strictEqual(res.statusCode, 400);
      const body = res.json();
      assert.ok(body.error.message.includes("api-key"));
      assert.ok(!body.error.message.includes("secret-api-token"));
    });

    it("2.5 should allow organization member to provision resource", async () => {
      const token = await createTestToken("sub-route-res-member");
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectAlphaId}/resources`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          providerId: "docker-postgres",
          resourceType: "object_storage",
          name: "alpha-assets-bucket",
          configuration: {
            bucket: "alpha-assets",
            publicAccess: false,
          },
        },
      });

      assert.strictEqual(res.statusCode, 201);
      const body = res.json();
      assert.strictEqual(body.data.resource.name, "alpha-assets-bucket");
    });

    it("2.6 should deny organization viewer from provisioning resource (403 Forbidden)", async () => {
      const token = await createTestToken("sub-route-res-viewer");
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectAlphaId}/resources`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          providerId: "docker-postgres",
          resourceType: "database",
          name: "viewer-unauth-db",
        },
      });

      assert.strictEqual(res.statusCode, 403);
    });
  });

  // =========================================================================
  // 3. RESOURCE LISTING & RETRIEVAL (Forced RLS)
  // =========================================================================
  describe("3. Resource Listing & Retrieval", () => {
    it("3.1 should allow organization member to list resources under project", async () => {
      const token = await createTestToken("sub-route-res-member");
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectAlphaId}/resources`,
        headers: { authorization: `Bearer ${token}` },
      });

      assert.strictEqual(res.statusCode, 200);
      const body = res.json();
      assert.ok(Array.isArray(body.data.resources));
      assert.ok(body.data.resources.length >= 2);

      // Verify no password or secret leaks in list responses
      for (const r of body.data.resources) {
        assert.strictEqual(r.password, undefined);
        assert.strictEqual(r.encrypted_password, undefined);
      }
    });

    it("3.2 should allow filtering resources by resourceType", async () => {
      const token = await createTestToken("sub-route-res-member");
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectAlphaId}/resources?resourceType=database`,
        headers: { authorization: `Bearer ${token}` },
      });

      assert.strictEqual(res.statusCode, 200);
      const body = res.json();
      assert.ok(body.data.resources.every((r: any) => r.resourceType === "database"));
    });

    it("3.3 should allow organization member to get single resource details", async () => {
      const token = await createTestToken("sub-route-res-member");
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectAlphaId}/resources/${createdResourceId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      assert.strictEqual(res.statusCode, 200);
      const body = res.json();
      assert.strictEqual(body.data.resource.id, createdResourceId);
      assert.strictEqual(body.data.resource.name, "alpha-primary-db");
    });

    it("3.4 should return 404 for nonexistent resource ID", async () => {
      const token = await createTestToken("sub-route-res-member");
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectAlphaId}/resources/00000000-0000-0000-0000-000000000000`,
        headers: { authorization: `Bearer ${token}` },
      });

      assert.strictEqual(res.statusCode, 404);
    });
  });

  // =========================================================================
  // 4. CREDENTIAL REVEAL & AUTONOMOUS AUDITING
  // =========================================================================
  describe("4. Credential Reveal & Autonomous Auditing", () => {
    it("4.1 should allow organization owner to reveal decrypted credentials and log success audit event", async () => {
      const token = await createTestToken("sub-route-res-owner");
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectAlphaId}/resources/${createdResourceId}/credentials`,
        headers: { authorization: `Bearer ${token}` },
      });

      assert.strictEqual(res.statusCode, 200);
      const body = res.json();
      assert.strictEqual(body.data.credentials.username, "db_admin");
      assert.strictEqual(body.data.credentials.password, "super-secret-password-initial");
      assert.strictEqual(
        body.data.credentials.connectionString,
        "postgresql://db_admin:super-secret-password-initial@127.0.0.1:5432/alpha_prod"
      );

      // Verify audit event in audit_events table
      const auditRes = await adminPool.query(
        `SELECT action, outcome, metadata 
         FROM audit_events 
         WHERE organization_id = $1 AND action = 'resource.credentials.revealed' AND outcome = 'success'
         ORDER BY created_at DESC LIMIT 1;`,
        [orgAlphaId]
      );
      assert.strictEqual(auditRes.rows.length, 1);
      const meta = auditRes.rows[0].metadata;
      assert.strictEqual(meta.resourceId, createdResourceId);
      // Ensure audit metadata does NOT contain plaintext password or ciphertext
      assert.strictEqual(meta.password, undefined);
      assert.strictEqual(meta.connectionString, undefined);
    });

    it("4.2 should deny organization member from revealing credentials (403) and persist autonomous denied audit event", async () => {
      const token = await createTestToken("sub-route-res-member");
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectAlphaId}/resources/${createdResourceId}/credentials`,
        headers: { authorization: `Bearer ${token}` },
      });

      assert.strictEqual(res.statusCode, 403);

      // Autonomous Audit Pattern: denied attempt is persisted even though request failed
      const auditRes = await adminPool.query(
        `SELECT action, outcome, metadata 
         FROM audit_events 
         WHERE organization_id = $1 AND action = 'resource.credentials.revealed' AND outcome = 'denied'
         ORDER BY created_at DESC LIMIT 1;`,
        [orgAlphaId]
      );
      assert.strictEqual(auditRes.rows.length, 1);
      assert.strictEqual(auditRes.rows[0].outcome, "denied");
    });

    it("4.3 should deny organization viewer from revealing credentials (403)", async () => {
      const token = await createTestToken("sub-route-res-viewer");
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectAlphaId}/resources/${createdResourceId}/credentials`,
        headers: { authorization: `Bearer ${token}` },
      });

      assert.strictEqual(res.statusCode, 403);
    });
  });

  // =========================================================================
  // 5. CROSS-TENANT ISOLATION TESTS (SEC-5.2-02)
  // =========================================================================
  describe("5. Cross-Tenant Scope Isolation & Security Probes", () => {
    it("5.1 should deny User Beta from listing resources in Org Alpha's project (404)", async () => {
      const token = await createTestToken("sub-route-res-beta");
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectAlphaId}/resources`,
        headers: { authorization: `Bearer ${token}` },
      });

      // Under RLS, Beta cannot see Alpha project, yielding 404
      assert.strictEqual(res.statusCode, 404);
    });

    it("5.2 should deny User Beta from retrieving single resource in Org Alpha's project (404)", async () => {
      const token = await createTestToken("sub-route-res-beta");
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectAlphaId}/resources/${createdResourceId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      assert.strictEqual(res.statusCode, 404);
    });

    it("5.3 should deny User Beta from revealing credentials of Org Alpha's resource (404)", async () => {
      const token = await createTestToken("sub-route-res-beta");
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectAlphaId}/resources/${createdResourceId}/credentials`,
        headers: { authorization: `Bearer ${token}` },
      });

      assert.strictEqual(res.statusCode, 404);
    });

    it("5.4 should deny User Beta from deprovisioning Org Alpha's resource (404)", async () => {
      const token = await createTestToken("sub-route-res-beta");
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/projects/${projectAlphaId}/resources/${createdResourceId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      assert.strictEqual(res.statusCode, 404);
    });
  });

  // =========================================================================
  // 6. CREDENTIAL ROTATION & CONCURRENT STRESS TEST (SEC-5.2-04)
  // =========================================================================
  describe("6. Credential Rotation & Concurrency", () => {
    it("6.1 should rotate credentials via HTTP endpoint and return summary DTO", async () => {
      const token = await createTestToken("sub-route-res-owner");
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectAlphaId}/resources/${createdResourceId}/rotate`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          newPassword: "rotated-password-version-2",
        },
      });

      assert.strictEqual(res.statusCode, 200);
      const body = res.json();
      assert.strictEqual(body.data.credential.version, 2);
      assert.strictEqual(body.data.credential.status, "active");

      // Verify subsequent reveal yields version 2 password
      const revealRes = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectAlphaId}/resources/${createdResourceId}/credentials`,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.strictEqual(revealRes.statusCode, 200);
      assert.strictEqual(revealRes.json().data.credentials.password, "rotated-password-version-2");
    });

    it("6.2 (SEC-5.2-04) should serialize concurrent rotations with Promise.all and maintain version integrity", async () => {
      const token = await createTestToken("sub-route-res-owner");

      // Issue 2 concurrent rotations
      const [resA, resB] = await Promise.all([
        app.inject({
          method: "POST",
          url: `/api/v1/projects/${projectAlphaId}/resources/${createdResourceId}/rotate`,
          headers: { authorization: `Bearer ${token}` },
          payload: { newPassword: "concurrent-pass-A" },
        }),
        app.inject({
          method: "POST",
          url: `/api/v1/projects/${projectAlphaId}/resources/${createdResourceId}/rotate`,
          headers: { authorization: `Bearer ${token}` },
          payload: { newPassword: "concurrent-pass-B" },
        }),
      ]);

      // Both should succeed (serialized via FOR UPDATE row lock) with version 3 and 4
      const statusCodes = [resA.statusCode, resB.statusCode];
      assert.ok(
        statusCodes.every((s) => s === 200),
        `Expected both concurrent rotations to succeed (200), got: ${statusCodes.join(", ")}`
      );

      const versions = [resA.json().data.credential.version, resB.json().data.credential.version].sort();
      assert.deepStrictEqual(versions, [3, 4], "Concurrent rotations must increment versions monotonically");

      // Verify database invariant: exactly ONE active credential exists
      const activeRes = await adminPool.query(
        `SELECT id, version, status FROM resource_credentials WHERE resource_id = $1 AND status = 'active';`,
        [createdResourceId]
      );
      assert.strictEqual(activeRes.rows.length, 1, "Exactly one active credential must exist after concurrent rotations");
      assert.strictEqual(activeRes.rows[0].version, 4);
    });
  });

  // =========================================================================
  // 7. RESOURCE DEPROVISIONING LIFECYCLE
  // =========================================================================
  describe("7. Resource Deprovisioning Lifecycle", () => {
    it("7.1 should deny organization member from deprovisioning resource (403 Forbidden)", async () => {
      const token = await createTestToken("sub-route-res-member");
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/projects/${projectAlphaId}/resources/${createdResourceId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      assert.strictEqual(res.statusCode, 403);
    });

    it("7.2 should allow organization owner to deprovision resource and revoke active credentials", async () => {
      const token = await createTestToken("sub-route-res-owner");
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/projects/${projectAlphaId}/resources/${createdResourceId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      assert.strictEqual(res.statusCode, 200);
      const body = res.json();
      assert.strictEqual(body.data.resource.status, "deprovisioned");

      // Verify active credentials are now revoked
      const credsRes = await adminPool.query(
        `SELECT status FROM resource_credentials WHERE resource_id = $1 AND status = 'active';`,
        [createdResourceId]
      );
      assert.strictEqual(credsRes.rows.length, 0, "No active credentials should exist after deprovisioning");

      // Subsequent credential reveal should 404
      const revealRes = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectAlphaId}/resources/${createdResourceId}/credentials`,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.strictEqual(revealRes.statusCode, 404);
    });
  });
});
