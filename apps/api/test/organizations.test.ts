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

describe("Organization API Integration Tests", () => {
  const { runtimeDbUrl, superuserDbUrl } = getTestDatabaseUrls();

  const secretKey = "org-test-secret-key-moducraft-phase3b-safe!";
  const issuer = "https://auth.moducraft.test";
  const audience = "moducraft-api";

  const userAId = "11111111-1111-4000-8000-000000000001";
  const userBId = "22222222-2222-4000-8000-000000000002";
  const org1Id = "11111111-aaaa-4000-8000-000000000001";
  const org2Id = "22222222-bbbb-4000-8000-000000000002";

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
        ($1, $2, 'sub-org-user-a', 'user-a@orgtest.test', 'User A Org Test'),
        ($3, $2, 'sub-org-user-b', 'user-b@orgtest.test', 'User B Org Test')
      ON CONFLICT (id) DO NOTHING;
      `,
      [userAId, issuer, userBId]
    );

    // Seed test organizations (with valid created_by)
    await adminPool.query(
      `
      INSERT INTO organizations(id, name, slug, created_by)
      VALUES 
        ($1, 'Tenant One Org', 'tenant-one-org', $3),
        ($2, 'Tenant Two Org', 'tenant-two-org', $4)
      ON CONFLICT (id) DO NOTHING;
      `,
      [org1Id, org2Id, userAId, userBId]
    );

    // Seed memberships: User A is owner in Org 1; User B is member in Org 2
    await adminPool.query(
      `
      INSERT INTO organization_memberships(organization_id, user_id, role, created_by)
      VALUES 
        ($1, $2, 'owner', $2),
        ($3, $4, 'member', $4)
      ON CONFLICT (organization_id, user_id) DO NOTHING;
      `,
      [org1Id, userAId, org2Id, userBId]
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

    // Clean up seeded fixtures
    await adminPool.query(`DELETE FROM organizations WHERE id IN ($1, $2);`, [org1Id, org2Id]);
    await adminPool.query(`DELETE FROM app_users WHERE id IN ($1, $2);`, [userAId, userBId]);

    await adminPool.end();
    await runtimePool.end();
  });

  async function createTestToken(sub: string, iss: string = issuer, aud: string = audience) {
    const secretBytes = new TextEncoder().encode(secretKey);
    return new jose.SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setIssuer(iss)
      .setAudience(aud)
      .setSubject(sub)
      .setExpirationTime("1h")
      .sign(secretBytes);
  }

  it("GET /api/v1/organizations rejects requests with missing token (401)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/organizations",
    });

    assert.equal(res.statusCode, 401);
    const body = res.json();
    assert.equal(body.error.code, "MISSING_TOKEN");
  });

  it("GET /api/v1/organizations rejects requests with invalid signature (401)", async () => {
    const forgedToken = await new jose.SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("sub-org-user-a")
      .sign(new TextEncoder().encode("wrong-secret-key-padding-to-length!"));

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/organizations",
      headers: {
        authorization: `Bearer ${forgedToken}`,
      },
    });

    assert.equal(res.statusCode, 401);
  });

  it("GET /api/v1/organizations returns only tenant orgs user belongs to with role", async () => {
    const tokenA = await createTestToken("sub-org-user-a");

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/organizations",
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.data.organizations));
    assert.equal(body.data.organizations.length, 1);
    const org = body.data.organizations[0];
    assert.equal(org.id, org1Id);
    assert.equal(org.name, "Tenant One Org");
    assert.equal(org.slug, "tenant-one-org");
    assert.equal(org.role, "owner");
  });

  it("GET /api/v1/organizations for User B returns Tenant Two Org with member role", async () => {
    const tokenB = await createTestToken("sub-org-user-b");

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/organizations",
      headers: {
        authorization: `Bearer ${tokenB}`,
      },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.data.organizations.length, 1);
    const org = body.data.organizations[0];
    assert.equal(org.id, org2Id);
    assert.equal(org.role, "member");
  });

  it("GET /api/v1/organizations/:id returns organization details for member", async () => {
    const tokenA = await createTestToken("sub-org-user-a");

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${org1Id}`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.data.organization.id, org1Id);
    assert.equal(body.data.organization.name, "Tenant One Org");
    assert.equal(body.data.organization.role, "owner");
  });

  it("GET /api/v1/organizations/:id denies cross-tenant access with 404 (no enumeration)", async () => {
    const tokenA = await createTestToken("sub-org-user-a");

    // User A attempts to access Org 2 (belongs to Tenant Two)
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${org2Id}`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
    });

    assert.equal(res.statusCode, 404);
    const body = res.json();
    assert.equal(body.error.code, "NOT_FOUND");
    assert.equal(body.error.message, "Organization not found.");
  });

  it("GET /api/v1/organizations/:id rejects invalid UUID format (400)", async () => {
    const tokenA = await createTestToken("sub-org-user-a");

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/organizations/not-a-valid-uuid",
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
    });

    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(body.error.code, "VALIDATION_ERROR");
  });
});
