import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {
  createDatabasePool,
  assertRestrictedRole,
  PrivilegedConnectionError,
} from "../src/db/pool.js";
import { getTestDatabaseUrls } from "./helpers/test-db-guard.js";

const { Pool } = pg;

describe("Database Connection & Role Privilege Assertions", () => {
  const { runtimeDbUrl, superuserDbUrl } = getTestDatabaseUrls();

  let runtimePool: pg.Pool;

  before(() => {
    runtimePool = createDatabasePool(runtimeDbUrl);
  });

  after(async () => {
    await runtimePool.end();
  });

  it("should successfully connect using the restricted runtime role (moducraft_runtime)", async () => {
    const roleInfo = await assertRestrictedRole(runtimePool);

    assert.equal(roleInfo.currentUser, "moducraft_runtime");
    assert.equal(roleInfo.isSuperuser, false, "Runtime role must not be a superuser");
    assert.equal(roleInfo.bypassRls, false, "Runtime role must not have BYPASSRLS");
  });

  it("should throw PrivilegedConnectionError when connecting as superuser", async () => {
    const privilegedPool = new Pool({
      connectionString: superuserDbUrl,
      max: 1,
    });

    try {
      await assert.rejects(
        async () => {
          await assertRestrictedRole(privilegedPool);
        },
        (err: any) => {
          assert.ok(err instanceof PrivilegedConnectionError);
          assert.match(err.message, /SECURITY VIOLATION.*superuser/);
          return true;
        }
      );
    } finally {
      await privilegedPool.end();
    }
  });
});
