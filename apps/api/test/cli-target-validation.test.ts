import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveAndValidateMigrationTarget,
  MigrationTargetValidationError,
  PROHIBITED_PRIMARY_DB_NAME,
  APPROVED_TEST_DB_NAME,
} from "../src/db/migration-target.js";

describe("Migration CLI Target Validation Unit Tests (Zero DB Dependency)", () => {
  it("should fail closed when state-changing command has no explicit target in test mode", () => {
    assert.throws(
      () => {
        resolveAndValidateMigrationTarget(undefined, "migrate", {
          NODE_ENV: "test",
        });
      },
      (err: any) => {
        assert.ok(err instanceof MigrationTargetValidationError);
        assert.match(err.message, /Explicit target database URL required/);
        return true;
      }
    );
  });

  it("should fail closed when state-changing command has no explicit target in development mode", () => {
    assert.throws(
      () => {
        resolveAndValidateMigrationTarget(undefined, "migrate", {
          NODE_ENV: "development",
        });
      },
      (err: any) => {
        assert.ok(err instanceof MigrationTargetValidationError);
        assert.match(err.message, /Explicit target database URL required/);
        return true;
      }
    );
  });

  it("should strictly REJECT primary database 'moducraft' for migrate in test mode", () => {
    assert.throws(
      () => {
        resolveAndValidateMigrationTarget(
          "postgresql://moducraft:secret@127.0.0.1:5432/moducraft",
          "migrate",
          { NODE_ENV: "test" }
        );
      },
      (err: any) => {
        assert.ok(err instanceof MigrationTargetValidationError);
        assert.match(err.message, /strictly prohibited against primary database 'moducraft'/);
        return true;
      }
    );
  });

  it("should strictly REJECT primary database 'moducraft' for adopt in test mode", () => {
    assert.throws(
      () => {
        resolveAndValidateMigrationTarget(
          "postgresql://moducraft:secret@127.0.0.1:5432/moducraft",
          "adopt",
          { MODUCRAFT_TEST_MODE: "true" }
        );
      },
      (err: any) => {
        assert.ok(err instanceof MigrationTargetValidationError);
        assert.match(err.message, /strictly prohibited against primary database 'moducraft'/);
        return true;
      }
    );
  });

  it("should accept approved test database 'moducraft_test' for migrate in test mode", () => {
    const result = resolveAndValidateMigrationTarget(
      "postgresql://moducraft:secret@127.0.0.1:5432/moducraft_test",
      "migrate",
      { NODE_ENV: "test" }
    );

    assert.equal(result.dbName, APPROVED_TEST_DB_NAME);
    assert.equal(result.isTestMode, true);
    assert.equal(result.sanitizedTarget, "127.0.0.1:5432/moducraft_test");
  });

  it("should accept valid disposable database names in test mode", () => {
    const result = resolveAndValidateMigrationTarget(
      "postgresql://moducraft:secret@127.0.0.1:5432/moducraft_disposable_eval_1",
      "migrate",
      { NODE_ENV: "test" }
    );

    assert.equal(result.dbName, "moducraft_disposable_eval_1");
    assert.equal(result.isTestMode, true);
  });

  it("should reject unapproved database names in test mode", () => {
    assert.throws(
      () => {
        resolveAndValidateMigrationTarget(
          "postgresql://moducraft:secret@127.0.0.1:5432/production_analytics",
          "migrate",
          { NODE_ENV: "test" }
        );
      },
      (err: any) => {
        assert.ok(err instanceof MigrationTargetValidationError);
        assert.match(err.message, /unapproved for migrations in test mode/);
        return true;
      }
    );
  });

  it("should fail closed on malformed database connection string", () => {
    assert.throws(
      () => {
        resolveAndValidateMigrationTarget(
          "not_a_valid_url",
          "migrate",
          { NODE_ENV: "test" }
        );
      },
      (err: any) => {
        assert.ok(err instanceof MigrationTargetValidationError);
        assert.match(err.message, /Malformed database URL/);
        return true;
      }
    );
  });

  it("should fail closed on invalid protocol", () => {
    assert.throws(
      () => {
        resolveAndValidateMigrationTarget(
          "http://127.0.0.1:5432/moducraft_test",
          "migrate",
          { NODE_ENV: "test" }
        );
      },
      (err: any) => {
        assert.ok(err instanceof MigrationTargetValidationError);
        assert.match(err.message, /Invalid database protocol/);
        return true;
      }
    );
  });

  it("should fail closed when database URL has empty path", () => {
    assert.throws(
      () => {
        resolveAndValidateMigrationTarget(
          "postgresql://moducraft:secret@127.0.0.1:5432/",
          "migrate",
          { NODE_ENV: "test" }
        );
      },
      (err: any) => {
        assert.ok(err instanceof MigrationTargetValidationError);
        assert.match(err.message, /specifies no target database name/);
        return true;
      }
    );
  });

  it("should allow status command in development mode without explicit URL", () => {
    const result = resolveAndValidateMigrationTarget(undefined, "status", {
      NODE_ENV: "development",
    });

    assert.equal(result.dbName, PROHIBITED_PRIMARY_DB_NAME);
    assert.equal(result.isTestMode, false);
  });
});
