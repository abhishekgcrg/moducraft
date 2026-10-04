/**
 * ModuCraft Centralized Test Bootstrap
 * 
 * Preloaded automatically in test runs via --import.
 * 
 * Enforces:
 * 1. NODE_ENV is locked to "test" before any other module runs.
 * 2. All pg.Pool and pg.Client connection strings and object configs are intercepted and validated.
 * 3. Connecting to the primary database ('moducraft') is unconditionally blocked.
 * 4. Only 'moducraft_test' (or 'moducraft_disposable_*' / admin root 'postgres') is permitted.
 */
import pg from "pg";
import {
  validateDatabaseUrlForTest,
  PROHIBITED_PRIMARY_DB_NAME,
  APPROVED_TEST_DB_NAME,
} from "./test-db-guard.js";

// 1. Force NODE_ENV to "test"
process.env.NODE_ENV = "test";

// 2. Validate environment variables upfront if already set
if (process.env.DATABASE_URL) {
  validateDatabaseUrlForTest(process.env.DATABASE_URL, "DATABASE_URL");
}

if (process.env.TEST_SUPERUSER_DATABASE_URL) {
  validateDatabaseUrlForTest(
    process.env.TEST_SUPERUSER_DATABASE_URL,
    "TEST_SUPERUSER_DATABASE_URL"
  );
}

if (process.env.PGDATABASE && process.env.PGDATABASE.toLowerCase() === PROHIBITED_PRIMARY_DB_NAME) {
  throw new Error(
    `[FAIL-CLOSED TEST GUARD] FATAL: PGDATABASE is set to prohibited primary database '${PROHIBITED_PRIMARY_DB_NAME}'.`
  );
}

function inspectConnectionConfig(config: any, context: string) {
  if (!config) return;

  if (typeof config === "string") {
    validateDatabaseUrlForTest(config, context, {
      allowDisposable: true,
      allowAdminRoot: true,
    });
    return;
  }

  if (typeof config === "object") {
    // If connectionString is supplied
    if (typeof config.connectionString === "string") {
      validateDatabaseUrlForTest(config.connectionString, `${context}.connectionString`, {
        allowDisposable: true,
        allowAdminRoot: true,
      });
      return;
    }

    // If database property is supplied
    if (typeof config.database === "string") {
      const dbName = config.database.toLowerCase().trim();
      if (dbName === PROHIBITED_PRIMARY_DB_NAME) {
        throw new Error(
          `[FAIL-CLOSED TEST GUARD] FATAL SAFETY VIOLATION: ${context} config targets prohibited primary database '${PROHIBITED_PRIMARY_DB_NAME}'.`
        );
      }
      const isDisposable =
        dbName.startsWith("moducraft_disposable_") &&
        /^moducraft_disposable_[a-z0-9_]+$/.test(dbName);

      if (dbName !== APPROVED_TEST_DB_NAME && !isDisposable && dbName !== "postgres") {
        throw new Error(
          `[FAIL-CLOSED TEST GUARD] ${context} config targets unapproved database '${config.database}'. ` +
            `Must target '${APPROVED_TEST_DB_NAME}' or disposable database.`
        );
      }
    }
  }
}

// Hook pg.Pool
const OriginalPool = pg.Pool;

class GuardedPool extends OriginalPool {
  constructor(config?: any) {
    inspectConnectionConfig(config, "pg.Pool");
    super(config);
  }
}

// Hook pg.Client
const OriginalClient = pg.Client;

class GuardedClient extends OriginalClient {
  constructor(config?: any) {
    inspectConnectionConfig(config, "pg.Client");
    super(config);
  }
}

// Replace constructors on the pg module
(pg as any).Pool = GuardedPool;
(pg as any).Client = GuardedClient;
