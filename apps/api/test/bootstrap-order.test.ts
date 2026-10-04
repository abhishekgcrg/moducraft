import { describe, it } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const { Pool, Client } = pg;

describe("Bootstrap Preload & Loading Order Verification (Harmless Zero-DB Test)", () => {
  it("should prove that test-bootstrap was loaded and set NODE_ENV=test before test file ran", () => {
    assert.equal(
      process.env.NODE_ENV,
      "test",
      "NODE_ENV must be 'test' established by test-bootstrap"
    );
  });

  it("should prove that pg.Pool constructor was intercepted by GuardedPool before test file imported pg", () => {
    // Attempt to construct Pool targeting primary database moducraft
    assert.throws(
      () => new Pool({ connectionString: "postgresql://moducraft:secret@127.0.0.1:5432/moducraft" }),
      (err: any) => {
        assert.ok(err.message.includes("FATAL SAFETY VIOLATION"));
        assert.ok(err.message.includes("targets the primary database 'moducraft'"));
        return true;
      }
    );
  });

  it("should prove that pg.Client constructor was intercepted by GuardedClient before test file imported pg", () => {
    assert.throws(
      () => new Client({ database: "moducraft" }),
      (err: any) => {
        assert.ok(err.message.includes("FATAL SAFETY VIOLATION"));
        assert.ok(err.message.includes("targets prohibited primary database 'moducraft'"));
        return true;
      }
    );
  });
});
