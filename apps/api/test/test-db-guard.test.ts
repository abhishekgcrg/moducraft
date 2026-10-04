import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateDatabaseUrlForTest,
  getTestDatabaseUrls,
  APPROVED_TEST_DB_NAME,
  PROHIBITED_PRIMARY_DB_NAME,
} from "./helpers/test-db-guard.js";

describe("Test Database Guard Fail-Closed Unit Tests", () => {
  it("should fail closed when database URL is undefined, null, or empty string", () => {
    assert.throws(
      () => validateDatabaseUrlForTest(undefined, "DATABASE_URL"),
      /Missing or empty database URL for 'DATABASE_URL'/
    );
    assert.throws(
      () => validateDatabaseUrlForTest(null, "DATABASE_URL"),
      /Missing or empty database URL for 'DATABASE_URL'/
    );
    assert.throws(
      () => validateDatabaseUrlForTest("", "DATABASE_URL"),
      /Missing or empty database URL for 'DATABASE_URL'/
    );
    assert.throws(
      () => validateDatabaseUrlForTest("   ", "DATABASE_URL"),
      /Missing or empty database URL for 'DATABASE_URL'/
    );
  });

  it("should fail closed on malformed database connection strings", () => {
    assert.throws(
      () => validateDatabaseUrlForTest("not-a-valid-url", "DATABASE_URL"),
      /Malformed database URL for 'DATABASE_URL'/
    );
    assert.throws(
      () => validateDatabaseUrlForTest("http://localhost:5432/moducraft_test", "DATABASE_URL"),
      /Invalid database protocol 'http:' for 'DATABASE_URL'/
    );
  });

  it("should fail closed when database URL specifies no database name", () => {
    assert.throws(
      () => validateDatabaseUrlForTest("postgresql://localhost:5432", "DATABASE_URL"),
      /specifies no target database name/
    );
    assert.throws(
      () => validateDatabaseUrlForTest("postgresql://localhost:5432/", "DATABASE_URL"),
      /specifies no target database name/
    );
    assert.throws(
      () => validateDatabaseUrlForTest("postgresql://localhost:5432/   ", "DATABASE_URL"),
      /specifies no target database name/
    );
  });

  it("should STRICTLY REJECT primary database 'moducraft' with fatal safety error", () => {
    const primaryUrls = [
      "postgresql://moducraft_runtime:secret@127.0.0.1:5432/moducraft",
      "postgresql://moducraft:secret@localhost:5432/moducraft",
      "postgresql://app_user:secret@127.0.0.1:5432/MODUCRAFT",
      "postgresql://app_user:secret@127.0.0.1:5432/ModuCraft",
    ];

    for (const url of primaryUrls) {
      assert.throws(
        () => validateDatabaseUrlForTest(url, "DATABASE_URL"),
        (err: any) => {
          assert.ok(err.message.includes("FATAL SAFETY VIOLATION"));
          assert.ok(err.message.includes("targets the primary database 'moducraft'"));
          return true;
        }
      );
    }
  });

  it("should reject arbitrary unapproved database names", () => {
    const unapprovedUrls = [
      "postgresql://moducraft_runtime:secret@127.0.0.1:5432/postgres",
      "postgresql://moducraft_runtime:secret@127.0.0.1:5432/production_data",
      "postgresql://moducraft_runtime:secret@127.0.0.1:5432/my_test_db",
      "postgresql://moducraft_runtime:secret@127.0.0.1:5432/moducraft_prod",
    ];

    for (const url of unapprovedUrls) {
      assert.throws(
        () => validateDatabaseUrlForTest(url, "DATABASE_URL"),
        /targets unapproved database/
      );
    }
  });

  it("should accept approved test database name 'moducraft_test' and sanitize output", () => {
    const validUrl = "postgresql://moducraft_runtime:super_secret_password@127.0.0.1:5432/moducraft_test";
    const result = validateDatabaseUrlForTest(validUrl, "DATABASE_URL");

    assert.equal(result.dbName, APPROVED_TEST_DB_NAME);
    assert.equal(result.sanitizedTarget, "127.0.0.1:5432/moducraft_test");
    // Ensure sanitizedTarget contains NO credentials
    assert.ok(!result.sanitizedTarget.includes("super_secret_password"));
    assert.ok(!result.sanitizedTarget.includes("moducraft_runtime"));
  });

  it("should accept disposable databases when allowDisposable is explicitly enabled", () => {
    const dispUrl = "postgresql://moducraft:secret@127.0.0.1:5432/moducraft_disposable_eval_123456";
    
    // Without allowDisposable, it must be rejected
    assert.throws(
      () => validateDatabaseUrlForTest(dispUrl, "DATABASE_URL"),
      /targets unapproved database/
    );

    // With allowDisposable, it passes
    const result = validateDatabaseUrlForTest(dispUrl, "DATABASE_URL", { allowDisposable: true });
    assert.equal(result.dbName, "moducraft_disposable_eval_123456");
  });

  it("should fail closed in getTestDatabaseUrls if environment variables are missing or point to primary DB", () => {
    const originalEnv = { ...process.env };

    try {
      // Case 1: Unset env vars
      delete process.env.DATABASE_URL;
      delete process.env.TEST_SUPERUSER_DATABASE_URL;
      assert.throws(() => getTestDatabaseUrls(), /Missing or empty database URL/);

      // Case 2: Pointing to primary moducraft
      process.env.DATABASE_URL = "postgresql://moducraft_runtime:secret@127.0.0.1:5432/moducraft";
      process.env.TEST_SUPERUSER_DATABASE_URL = "postgresql://moducraft:secret@127.0.0.1:5432/moducraft_test";
      assert.throws(() => getTestDatabaseUrls(), /FATAL SAFETY VIOLATION/);

      // Case 3: Both correctly pointing to moducraft_test
      process.env.DATABASE_URL = "postgresql://moducraft_runtime:secret@127.0.0.1:5432/moducraft_test";
      process.env.TEST_SUPERUSER_DATABASE_URL = "postgresql://moducraft:secret@127.0.0.1:5432/moducraft_test";
      const urls = getTestDatabaseUrls();
      assert.ok(urls.runtimeDbUrl.includes("moducraft_test"));
      assert.ok(urls.superuserDbUrl.includes("moducraft_test"));
    } finally {
      process.env = originalEnv;
    }
  });

  it("should fail closed if any code tries to construct pg.Pool targeting primary database moducraft", async () => {
    // Import bootstrap to ensure interceptors are active
    await import("./helpers/test-bootstrap.js");
    const pg = (await import("pg")).default;

    // String connection string targeting moducraft
    assert.throws(
      () => new pg.Pool({ connectionString: "postgresql://moducraft_runtime:secret@127.0.0.1:5432/moducraft" }),
      /FATAL SAFETY VIOLATION/
    );

    assert.throws(
      () => new pg.Client({ connectionString: "postgresql://moducraft:secret@127.0.0.1:5432/moducraft" }),
      /FATAL SAFETY VIOLATION/
    );

    // Object configuration with database: 'moducraft'
    assert.throws(
      () => new pg.Pool({ host: "127.0.0.1", port: 5432, database: "moducraft" }),
      /FATAL SAFETY VIOLATION/
    );

    assert.throws(
      () => new pg.Client({ host: "127.0.0.1", port: 5432, database: "moducraft" }),
      /FATAL SAFETY VIOLATION/
    );

    // Object configuration with unapproved database
    assert.throws(
      () => new pg.Pool({ host: "127.0.0.1", port: 5432, database: "production_db" }),
      /targets unapproved database/
    );
  });

  it("should verify test bootstrap enforces NODE_ENV=test", async () => {
    await import("./helpers/test-bootstrap.js");
    assert.equal(process.env.NODE_ENV, "test");
  });
});

