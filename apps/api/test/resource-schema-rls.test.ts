import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createDatabasePool } from "../src/db/pool.js";
import { withAuthenticatedContext } from "../src/db/transaction.js";
import { getTestDatabaseUrls } from "./helpers/test-db-guard.js";
import {
  ResourceService,
  CreateResourceInput,
  CreateResourceCredentialInput,
} from "../src/modules/resources/resource.service.js";
import { encryptSecret, decryptSecret } from "../src/modules/providers/crypto.js";
import { ForbiddenError, ValidationError } from "../src/errors/app-errors.js";

const { Pool } = pg;

describe("Cloud Resources & Secrets Foundation Integration Tests (Phase 5 Task 5.2)", () => {
  // Test encryption key: 32 bytes (64 hex characters)
  const testEncryptionKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.PROVIDER_ENCRYPTION_KEY = testEncryptionKey;
  process.env.NODE_ENV = "test";

  const { runtimeDbUrl, superuserDbUrl } = getTestDatabaseUrls();

  const issuer = "https://auth.moducraft.test";

  // Test users (isolated dddddddd prefix)
  const userOwnerId = "dddddddd-1111-4000-8000-000000000001";
  const userMemberId = "dddddddd-2222-4000-8000-000000000002";
  const userViewerId = "dddddddd-3333-4000-8000-000000000003";
  const userBetaOwnerId = "dddddddd-4444-4000-8000-000000000004";

  // Test organizations (isolated eeeeeeee prefix)
  const orgAlphaId = "eeeeeeee-aaaa-4000-8000-000000000001";
  const orgBetaId = "eeeeeeee-bbbb-4000-8000-000000000002";

  // Test projects
  const projectAlphaId = "ffffffff-aaaa-4000-8000-000000000001";
  const projectAlpha2Id = "ffffffff-aaaa-4000-8000-000000000002";
  const projectBetaId = "ffffffff-bbbb-4000-8000-000000000001";

  let runtimePool: pg.Pool;
  let adminPool: pg.Pool;
  let resourceService: ResourceService;

  before(async () => {
    runtimePool = createDatabasePool(runtimeDbUrl);
    adminPool = new Pool({ connectionString: superuserDbUrl, max: 2 });
    resourceService = new ResourceService();

    // 1. Seed test users
    await adminPool.query(
      `INSERT INTO app_users (id, identity_issuer, identity_subject, email, display_name)
       VALUES 
         ($1, $5, 'sub-res-owner', 'res-owner@moducraft.test', 'Resource Owner'),
         ($2, $5, 'sub-res-member', 'res-member@moducraft.test', 'Resource Member'),
         ($3, $5, 'sub-res-viewer', 'res-viewer@moducraft.test', 'Resource Viewer'),
         ($4, $5, 'sub-res-beta-owner', 'res-beta-owner@moducraft.test', 'Beta Owner')
       ON CONFLICT (id) DO NOTHING;`,
      [userOwnerId, userMemberId, userViewerId, userBetaOwnerId, issuer]
    );

    // 2. Seed test organizations
    await adminPool.query(
      `INSERT INTO organizations (id, name, slug, created_by)
       VALUES 
         ($1, 'Resource Test Org Alpha', 'res-org-alpha', $3),
         ($2, 'Resource Test Org Beta', 'res-org-beta', $4)
       ON CONFLICT (id) DO NOTHING;`,
      [orgAlphaId, orgBetaId, userOwnerId, userBetaOwnerId]
    );

    // 3. Seed memberships
    await adminPool.query(
      `INSERT INTO organization_memberships (organization_id, user_id, role)
       VALUES 
         ($1, $2, 'owner'),
         ($1, $3, 'member'),
         ($1, $4, 'viewer'),
         ($5, $6, 'owner')
       ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role;`,
      [orgAlphaId, userOwnerId, userMemberId, userViewerId, orgBetaId, userBetaOwnerId]
    );

    // 4. Seed test projects
    await adminPool.query(
      `INSERT INTO projects (id, organization_id, name, slug, created_by)
       VALUES 
         ($1, $2, 'Alpha Project 1', 'alpha-proj-1', $4),
         ($5, $2, 'Alpha Project 2', 'alpha-proj-2', $4),
         ($3, $6, 'Beta Project 1', 'beta-proj-1', $7)
       ON CONFLICT (id) DO NOTHING;`,
      [projectAlphaId, orgAlphaId, projectBetaId, userOwnerId, projectAlpha2Id, orgBetaId, userBetaOwnerId]
    );
  });

  after(async () => {
    // Cleanup test data created during runs
    await adminPool.query(`DELETE FROM project_resources WHERE organization_id IN ($1, $2);`, [
      orgAlphaId,
      orgBetaId,
    ]);
    await runtimePool.end();
    await adminPool.end();
  });

  describe("1. Catalog Parity & RLS Enforcement Verification", () => {
    it("1.1 should verify total table count in moducraft_test is exactly 19", async () => {
      const res = await adminPool.query<{ count: string }>(
        `SELECT count(*)::text as count FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';`
      );
      assert.equal(res.rows[0].count, "19", "moducraft_test must contain exactly 19 base tables");
    });

    it("1.2 should verify RLS and FORCE RLS are active on project_resources and resource_credentials", async () => {
      const res = await adminPool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relname, relrowsecurity, relforcerowsecurity 
         FROM pg_class 
         WHERE relname IN ('project_resources', 'resource_credentials')
         ORDER BY relname;`
      );
      assert.equal(res.rows.length, 2);
      for (const row of res.rows) {
        assert.equal(row.relrowsecurity, true, `${row.relname} must have relrowsecurity = true`);
        assert.equal(row.relforcerowsecurity, true, `${row.relname} must have relforcerowsecurity = true`);
      }
    });
  });

  describe("2. Database Constraints & Secret Leak Prevention", () => {
    it("2.1 should reject plain-text secrets in configuration via check constraint", async () => {
      await assert.rejects(
        async () => {
          await adminPool.query(
            `INSERT INTO project_resources (
              organization_id, project_id, provider_id, resource_type,
              name, status, configuration, created_by
            ) VALUES ($1, $2, 'docker-postgres', 'database', 'leak-test-1', 'active', '{"password": "secret"}'::jsonb, $3);`,
            [orgAlphaId, projectAlphaId, userOwnerId]
          );
        },
        /chk_project_resources_config_no_secrets/,
        "Must reject plaintext password in configuration"
      );
    });

    it("2.2 should reject plain-text secrets in endpoint via check constraint", async () => {
      await assert.rejects(
        async () => {
          await adminPool.query(
            `INSERT INTO project_resources (
              organization_id, project_id, provider_id, resource_type,
              name, status, endpoint, created_by
            ) VALUES ($1, $2, 'docker-postgres', 'database', 'leak-test-2', 'active', '{"token": "xyz"}'::jsonb, $3);`,
            [orgAlphaId, projectAlphaId, userOwnerId]
          );
        },
        /chk_project_resources_endpoint_no_secrets/,
        "Must reject plaintext token in endpoint"
      );
    });

    it("2.3 should reject sensitive keys in ResourceService.createResource", async () => {
      await withAuthenticatedContext(runtimePool, userOwnerId, async (tx) => {
        await assert.rejects(
          async () => {
            await resourceService.createResource(
              tx,
              {
                organizationId: orgAlphaId,
                projectId: projectAlphaId,
                providerId: "docker-postgres",
                resourceType: "database",
                name: "app-leak-test",
                configuration: { apiKey: "sk-1234567890123456" },
              },
              userOwnerId
            );
          },
          (err: any) => err instanceof ValidationError && err.message.includes("apiKey")
        );
      });
    });

    it("2.4 should ensure mapResourceDto explicitly omits secret fields", async () => {
      const mockRow: any = {
        id: "11111111-1111-1111-1111-111111111111",
        organization_id: orgAlphaId,
        project_id: projectAlphaId,
        provider_id: "docker-postgres",
        resource_type: "database",
        name: "dto-test",
        status: "active",
        endpoint: { host: "127.0.0.1", port: 5432 },
        configuration: { engine: "postgres" },
        error_details: null,
        created_by: userOwnerId,
        created_at: new Date(),
        updated_at: new Date(),
        deleted_at: null,
        // Attacker injected / extra fields
        encrypted_password: "v1:secret",
        password: "raw-password",
      };

      const dto = resourceService.mapResourceDto(mockRow);
      assert.equal((dto as any).encrypted_password, undefined);
      assert.equal((dto as any).password, undefined);
      assert.equal(dto.name, "dto-test");
    });

    it("2.5 (SEC-5.2-01) should reject sensitive key nested inside an array of objects", () => {
      assert.throws(
        () => {
          resourceService.validateNoSecretKeys(
            { connectors: [{ host: "127.0.0.1", password: "secret" }] },
            "configuration"
          );
        },
        (err: any) =>
          err instanceof ValidationError &&
          err.message.includes("password") &&
          err.message.includes("configuration.connectors[0]")
      );
    });

    it("2.6 (SEC-5.2-01) should reject sensitive key in deeply nested mixed arrays and objects", () => {
      assert.throws(
        () => {
          resourceService.validateNoSecretKeys(
            {
              pipeline: {
                stages: [
                  [
                    {
                      options: {
                        credentials: { key: "val" },
                      },
                    },
                  ],
                ],
              },
            },
            "configuration"
          );
        },
        (err: any) =>
          err instanceof ValidationError &&
          err.message.includes("credentials") &&
          err.message.includes("configuration.pipeline.stages[0][0].options")
      );
    });

    it("2.7 (SEC-5.2-01) should safely allow arrays of primitives (strings, numbers, booleans, null)", () => {
      // Must not throw for primitive arrays or null elements
      resourceService.validateNoSecretKeys(
        {
          allowedIps: ["10.0.0.1", "10.0.0.2"],
          ports: [5432, 5433, 8080],
          flags: [true, false, null],
          emptyArray: [],
          nestedPrimitives: [[1, 2], ["a", "b", null]],
        },
        "configuration"
      );
    });

    it("2.8 (SEC-5.2-01) should safely allow arrays of non-sensitive objects and safe keys (public_key, routing_key) without mutating input", () => {
      const input = {
        connectors: [
          { name: "pg-primary", host: "10.0.0.1", port: 5432, public_key: "ssh-ed25519 AAAAC3", publicKey: "key-val" },
          { name: "pg-replica", host: "10.0.0.2", port: 5433, routing_key: "eu-west", partition_key: "shard-1", cache_key: "c1" },
        ],
      };
      const snapshot = JSON.stringify(input);
      Object.freeze(input.connectors[0]);
      Object.freeze(input.connectors[1]);
      Object.freeze(input.connectors);
      Object.freeze(input);

      resourceService.validateNoSecretKeys(input, "configuration");
      assert.equal(JSON.stringify(input), snapshot, "Input object must remain unmutated");
    });

    it("2.9 (SEC-5.2-01) should detect case variants, delimiter variants (api-key, api.key, private-key), and all blacklisted key types inside nested arrays", () => {
      const sensitiveKeys = [
        "Password",
        "API_KEY",
        "api-key",
        "api.key",
        "apiKey",
        "private_key",
        "private-key",
        "private.key",
        "privateKey",
        "TOKEN",
        "authorization",
        "Cookie",
        "JWT",
        "SECRET",
      ];
      for (const k of sensitiveKeys) {
        assert.throws(
          () => {
            resourceService.validateNoSecretKeys(
              { items: [{ nested: [{ [k]: "sensitive_val" }] }] },
              "endpoint"
            );
          },
          (err: any) => err instanceof ValidationError && err.message.includes(k),
          `Failed to reject sensitive key '${k}' inside array`
        );
      }
    });

    it("2.10 (SEC-5.2-01) should reject array-nested sensitive keys in ResourceService.createResource end-to-end without leaking secret value", async () => {
      await withAuthenticatedContext(runtimePool, userOwnerId, async (tx) => {
        await assert.rejects(
          async () => {
            await resourceService.createResource(
              tx,
              {
                organizationId: orgAlphaId,
                projectId: projectAlphaId,
                providerId: "docker-postgres",
                resourceType: "database",
                name: "array-leak-test",
                configuration: {
                  connectors: [{ host: "10.0.0.1", password: "raw-password-12345" }],
                },
              },
              userOwnerId
            );
          },
          (err: any) => {
            assert.ok(err instanceof ValidationError);
            assert.ok(err.message.includes("password"));
            assert.ok(err.message.includes("configuration.connectors[0]"));
            // Security invariant: secret value MUST NOT be exposed in the error message
            assert.ok(!err.message.includes("raw-password-12345"));
            return true;
          }
        );
      });
    });

    it("2.11 (SEC-5.2-01) should reject delimiter variant (api-key) in ResourceService.createResource end-to-end without leaking secret value", async () => {
      await withAuthenticatedContext(runtimePool, userOwnerId, async (tx) => {
        await assert.rejects(
          async () => {
            await resourceService.createResource(
              tx,
              {
                organizationId: orgAlphaId,
                projectId: projectAlphaId,
                providerId: "docker-postgres",
                resourceType: "database",
                name: "delimiter-leak-test",
                configuration: {
                  "api-key": "super-secret-token-val",
                },
              },
              userOwnerId
            );
          },
          (err: any) => {
            assert.ok(err instanceof ValidationError);
            assert.ok(err.message.includes("api-key"));
            assert.ok(!err.message.includes("super-secret-token-val"));
            return true;
          }
        );
      });
    });
  });

  describe("3. Composite Foreign Keys & Tenant Referential Integrity", () => {
    it("3.1 should reject credential creation when project_id does not match resource's project_id", async () => {
      // 1. Create valid resource in Project Alpha 1
      let resourceId: string;
      await withAuthenticatedContext(runtimePool, userOwnerId, async (tx) => {
        const res = await resourceService.createResource(
          tx,
          {
            organizationId: orgAlphaId,
            projectId: projectAlphaId,
            providerId: "docker-postgres",
            resourceType: "database",
            name: "mismatch-test-res",
          },
          userOwnerId
        );
        resourceId = res.id;
      });

      // 2. Attempt to create credential pointing to resourceId but specifying projectAlpha2Id
      await assert.rejects(
        async () => {
          await adminPool.query(
            `INSERT INTO resource_credentials (
              organization_id, project_id, resource_id, status, version,
              username, encrypted_password, key_prefix, key_suffix,
              connection_string_template, created_by
            ) VALUES ($1, $2, $3, 'active', 1, 'user', 'v1:dummy', 'pref', 'suff', 'template', $4);`,
            [orgAlphaId, projectAlpha2Id, resourceId!, userOwnerId]
          );
        },
        /fk_resource_credentials_resource_project/,
        "Must reject credential where project_id does not match resource parent project"
      );
    });

    it("3.2 should reject credential creation pointing to foreign organization_id", async () => {
      let resourceId: string;
      await withAuthenticatedContext(runtimePool, userOwnerId, async (tx) => {
        const res = await resourceService.createResource(
          tx,
          {
            organizationId: orgAlphaId,
            projectId: projectAlphaId,
            providerId: "docker-postgres",
            resourceType: "database",
            name: "cross-org-test-res",
          },
          userOwnerId
        );
        resourceId = res.id;
      });

      await assert.rejects(
        async () => {
          await adminPool.query(
            `INSERT INTO resource_credentials (
              organization_id, project_id, resource_id, status, version,
              username, encrypted_password, key_prefix, key_suffix,
              connection_string_template, created_by
            ) VALUES ($1, $2, $3, 'active', 1, 'user', 'v1:dummy', 'pref', 'suff', 'template', $4);`,
            [orgBetaId, projectAlphaId, resourceId!, userOwnerId]
          );
        },
        /fk_resource_credentials_resource_project/,
        "Must reject cross-tenant composite FK mismatch"
      );
    });
  });

  describe("4. Invariant: At Most One Active Credential per Resource", () => {
    it("4.1 should enforce single active credential invariant via partial unique index", async () => {
      let resourceId: string;
      await withAuthenticatedContext(runtimePool, userOwnerId, async (tx) => {
        const res = await resourceService.createResource(
          tx,
          {
            organizationId: orgAlphaId,
            projectId: projectAlphaId,
            providerId: "docker-postgres",
            resourceType: "database",
            name: "single-active-test-res",
          },
          userOwnerId
        );
        resourceId = res.id;

        await resourceService.createResourceCredential(
          tx,
          {
            organizationId: orgAlphaId,
            projectId: projectAlphaId,
            resourceId: res.id,
            username: "db_user",
            password: "super-secret-password-1",
            connectionStringTemplate: "postgresql://{username}:{password}@127.0.0.1:5432/db",
          },
          userOwnerId
        );
      });

      // Attempt to insert a second active credential for the same resource
      await assert.rejects(
        async () => {
          await adminPool.query(
            `INSERT INTO resource_credentials (
              organization_id, project_id, resource_id, status, version,
              username, encrypted_password, key_prefix, key_suffix,
              connection_string_template, created_by
            ) VALUES ($1, $2, $3, 'active', 2, 'db_user2', 'v1:dummy', 'pref', 'suff', 'template', $4);`,
            [orgAlphaId, projectAlphaId, resourceId!, userOwnerId]
          );
        },
        /uq_resource_credentials_one_active/,
        "Must reject second active credential on same resource"
      );
    });
  });

  describe("5. Resource Name Soft-Deletion Lifecycle & Name Reuse", () => {
    it("5.1 should reject duplicate name while resource is active", async () => {
      await withAuthenticatedContext(runtimePool, userOwnerId, async (tx) => {
        await resourceService.createResource(
          tx,
          {
            organizationId: orgAlphaId,
            projectId: projectAlphaId,
            providerId: "docker-postgres",
            resourceType: "database",
            name: "reusable-db",
          },
          userOwnerId
        );

        await assert.rejects(
          async () => {
            await resourceService.createResource(
              tx,
              {
                organizationId: orgAlphaId,
                projectId: projectAlphaId,
                providerId: "docker-postgres",
                resourceType: "database",
                name: "reusable-db",
              },
              userOwnerId
            );
          },
          /uq_project_resources_active_name/,
          "Must reject duplicate active resource name"
        );
      });
    });

    it("5.2 should allow name reuse after resource is deprovisioned (soft-deleted)", async () => {
      let initialResourceId: string;
      await withAuthenticatedContext(runtimePool, userOwnerId, async (tx) => {
        const res = await resourceService.createResource(
          tx,
          {
            organizationId: orgAlphaId,
            projectId: projectAlphaId,
            providerId: "docker-postgres",
            resourceType: "database",
            name: "soft-delete-db",
          },
          userOwnerId
        );
        initialResourceId = res.id;

        // Deprovision the resource (status = 'deprovisioned', deleted_at = now())
        await resourceService.deprovisionResource(
          tx,
          {
            organizationId: orgAlphaId,
            projectId: projectAlphaId,
            resourceId: initialResourceId,
          },
          userOwnerId
        );

        // Recreate a new resource with the EXACT same name in the same project
        const recreated = await resourceService.createResource(
          tx,
          {
            organizationId: orgAlphaId,
            projectId: projectAlphaId,
            providerId: "docker-postgres",
            resourceType: "database",
            name: "soft-delete-db",
          },
          userOwnerId
        );

        assert.notEqual(recreated.id, initialResourceId);
        assert.equal(recreated.name, "soft-delete-db");
        assert.equal(recreated.status, "active");
      });
    });
  });

  describe("6. Row-Level Security & Role-Based Access Control", () => {
    let targetResourceId: string;
    let targetCredId: string;

    before(async () => {
      await withAuthenticatedContext(runtimePool, userOwnerId, async (tx) => {
        const res = await resourceService.createResource(
          tx,
          {
            organizationId: orgAlphaId,
            projectId: projectAlphaId,
            providerId: "docker-postgres",
            resourceType: "database",
            name: "rbac-test-db",
          },
          userOwnerId
        );
        targetResourceId = res.id;

        const cred = await resourceService.createResourceCredential(
          tx,
          {
            organizationId: orgAlphaId,
            projectId: projectAlphaId,
            resourceId: res.id,
            username: "rbac_user",
            password: "super-secret-rbac-pass",
            connectionStringTemplate: "postgresql://{username}:{password}@127.0.0.1:5432/rbacdb",
          },
          userOwnerId
        );
        targetCredId = cred.id;
      });
    });

    it("6.1 should allow ordinary members to view resource metadata but NOT credentials", async () => {
      await withAuthenticatedContext(runtimePool, userMemberId, async (tx) => {
        // 1. Can view resource
        const resResult = await tx.query(
          `SELECT * FROM project_resources WHERE id = $1;`,
          [targetResourceId]
        );
        assert.equal(resResult.rows.length, 1, "Member must see project_resources row");

        // 2. Cannot see credentials via RLS (receives 0 rows)
        const credResult = await tx.query(
          `SELECT * FROM resource_credentials WHERE resource_id = $1;`,
          [targetResourceId]
        );
        assert.equal(credResult.rows.length, 0, "Member must receive 0 rows from resource_credentials");
      });
    });

    it("6.2 should prevent viewers from seeing credentials via RLS", async () => {
      await withAuthenticatedContext(runtimePool, userViewerId, async (tx) => {
        const credResult = await tx.query(
          `SELECT * FROM resource_credentials WHERE resource_id = $1;`,
          [targetResourceId]
        );
        assert.equal(credResult.rows.length, 0, "Viewer must receive 0 rows from resource_credentials");
      });
    });

    it("6.3 should prevent users from other organizations from seeing resources or credentials", async () => {
      await withAuthenticatedContext(runtimePool, userBetaOwnerId, async (tx) => {
        const resResult = await tx.query(
          `SELECT * FROM project_resources WHERE id = $1;`,
          [targetResourceId]
        );
        assert.equal(resResult.rows.length, 0, "Cross-org user must receive 0 rows from project_resources");

        const credResult = await tx.query(
          `SELECT * FROM resource_credentials WHERE resource_id = $1;`,
          [targetResourceId]
        );
        assert.equal(credResult.rows.length, 0, "Cross-org user must receive 0 rows from resource_credentials");
      });
    });

    it("6.4 should allow owners and admins to select and view credentials", async () => {
      await withAuthenticatedContext(runtimePool, userOwnerId, async (tx) => {
        const credResult = await tx.query(
          `SELECT * FROM resource_credentials WHERE resource_id = $1;`,
          [targetResourceId]
        );
        assert.equal(credResult.rows.length, 1, "Owner must be able to select resource_credentials");
      });
    });
  });

  describe("7. Atomic Rotation, Locking, and State Reconciliation", () => {
    it("7.1 should rotate credentials atomically and increment version", async () => {
      let resourceId: string;
      await withAuthenticatedContext(runtimePool, userOwnerId, async (tx) => {
        const res = await resourceService.createResource(
          tx,
          {
            organizationId: orgAlphaId,
            projectId: projectAlphaId,
            providerId: "docker-postgres",
            resourceType: "database",
            name: "rotation-test-db",
          },
          userOwnerId
        );
        resourceId = res.id;

        const cred1 = await resourceService.createResourceCredential(
          tx,
          {
            organizationId: orgAlphaId,
            projectId: projectAlphaId,
            resourceId: res.id,
            username: "rot_user",
            password: "password-v1",
            connectionStringTemplate: "postgresql://{username}:{password}@127.0.0.1:5432/rotdb",
          },
          userOwnerId
        );
        assert.equal(cred1.version, 1);
        assert.equal(cred1.status, "active");

        const cred2 = await resourceService.rotateResourceCredential(
          tx,
          {
            organizationId: orgAlphaId,
            projectId: projectAlphaId,
            resourceId: res.id,
            newPassword: "password-v2",
          },
          userOwnerId
        );
        assert.equal(cred2.version, 2);
        assert.equal(cred2.status, "active");

        // Verify previous credential is now 'rotated'
        const checkOld = await tx.query(
          `SELECT status, rotated_at FROM resource_credentials WHERE id = $1;`,
          [cred1.id]
        );
        assert.equal(checkOld.rows[0].status, "rotated");
        assert.ok(checkOld.rows[0].rotated_at !== null);
      });
    });

    it("7.2 should reconcile provider failures with sanitized error details", async () => {
      await withAuthenticatedContext(runtimePool, userOwnerId, async (tx) => {
        const res = await resourceService.createResource(
          tx,
          {
            organizationId: orgAlphaId,
            projectId: projectAlphaId,
            providerId: "docker-postgres",
            resourceType: "database",
            name: "reconcile-test-db",
          },
          userOwnerId
        );

        // Raw error message containing a connection string and password
        const rawErr = "Failed to connect: postgres://admin:super_secret_pw@127.0.0.1:5432/db connection refused";
        const reconciled = await resourceService.reconcileResourceState(
          tx,
          {
            organizationId: orgAlphaId,
            projectId: projectAlphaId,
            resourceId: res.id,
            status: "failed",
            errorDetails: rawErr,
          },
          userOwnerId
        );

        assert.equal(reconciled.status, "failed");
        assert.ok(reconciled.errorDetails?.includes("[REDACTED_CONNECTION_STRING]"));
        assert.ok(!reconciled.errorDetails?.includes("super_secret_pw"));
      });
    });
  });

  describe("8. Autonomous Audit Pattern on Credential Reveal", () => {
    let testResourceId: string;

    before(async () => {
      await withAuthenticatedContext(runtimePool, userOwnerId, async (tx) => {
        const res = await resourceService.createResource(
          tx,
          {
            organizationId: orgAlphaId,
            projectId: projectAlphaId,
            providerId: "docker-postgres",
            resourceType: "database",
            name: "reveal-audit-test-db",
          },
          userOwnerId
        );
        testResourceId = res.id;

        await resourceService.createResourceCredential(
          tx,
          {
            organizationId: orgAlphaId,
            projectId: projectAlphaId,
            resourceId: res.id,
            username: "reveal_user",
            password: "super-secure-reveal-password",
            connectionStringTemplate: "postgresql://{username}:{password}@127.0.0.1:5432/revealdb",
          },
          userOwnerId
        );
      });
    });

    it("8.1 should reveal password to owner and log success audit event without secret leaks", async () => {
      const revealed = await resourceService.revealResourceCredential(
        runtimePool,
        {
          organizationId: orgAlphaId,
          projectId: projectAlphaId,
          resourceId: testResourceId,
        },
        userOwnerId
      );

      assert.equal(revealed.password, "super-secure-reveal-password");
      assert.equal(revealed.connectionString, "postgresql://reveal_user:super-secure-reveal-password@127.0.0.1:5432/revealdb");

      // Verify audit event
      const auditRes = await adminPool.query(
        `SELECT action, outcome, metadata FROM audit_events 
         WHERE organization_id = $1 AND action = 'resource.credentials.revealed' AND outcome = 'success'
         ORDER BY created_at DESC LIMIT 1;`,
        [orgAlphaId]
      );
      assert.equal(auditRes.rows.length, 1);
      const meta = auditRes.rows[0].metadata;
      assert.equal(meta.username, "reveal_user");
      assert.equal((meta as any).password, undefined);
    });

    it("8.2 should deny reveal to ordinary member and persist denied audit event autonomously", async () => {
      await assert.rejects(
        async () => {
          await resourceService.revealResourceCredential(
            runtimePool,
            {
              organizationId: orgAlphaId,
              projectId: projectAlphaId,
              resourceId: testResourceId,
            },
            userMemberId
          );
        },
        (err: any) => err instanceof ForbiddenError
      );

      // Verify autonomous audit record was written even though the attempt failed
      const auditRes = await adminPool.query(
        `SELECT action, outcome, metadata FROM audit_events 
         WHERE organization_id = $1 AND action = 'resource.credentials.revealed' AND outcome = 'denied'
         ORDER BY created_at DESC LIMIT 1;`,
        [orgAlphaId]
      );
      assert.equal(auditRes.rows.length, 1);
      assert.equal(auditRes.rows[0].outcome, "denied");
      assert.equal(auditRes.rows[0].metadata.errorCode, "FORBIDDEN");
    });
  });

  describe("9. AES-256-GCM Tenant AAD Cryptographic Binding", () => {
    it("9.1 should fail decryption if ciphertext is tampered or used with mismatched tenant AAD", () => {
      const secret = "tenant-isolated-key";
      const encrypted = encryptSecret(secret, orgAlphaId);

      // 1. Decrypt with correct tenant AAD
      const decrypted = decryptSecret(encrypted, orgAlphaId);
      assert.equal(decrypted, secret);

      // 2. Decrypt with mismatched tenant AAD
      assert.throws(
        () => {
          decryptSecret(encrypted, orgBetaId);
        },
        (err: any) => err instanceof ValidationError && err.message.includes("Authentication tag mismatch")
      );
    });
  });
});
