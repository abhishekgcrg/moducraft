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

describe("Project CRUD API Integration Tests", () => {
  const { runtimeDbUrl, superuserDbUrl } = getTestDatabaseUrls();

  const secretKey = "project-crud-test-secret-key-moducraft-3b!";
  const issuer = "https://auth.moducraft.test";
  const audience = "moducraft-api";

  // Test users
  const userOwnerId = "33333333-1111-4000-8000-000000000001";
  const userMemberId = "33333333-2222-4000-8000-000000000002";
  const userViewerId = "33333333-3333-4000-8000-000000000003";
  const userOtherOrgId = "33333333-4444-4000-8000-000000000004";

  // Test organizations
  const orgAlphaId = "44444444-aaaa-4000-8000-000000000001";
  const orgBetaId = "44444444-bbbb-4000-8000-000000000002";

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
        ($1, $5, 'sub-proj-owner', 'owner@projtest.test', 'Project Owner'),
        ($2, $5, 'sub-proj-member', 'member@projtest.test', 'Project Member'),
        ($3, $5, 'sub-proj-viewer', 'viewer@projtest.test', 'Project Viewer'),
        ($4, $5, 'sub-proj-other', 'other@projtest.test', 'Other Org User')
      ON CONFLICT (id) DO NOTHING;
      `,
      [userOwnerId, userMemberId, userViewerId, userOtherOrgId, issuer]
    );

    // Seed organizations (with created_by)
    await adminPool.query(
      `
      INSERT INTO organizations(id, name, slug, created_by)
      VALUES 
        ($1, 'Alpha Tech Inc', 'alpha-tech', $3),
        ($2, 'Beta Logistics', 'beta-logistics', $4)
      ON CONFLICT (id) DO NOTHING;
      `,
      [orgAlphaId, orgBetaId, userOwnerId, userOtherOrgId]
    );

    // Seed memberships:
    // Org Alpha: userOwner (owner), userMember (member), userViewer (viewer)
    // Org Beta: userOtherOrg (owner)
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

  // Tracking created project ID across sequential steps
  let createdProjectId: string;

  describe("POST /api/v1/projects (Create)", () => {
    it("rejects unauthenticated requests with 401", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        payload: {
          organizationId: orgAlphaId,
          name: "Sample Project",
          slug: "sample-project",
        },
      });

      assert.equal(res.statusCode, 401);
    });

    it("rejects invalid slug format with 400", async () => {
      const token = await createTestToken("sub-proj-owner");
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          organizationId: orgAlphaId,
          name: "Invalid Slug Project",
          slug: "Invalid_Slug!",
        },
      });

      assert.equal(res.statusCode, 400);
      const body = res.json();
      assert.equal(body.error.code, "VALIDATION_ERROR");
    });

    it("rejects request attempting to spoof createdBy or supply arbitrary extra fields with 400", async () => {
      const token = await createTestToken("sub-proj-owner");
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          organizationId: orgAlphaId,
          name: "Spoof Attempt",
          slug: "spoof-attempt",
          createdBy: "00000000-0000-0000-0000-000000000000",
        },
      });

      assert.equal(res.statusCode, 400);
      const body = res.json();
      assert.equal(body.error.code, "VALIDATION_ERROR");
    });

    it("rejects cross-tenant project creation with 404 (no leak of org existence)", async () => {
      const token = await createTestToken("sub-proj-other");
      // Other Org user attempts to create in Alpha Tech Inc
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          organizationId: orgAlphaId,
          name: "Cross Tenant Project",
          slug: "cross-tenant-project",
        },
      });

      assert.equal(res.statusCode, 404);
      const body = res.json();
      assert.equal(body.error.code, "NOT_FOUND");
    });

    it("denies project creation by organization viewer with 403", async () => {
      const token = await createTestToken("sub-proj-viewer");
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          organizationId: orgAlphaId,
          name: "Viewer Attempt",
          slug: "viewer-attempt",
        },
      });

      assert.equal(res.statusCode, 403);
      const body = res.json();
      assert.equal(body.error.code, "FORBIDDEN");
    });

    it("allows authorized member to create project, deriving createdBy and recording audit event", async () => {
      const token = await createTestToken("sub-proj-member");
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          organizationId: orgAlphaId,
          name: "Alpha Web Engine",
          slug: "alpha-web-engine",
          description: "Initial description for alpha web engine",
        },
      });

      assert.equal(res.statusCode, 201);
      const body = res.json();
      assert.ok(body.data.project.id);
      createdProjectId = body.data.project.id;
      assert.equal(body.data.project.organizationId, orgAlphaId);
      assert.equal(body.data.project.name, "Alpha Web Engine");
      assert.equal(body.data.project.slug, "alpha-web-engine");
      assert.equal(body.data.project.description, "Initial description for alpha web engine");
      // Verify created_by is derived exclusively from verified internal identity
      assert.equal(body.data.project.createdBy, userMemberId);

      // Verify audit event was written in the same transaction
      const auditResult = await adminPool.query(
        `SELECT id, organization_id, actor_user_id, action, resource_type, resource_id, metadata
         FROM audit_events
         WHERE resource_id = $1 AND action = 'project.created';`,
        [createdProjectId]
      );
      assert.equal(auditResult.rows.length, 1);
      const audit = auditResult.rows[0];
      assert.equal(audit.organization_id, orgAlphaId);
      assert.equal(audit.actor_user_id, userMemberId);
      assert.equal(audit.action, "project.created");
      assert.equal(audit.resource_type, "project");
      assert.equal(audit.metadata.name, "Alpha Web Engine");
    });

    it("rejects duplicate slug within same organization with 409 Conflict", async () => {
      const token = await createTestToken("sub-proj-owner");
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          organizationId: orgAlphaId,
          name: "Duplicate Slug Project",
          slug: "alpha-web-engine",
        },
      });

      assert.equal(res.statusCode, 409);
      const body = res.json();
      assert.equal(body.error.code, "CONFLICT");

      // Verify no orphan audit event was created on failed duplicate mutation
      const duplicateAudits = await adminPool.query(
        `SELECT count(*)::int AS count
         FROM audit_events
         WHERE organization_id = $1 AND metadata->>'name' = 'Duplicate Slug Project';`,
        [orgAlphaId]
      );
      assert.equal(duplicateAudits.rows[0].count, 0);
    });
  });

  describe("GET /api/v1/projects (List)", () => {
    it("lists only projects belonging to the caller's tenant", async () => {
      const token = await createTestToken("sub-proj-owner");
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/projects",
        headers: { authorization: `Bearer ${token}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.ok(Array.isArray(body.data.projects));
      assert.ok(body.data.projects.some((p: any) => p.id === createdProjectId));
      assert.ok(body.data.pagination.total >= 1);
    });

    it("isolates tenants: User from Org Beta sees none of Org Alpha's projects", async () => {
      const token = await createTestToken("sub-proj-other");
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/projects",
        headers: { authorization: `Bearer ${token}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.data.projects.length, 0);
      assert.equal(body.data.pagination.total, 0);
    });

    it("filters projects by organizationId and supports pagination", async () => {
      const token = await createTestToken("sub-proj-owner");
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/projects?organizationId=${orgAlphaId}&limit=10&offset=0`,
        headers: { authorization: `Bearer ${token}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.data.pagination.limit, 10);
      assert.equal(body.data.pagination.offset, 0);
      assert.ok(body.data.projects.length >= 1);
    });
  });

  describe("GET /api/v1/projects/:id (Retrieve)", () => {
    it("retrieves project for authorized member", async () => {
      const token = await createTestToken("sub-proj-viewer");
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${createdProjectId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.data.project.id, createdProjectId);
      assert.equal(body.data.project.slug, "alpha-web-engine");
    });

    it("returns 404 for cross-tenant retrieval (forced RLS tenant isolation)", async () => {
      const token = await createTestToken("sub-proj-other");
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${createdProjectId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      assert.equal(res.statusCode, 404);
      const body = res.json();
      assert.equal(body.error.code, "NOT_FOUND");
    });

    it("returns 400 for invalid UUID format", async () => {
      const token = await createTestToken("sub-proj-owner");
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/projects/invalid-id-format",
        headers: { authorization: `Bearer ${token}` },
      });

      assert.equal(res.statusCode, 400);
    });
  });

  describe("PATCH /api/v1/projects/:id (Update)", () => {
    it("denies project update by viewer with 403", async () => {
      const token = await createTestToken("sub-proj-viewer");
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/projects/${createdProjectId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: "Viewer Hacked Name",
        },
      });

      assert.equal(res.statusCode, 403);
      const body = res.json();
      assert.equal(body.error.code, "FORBIDDEN");
    });

    it("denies cross-tenant project update with 404", async () => {
      const token = await createTestToken("sub-proj-other");
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/projects/${createdProjectId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: "Other Org Attempt",
        },
      });

      assert.equal(res.statusCode, 404);
    });

    it("rejects attempt to alter immutable fields (id, organizationId, createdBy) with 400", async () => {
      const token = await createTestToken("sub-proj-owner");
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/projects/${createdProjectId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          organizationId: orgBetaId,
        },
      });

      assert.equal(res.statusCode, 400);
      const body = res.json();
      assert.equal(body.error.code, "VALIDATION_ERROR");
    });

    it("allows authorized member to update name and description and records audit event", async () => {
      const token = await createTestToken("sub-proj-member");
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/projects/${createdProjectId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: "Alpha Web Engine v2",
          description: "Updated description for v2",
        },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.data.project.name, "Alpha Web Engine v2");
      assert.equal(body.data.project.description, "Updated description for v2");

      // Verify audit event
      const auditResult = await adminPool.query(
        `SELECT id, organization_id, actor_user_id, action, resource_id, metadata
         FROM audit_events
         WHERE resource_id = $1 AND action = 'project.updated';`,
        [createdProjectId]
      );
      assert.ok(auditResult.rows.length >= 1);
      const audit = auditResult.rows[auditResult.rows.length - 1];
      assert.equal(audit.actor_user_id, userMemberId);
    });
  });

  describe("DELETE /api/v1/projects/:id (Delete)", () => {
    it("denies project deletion by viewer with 403", async () => {
      const token = await createTestToken("sub-proj-viewer");
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/projects/${createdProjectId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      assert.equal(res.statusCode, 403);
    });

    it("denies project deletion by regular member with 403 (owner/admin only)", async () => {
      const token = await createTestToken("sub-proj-member");
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/projects/${createdProjectId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      assert.equal(res.statusCode, 403);
      const body = res.json();
      assert.equal(body.error.message, "Only organization owners and admins can delete projects.");
    });

    it("denies cross-tenant project deletion with 404", async () => {
      const token = await createTestToken("sub-proj-other");
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/projects/${createdProjectId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      assert.equal(res.statusCode, 404);
    });

    it("allows organization owner to delete project and records audit event", async () => {
      const token = await createTestToken("sub-proj-owner");
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/projects/${createdProjectId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.data.success, true);

      // Verify project is removed from database
      const checkRes = await adminPool.query(`SELECT id FROM projects WHERE id = $1;`, [
        createdProjectId,
      ]);
      assert.equal(checkRes.rows.length, 0);

      // Verify deletion audit event was recorded
      const deleteAudit = await adminPool.query(
        `SELECT id, organization_id, actor_user_id, action, resource_id
         FROM audit_events
         WHERE resource_id = $1 AND action = 'project.deleted';`,
        [createdProjectId]
      );
      assert.equal(deleteAudit.rows.length, 1);
      assert.equal(deleteAudit.rows[0].actor_user_id, userOwnerId);
    });
  });

  describe("Connection Safety & Identity Isolation", () => {
    it("consecutive requests sharing a pooled connection do not leak identity", async () => {
      const tokenA = await createTestToken("sub-proj-owner");
      const tokenB = await createTestToken("sub-proj-other");

      // Request 1 as User A
      const res1 = await app.inject({
        method: "GET",
        url: "/api/v1/identity/me",
        headers: { authorization: `Bearer ${tokenA}` },
      });
      assert.equal(res1.statusCode, 200);
      assert.equal(res1.json().data.user.id, userOwnerId);

      // Request 2 as User B
      const res2 = await app.inject({
        method: "GET",
        url: "/api/v1/identity/me",
        headers: { authorization: `Bearer ${tokenB}` },
      });
      assert.equal(res2.statusCode, 200);
      assert.equal(res2.json().data.user.id, userOtherOrgId);

      // Request 3 as User A again
      const res3 = await app.inject({
        method: "GET",
        url: "/api/v1/identity/me",
        headers: { authorization: `Bearer ${tokenA}` },
      });
      assert.equal(res3.statusCode, 200);
      assert.equal(res3.json().data.user.id, userOwnerId);
    });
  });
});
