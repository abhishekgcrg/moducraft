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

describe("API Foundation & Protected Identity Integration Tests", () => {
  const { runtimeDbUrl, superuserDbUrl } = getTestDatabaseUrls();

  const secretKey = "test-secret-key-moducraft-phase3a-verified-safe!";
  const issuer = "https://auth.moducraft.test";
  const audience = "moducraft-api";

  const userAId = "aaaaaaaa-aaaa-4000-8000-000000000001";
  const userBId = "bbbbbbbb-bbbb-4000-8000-000000000002";

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
        ($1, $2, 'sub-user-a', 'user-a@moducraft.test', 'User Alpha'),
        ($3, $2, 'sub-user-b', 'user-b@moducraft.test', 'User Beta')
      ON CONFLICT (id) DO NOTHING;
    `,
      [userAId, issuer, userBId]
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

    // Clean up seeded users
    await adminPool.query(`DELETE FROM app_users WHERE id IN ($1, $2);`, [
      userAId,
      userBId,
    ]);

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

  it("GET /health should return 200 without sensitive information", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, "ok");
    assert.equal(body.service, "moducraft-api");
  });

  it("GET /ready should verify database readiness using restricted role", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/ready",
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, "ready");
    assert.equal(body.database, "connected");
  });

  it("GET /api/v1/identity/me should reject request without Authorization header", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/identity/me",
    });

    assert.equal(res.statusCode, 401);
    const body = res.json();
    assert.equal(body.error.code, "MISSING_TOKEN");
  });

  it("GET /api/v1/identity/me should reject invalid authorization header format", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/identity/me",
      headers: {
        authorization: "Basic dXNlcjpwYXNz",
      },
    });

    assert.equal(res.statusCode, 401);
    const body = res.json();
    assert.equal(body.error.code, "INVALID_HEADER");
  });

  it("GET /api/v1/identity/me should reject when auth provider is unconfigured", async () => {
    const unconfiguredApp = await buildApp({
      pool: runtimePool,
      authVerifier: new JoseJwtVerifier({}),
      enforceRestrictedRoleCheck: false,
    });

    try {
      const res = await unconfiguredApp.inject({
        method: "GET",
        url: "/api/v1/identity/me",
        headers: {
          authorization: "Bearer some-token",
        },
      });

      assert.equal(res.statusCode, 401);
      const body = res.json();
      assert.equal(body.error.code, "AUTH_NOT_CONFIGURED");
    } finally {
      await unconfiguredApp.close();
    }
  });

  it("GET /api/v1/identity/me should reject invalid token signature", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/identity/me",
      headers: {
        authorization: "Bearer invalid.signature.token",
      },
    });

    assert.equal(res.statusCode, 401);
    const body = res.json();
    assert.equal(body.error.code, "INVALID_TOKEN");
  });

  it("GET /api/v1/identity/me should reject verified token when user is not provisioned", async () => {
    const token = await createTestToken("unprovisioned-sub-999");

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/identity/me",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    assert.equal(res.statusCode, 401);
    const body = res.json();
    assert.equal(body.error.code, "USER_NOT_PROVISIONED");
  });

  it("GET /api/v1/identity/me should return internal identity for verified, provisioned user", async () => {
    const tokenA = await createTestToken("sub-user-a");

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/identity/me",
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.data?.user);
    assert.equal(body.data.user.id, userAId);
    assert.equal(body.data.user.identityIssuer, issuer);
    assert.equal(body.data.user.identitySubject, "sub-user-a");
    assert.equal(body.data.user.email, "user-a@moducraft.test");
    assert.equal(body.data.user.displayName, "User Alpha");
  });

  it("GET /api/v1/identity/me should isolate users across consecutive requests", async () => {
    const tokenA = await createTestToken("sub-user-a");
    const tokenB = await createTestToken("sub-user-b");

    // Request for User A
    const resA = await app.inject({
      method: "GET",
      url: "/api/v1/identity/me",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(resA.statusCode, 200);
    assert.equal(resA.json().data.user.id, userAId);

    // Request for User B
    const resB = await app.inject({
      method: "GET",
      url: "/api/v1/identity/me",
      headers: { authorization: `Bearer ${tokenB}` },
    });
    assert.equal(resB.statusCode, 200);
    assert.equal(resB.json().data.user.id, userBId);
  });
});
