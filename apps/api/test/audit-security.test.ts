import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createDatabasePool } from "../src/db/pool.js";
import { withAuthenticatedContext } from "../src/db/transaction.js";
import { getTestDatabaseUrls } from "./helpers/test-db-guard.js";

const { Pool } = pg;

describe("Audit Logging Security & Hardening Tests", () => {
  const { runtimeDbUrl, superuserDbUrl } = getTestDatabaseUrls();

  const userAId = "55555555-1111-4000-8000-000000000001";
  const userBId = "55555555-2222-4000-8000-000000000002";
  const org1Id = "66666666-aaaa-4000-8000-000000000001";
  const org2Id = "66666666-bbbb-4000-8000-000000000002";

  let runtimePool: pg.Pool;
  let adminPool: pg.Pool;

  before(async () => {
    runtimePool = createDatabasePool(runtimeDbUrl);
    adminPool = new Pool({ connectionString: superuserDbUrl, max: 2 });

    // Seed test users
    await adminPool.query(
      `
      INSERT INTO app_users(id, identity_issuer, identity_subject, email, display_name)
      VALUES 
        ($1, 'https://auth.moducraft.test', 'sub-audit-a', 'audit-a@test.test', 'Audit User A'),
        ($2, 'https://auth.moducraft.test', 'sub-audit-b', 'audit-b@test.test', 'Audit User B')
      ON CONFLICT (id) DO NOTHING;
      `,
      [userAId, userBId]
    );

    // Seed test organizations
    await adminPool.query(
      `
      INSERT INTO organizations(id, name, slug, created_by)
      VALUES 
        ($1, 'Audit Org 1', 'audit-org-1', $3),
        ($2, 'Audit Org 2', 'audit-org-2', $4)
      ON CONFLICT (id) DO NOTHING;
      `,
      [org1Id, org2Id, userAId, userBId]
    );

    // Seed memberships: User A -> Org 1, User B -> Org 2
    await adminPool.query(
      `
      INSERT INTO organization_memberships(organization_id, user_id, role, created_by)
      VALUES 
        ($1, $2, 'owner', $2),
        ($3, $4, 'owner', $4)
      ON CONFLICT (organization_id, user_id) DO NOTHING;
      `,
      [org1Id, userAId, org2Id, userBId]
    );
  });

  after(async () => {
    await adminPool.query(`DELETE FROM organizations WHERE id IN ($1, $2);`, [org1Id, org2Id]);
    await adminPool.query(`DELETE FROM app_users WHERE id IN ($1, $2);`, [userAId, userBId]);

    await runtimePool.end();
    await adminPool.end();
  });

  it("moducraft_runtime cannot directly INSERT into audit_events", async () => {
    await assert.rejects(
      async () => {
        await withAuthenticatedContext(runtimePool, userAId, async (tx) => {
          await tx.query(
            `INSERT INTO audit_events (actor_user_id, organization_id, action, resource_type, outcome)
             VALUES ($1, $2, 'test.action', 'test', 'success');`,
            [userAId, org1Id]
          );
        });
      },
      (err: any) => {
        assert.equal(err.code, "42501"); // insufficient_privilege
        return true;
      }
    );
  });

  it("moducraft_runtime cannot directly UPDATE audit_events", async () => {
    await assert.rejects(
      async () => {
        await withAuthenticatedContext(runtimePool, userAId, async (tx) => {
          await tx.query(`UPDATE audit_events SET action = 'tampered';`);
        });
      },
      (err: any) => {
        assert.equal(err.code, "42501");
        return true;
      }
    );
  });

  it("moducraft_runtime cannot directly DELETE audit_events", async () => {
    await assert.rejects(
      async () => {
        await withAuthenticatedContext(runtimePool, userAId, async (tx) => {
          await tx.query(`DELETE FROM audit_events;`);
        });
      },
      (err: any) => {
        assert.equal(err.code, "42501");
        return true;
      }
    );
  });

  it("rejects audit event recording when no authenticated user context exists", async () => {
    const client = await runtimePool.connect();
    try {
      await client.query("BEGIN;");
      await assert.rejects(
        async () => {
          await client.query(
            `SELECT public.moducraft_record_audit_event($1, 'test.action', 'project', '123', 'success');`,
            [org1Id]
          );
        },
        /no authenticated user context set/
      );
      await client.query("ROLLBACK;");
    } finally {
      client.release();
    }
  });

  it("rejects audit event recording with NULL organization_id", async () => {
    await assert.rejects(
      async () => {
        await withAuthenticatedContext(runtimePool, userAId, async (tx) => {
          await tx.query(
            `SELECT public.moducraft_record_audit_event(NULL, 'test.action', 'project', '123', 'success');`
          );
        });
      },
      /organization_id is required/
    );
  });

  it("rejects audit event recording for foreign tenant organization", async () => {
    // User A attempts to record an audit event for Org 2 (which User A is not a member of)
    await assert.rejects(
      async () => {
        await withAuthenticatedContext(runtimePool, userAId, async (tx) => {
          await tx.query(
            `SELECT public.moducraft_record_audit_event($1, 'test.action', 'project', '123', 'success');`,
            [org2Id]
          );
        });
      },
      /Cannot record audit event for organization actor is not a member of/
    );
  });

  it("rejects audit event with invalid outcome", async () => {
    await assert.rejects(
      async () => {
        await withAuthenticatedContext(runtimePool, userAId, async (tx) => {
          await tx.query(
            `SELECT public.moducraft_record_audit_event($1, 'test.action', 'project', '123', 'invalid_outcome');`,
            [org1Id]
          );
        });
      },
      /Invalid audit outcome/
    );
  });

  it("rejects audit metadata containing sensitive keys (passwords, tokens, secrets, jwt)", async () => {
    const sensitiveKeys = [
      { password: "super-secret-password" },
      { token: "bearer-token-12345" },
      { secret: "api-secret-key" },
      { apiKey: "secret-key-abc" },
      { authorization: "Bearer xyz" },
      { jwt: "ey..." },
    ];

    for (const payload of sensitiveKeys) {
      await assert.rejects(
        async () => {
          await withAuthenticatedContext(runtimePool, userAId, async (tx) => {
            await tx.query(
              `SELECT public.moducraft_record_audit_event($1, 'test.action', 'project', '123', 'success', $2::jsonb);`,
              [org1Id, JSON.stringify(payload)]
            );
          });
        },
        /Sensitive key detected in audit metadata/
      );
    }
  });

  it("rejects non-object metadata (e.g. array or primitive string)", async () => {
    await assert.rejects(
      async () => {
        await withAuthenticatedContext(runtimePool, userAId, async (tx) => {
          await tx.query(
            `SELECT public.moducraft_record_audit_event($1, 'test.action', 'project', '123', 'success', '[1, 2, 3]'::jsonb);`,
            [org1Id]
          );
        });
      },
      /must be a JSON object/
    );
  });

  it("successfully records safe audit event with actor derived strictly from context", async () => {
    let auditId: string;

    await withAuthenticatedContext(runtimePool, userAId, async (tx) => {
      const res = await tx.query<{ moducraft_record_audit_event: string }>(
        `SELECT public.moducraft_record_audit_event(
           $1,
           'project.created',
           'project',
           'test-proj-id-1',
           'success',
           $2::jsonb
         );`,
        [org1Id, JSON.stringify({ name: "Safe Project", slug: "safe-project" })]
      );
      auditId = res.rows[0].moducraft_record_audit_event;
      assert.ok(auditId);
    });

    // Inspect recorded row directly via superuser pool
    const checkRes = await adminPool.query(
      `SELECT id, actor_user_id, organization_id, action, resource_type, resource_id, outcome, metadata
       FROM audit_events
       WHERE id = $1;`,
      [auditId!]
    );
    assert.equal(checkRes.rows.length, 1);
    const row = checkRes.rows[0];
    // Actor must match User A, NOT spoofable
    assert.equal(row.actor_user_id, userAId);
    assert.equal(row.organization_id, org1Id);
    assert.equal(row.action, "project.created");
    assert.equal(row.resource_type, "project");
    assert.equal(row.resource_id, "test-proj-id-1");
    assert.equal(row.outcome, "success");
    assert.equal(row.metadata.name, "Safe Project");
  });
});
