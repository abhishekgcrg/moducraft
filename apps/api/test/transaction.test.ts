import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createDatabasePool } from "../src/db/pool.js";
import { withAuthenticatedContext } from "../src/db/transaction.js";
import { getTestDatabaseUrls } from "./helpers/test-db-guard.js";

const { Pool } = pg;

describe("Transaction-Scoped Identity Context & Pooling Safety", () => {
  const { runtimeDbUrl, superuserDbUrl } = getTestDatabaseUrls();

  let runtimePool: pg.Pool;
  let adminPool: pg.Pool;

  const testUserA = "99991111-1111-4000-8000-000000000001";
  const testUserB = "99992222-2222-4000-8000-000000000002";
  const testOrgA = "99993333-3333-4000-8000-000000000001";
  const testOrgB = "99994444-4444-4000-8000-000000000002";

  before(async () => {
    runtimePool = createDatabasePool(runtimeDbUrl);
    adminPool = new Pool({ connectionString: superuserDbUrl, max: 2 });

    // Seed test fixtures using admin connection, then leave them clean
    await adminPool.query(
      `INSERT INTO app_users(id, identity_issuer, identity_subject, email, display_name)
       VALUES 
         ($1, 'https://test-issuer.org', 'sub-a-tx', 'a-tx@test.org', 'User A TX'),
         ($2, 'https://test-issuer.org', 'sub-b-tx', 'b-tx@test.org', 'User B TX')
       ON CONFLICT (id) DO NOTHING;`,
      [testUserA, testUserB]
    );

    await adminPool.query(
      `INSERT INTO organizations(id, name, slug, created_by)
       VALUES 
         ($1, 'Org A TX', 'test-org-a-tx', $2),
         ($3, 'Org B TX', 'test-org-b-tx', $4)
       ON CONFLICT (id) DO NOTHING;`,
      [testOrgA, testUserA, testOrgB, testUserB]
    );

    await adminPool.query(
      `INSERT INTO organization_memberships(organization_id, user_id, role)
       VALUES 
         ($1, $2, 'owner'),
         ($3, $4, 'owner')
       ON CONFLICT (organization_id, user_id) DO NOTHING;`,
      [testOrgA, testUserA, testOrgB, testUserB]
    );
  });

  after(async () => {
    // Clean up seeded fixtures
    await adminPool.query(`DELETE FROM organizations WHERE id IN ($1, $2);`, [
      testOrgA,
      testOrgB,
    ]);
    await adminPool.query(`DELETE FROM app_users WHERE id IN ($1, $2);`, [
      testUserA,
      testUserB,
    ]);

    await runtimePool.end();
    await adminPool.end();
  });

  it("should set transaction-local identity context during transaction execution", async () => {
    await withAuthenticatedContext(runtimePool, testUserA, async (tx) => {
      const res = await tx.query<{ app_user_id: string }>(
        "SELECT current_setting('app.user_id', true) AS app_user_id;"
      );
      assert.equal(res.rows[0].app_user_id, testUserA);
    });
  });

  it("should enforce tenant isolation under the restricted role", async () => {
    // As User A in Org A
    await withAuthenticatedContext(runtimePool, testUserA, async (tx) => {
      // Should see own org
      const ownOrg = await tx.query(
        "SELECT id, name FROM organizations WHERE id = $1;",
        [testOrgA]
      );
      assert.equal(ownOrg.rows.length, 1);

      // Must NOT see Tenant B org
      const otherOrg = await tx.query(
        "SELECT id, name FROM organizations WHERE id = $1;",
        [testOrgB]
      );
      assert.equal(otherOrg.rows.length, 0, "Tenant A must not see Tenant B organization");
    });

    // As User B in Org B
    await withAuthenticatedContext(runtimePool, testUserB, async (tx) => {
      const otherOrg = await tx.query(
        "SELECT id, name FROM organizations WHERE id = $1;",
        [testOrgA]
      );
      assert.equal(otherOrg.rows.length, 0, "Tenant B must not see Tenant A organization");

      const ownOrg = await tx.query(
        "SELECT id, name FROM organizations WHERE id = $1;",
        [testOrgB]
      );
      assert.equal(ownOrg.rows.length, 1);
    });
  });

  it("should roll back mutations and release client when callback throws", async () => {
    const projectSlug = "rollback-test-proj";

    await assert.rejects(
      async () => {
        await withAuthenticatedContext(runtimePool, testUserA, async (tx) => {
          await tx.query(
            `INSERT INTO projects(organization_id, name, slug, created_by)
             VALUES ($1, 'Rollback Project', $2, $3);`,
            [testOrgA, projectSlug, testUserA]
          );

          throw new Error("Simulated mutation failure inside transaction");
        });
      },
      /Simulated mutation failure/
    );

    // Verify row was rolled back and does not persist
    await withAuthenticatedContext(runtimePool, testUserA, async (tx) => {
      const check = await tx.query(
        "SELECT id FROM projects WHERE slug = $1;",
        [projectSlug]
      );
      assert.equal(check.rows.length, 0, "Project row must have been rolled back");
    });
  });

  it("should guarantee zero identity leakage between consecutive requests sharing a pooled connection", async () => {
    // Create a pool strictly constrained to 1 connection to force connection reuse
    const singleConnPool = new Pool({
      connectionString: runtimeDbUrl,
      max: 1,
    });

    try {
      // Request 1: Context for User A
      await withAuthenticatedContext(singleConnPool, testUserA, async (tx) => {
        const res = await tx.query<{ val: string }>(
          "SELECT current_setting('app.user_id', true) AS val;"
        );
        assert.equal(res.rows[0].val, testUserA);
      });

      // Verification: Direct inspection of that same pooled connection outside transaction
      const rawClient1 = await singleConnPool.connect();
      try {
        const rawRes = await rawClient1.query<{ val: string | null }>(
          "SELECT NULLIF(current_setting('app.user_id', true), '') AS val;"
        );
        assert.equal(
          rawRes.rows[0].val,
          null,
          "Pooled connection MUST NOT retain app.user_id after transaction completion"
        );
      } finally {
        rawClient1.release();
      }

      // Request 2: Context for User B on same single-connection pool
      await withAuthenticatedContext(singleConnPool, testUserB, async (tx) => {
        const res = await tx.query<{ val: string }>(
          "SELECT current_setting('app.user_id', true) AS val;"
        );
        assert.equal(res.rows[0].val, testUserB);
      });

      // Verification: Post User B inspection
      const rawClient2 = await singleConnPool.connect();
      try {
        const rawRes = await rawClient2.query<{ val: string | null }>(
          "SELECT NULLIF(current_setting('app.user_id', true), '') AS val;"
        );
        assert.equal(
          rawRes.rows[0].val,
          null,
          "Pooled connection MUST NOT retain User B identity context"
        );
      } finally {
        rawClient2.release();
      }
    } finally {
      await singleConnPool.end();
    }
  });
});
