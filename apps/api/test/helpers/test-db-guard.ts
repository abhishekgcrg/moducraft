/**
 * ModuCraft Test Database Safety Guard
 * 
 * FAIL-CLOSED invariant:
 * Under NO circumstances may any test suite connect to or run against the primary
 * database ('moducraft'). Any missing, malformed, empty, or unapproved database URL
 * must immediately halt execution before opening a connection.
 */

export const APPROVED_TEST_DB_NAME = "moducraft_test";
export const PROHIBITED_PRIMARY_DB_NAME = "moducraft";

export interface DatabaseUrlValidationResult {
  parsedUrl: URL;
  dbName: string;
  sanitizedTarget: string; // e.g. "127.0.0.1:5432/moducraft_test" without credentials
}

export interface ValidationOptions {
  allowDisposable?: boolean;
  allowPrimaryReadOnly?: boolean;
  allowAdminRoot?: boolean;
}

/**
 * Validates a database connection string against strict test-isolation rules.
 * Throws immediately if unsafe, unapproved, malformed, or missing.
 */
export function validateDatabaseUrlForTest(
  rawUrl: unknown,
  contextName = "DATABASE_URL",
  options: ValidationOptions = {}
): DatabaseUrlValidationResult {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new Error(
      `[FAIL-CLOSED TEST GUARD] Missing or empty database URL for '${contextName}'. ` +
        `Tests must explicitly target approved test database '${APPROVED_TEST_DB_NAME}'. ` +
        `Fallback to primary database '${PROHIBITED_PRIMARY_DB_NAME}' is strictly prohibited.`
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error(
      `[FAIL-CLOSED TEST GUARD] Malformed database URL for '${contextName}'. Expected a valid postgresql:// connection string.`
    );
  }

  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error(
      `[FAIL-CLOSED TEST GUARD] Invalid database protocol '${parsed.protocol}' for '${contextName}'. Expected 'postgresql:'.`
    );
  }

  // Extract clean database name from pathname (e.g. "/moducraft_test" -> "moducraft_test")
  const rawDbName = parsed.pathname.replace(/^\/+/, "").trim();
  const dbName = decodeURIComponent(rawDbName);

  if (!dbName) {
    throw new Error(
      `[FAIL-CLOSED TEST GUARD] Database URL for '${contextName}' specifies no target database name.`
    );
  }

  const sanitizedTarget = `${parsed.host}/${dbName}`;

  // Check 1: Primary database prohibition
  if (dbName.toLowerCase() === PROHIBITED_PRIMARY_DB_NAME) {
    if (!options.allowPrimaryReadOnly) {
      throw new Error(
        `[FAIL-CLOSED TEST GUARD] FATAL SAFETY VIOLATION: Database URL for '${contextName}' targets the primary database '${PROHIBITED_PRIMARY_DB_NAME}'. ` +
          `Running tests against the primary database is strictly prohibited.`
      );
    }
    return { parsedUrl: parsed, dbName, sanitizedTarget };
  }

  // Check 2: Disposable databases (used by migration replay tests, e.g. moducraft_disposable_*)
  if (options.allowDisposable && dbName.startsWith("moducraft_disposable_")) {
    if (!/^moducraft_disposable_[a-z0-9_]+$/.test(dbName)) {
      throw new Error(
        `[FAIL-CLOSED TEST GUARD] Invalid disposable database name format: '${dbName}'. ` +
          `Must match '^moducraft_disposable_[a-z0-9_]+$'.`
      );
    }
    return { parsedUrl: parsed, dbName, sanitizedTarget };
  }

  // Check 3: Administrative root database 'postgres' (only allowed for CREATE/DROP of disposable DBs)
  if (options.allowAdminRoot && dbName.toLowerCase() === "postgres") {
    return { parsedUrl: parsed, dbName, sanitizedTarget };
  }

  // Check 4: Approved test database name requirement
  if (dbName !== APPROVED_TEST_DB_NAME) {
    throw new Error(
      `[FAIL-CLOSED TEST GUARD] Database URL for '${contextName}' targets unapproved database '${dbName}'. ` +
        `Tests are only permitted to target '${APPROVED_TEST_DB_NAME}' (or registered disposable databases).`
    );
  }

  return { parsedUrl: parsed, dbName, sanitizedTarget };
}

/**
 * Retrieves and validates test database URLs from environment variables.
 * Fails closed immediately if any required URL is missing or points to the primary database.
 */
export function getTestDatabaseUrls(options: ValidationOptions = {}): {
  runtimeDbUrl: string;
  superuserDbUrl: string;
  primaryDbUrl?: string;
} {
  const runtimeUrl = process.env.DATABASE_URL;
  const superuserUrl =
    process.env.TEST_SUPERUSER_DATABASE_URL ||
    process.env.DATABASE_ADMIN_URL ||
    process.env.ADMIN_DATABASE_URL;
  const primaryUrl = process.env.PRIMARY_DATABASE_URL;

  // Validate runtime URL (strictly prohibited from targeting primary moducraft)
  validateDatabaseUrlForTest(runtimeUrl, "DATABASE_URL", options);

  // Validate superuser URL (used for test fixture seeding in test database only)
  validateDatabaseUrlForTest(superuserUrl, "TEST_SUPERUSER_DATABASE_URL", options);

  // If primaryUrl is provided for read-only zero-drift audit tests, validate its shape
  if (primaryUrl) {
    validateDatabaseUrlForTest(primaryUrl, "PRIMARY_DATABASE_URL", {
      allowPrimaryReadOnly: true,
    });
  }

  return {
    runtimeDbUrl: runtimeUrl as string,
    superuserDbUrl: superuserUrl as string,
    primaryDbUrl: primaryUrl,
  };
}

/**
 * Derives a validated connection URL for a disposable test database.
 */
export function getDisposableDatabaseUrl(disposableDbName: string): string {
  if (!disposableDbName.startsWith("moducraft_disposable_") || !/^moducraft_disposable_[a-z0-9_]+$/.test(disposableDbName)) {
    throw new Error(
      `[FAIL-CLOSED TEST GUARD] Invalid disposable database name format: '${disposableDbName}'.`
    );
  }
  const { superuserDbUrl } = getTestDatabaseUrls({ allowDisposable: true });
  const parsed = new URL(superuserDbUrl);
  parsed.pathname = `/${disposableDbName}`;
  const derivedUrl = parsed.toString();
  validateDatabaseUrlForTest(derivedUrl, "Disposable Database URL", { allowDisposable: true });
  return derivedUrl;
}

/**
 * Derives a validated connection URL to the root administrative database ('postgres')
 * for the sole purpose of issuing CREATE DATABASE / DROP DATABASE for disposable DBs.
 */
export function getAdminRootDatabaseUrl(): string {
  const { superuserDbUrl } = getTestDatabaseUrls({ allowAdminRoot: true });
  const parsed = new URL(superuserDbUrl);
  parsed.pathname = "/postgres";
  const derivedUrl = parsed.toString();
  validateDatabaseUrlForTest(derivedUrl, "Admin Root Database URL", { allowAdminRoot: true });
  return derivedUrl;
}
