/**
 * ModuCraft Migration Target Resolver and Fail-Closed Safety Validator
 * 
 * Enforces strict isolation rules:
 * 1. State-changing migration commands ('migrate', 'adopt') require an explicit target.
 * 2. In test or provisioning mode (NODE_ENV=test or MODUCRAFT_TEST_MODE=true), state-changing
 *    migrations targeting the primary database ('moducraft') are unconditionally prohibited.
 * 3. Malformed, empty, or protocol-invalid database URLs fail closed immediately.
 * 4. Read-only status commands preserve standard development workflows without risking writes.
 */

export const PROHIBITED_PRIMARY_DB_NAME = "moducraft";
export const APPROVED_TEST_DB_NAME = "moducraft_test";

export interface MigrationTargetValidationResult {
  databaseUrl: string;
  dbName: string;
  sanitizedTarget: string;
  isTestMode: boolean;
}

export class MigrationTargetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationTargetValidationError";
  }
}

/**
 * Validates and resolves the database target URL for migration CLI commands.
 */
export function resolveAndValidateMigrationTarget(
  explicitUrl: string | undefined,
  command: string,
  env: Record<string, string | undefined> = process.env
): MigrationTargetValidationResult {
  const isStateChanging = command === "migrate" || command === "adopt";
  const isTestMode =
    env.NODE_ENV === "test" ||
    env.MODUCRAFT_TEST_MODE === "true" ||
    env.TEST_MODE === "true";

  // Priority resolution: explicit argument > MIGRATION_DATABASE_URL > ADMIN_DATABASE_URL > DATABASE_URL
  const candidateUrl =
    explicitUrl ||
    env.MIGRATION_DATABASE_URL ||
    env.ADMIN_DATABASE_URL ||
    env.DATABASE_URL;

  // Rule 1: State-changing commands MUST have an explicit candidate URL
  if (isStateChanging && (!candidateUrl || !candidateUrl.trim())) {
    throw new MigrationTargetValidationError(
      `[FAIL-CLOSED MIGRATION TARGET] Explicit target database URL required for state-changing command '${command}'. ` +
        `Set MIGRATION_DATABASE_URL or ADMIN_DATABASE_URL. Silent fallback to primary database '${PROHIBITED_PRIMARY_DB_NAME}' is disabled.`
    );
  }

  // Fallback for read-only status in local dev when no URL is provided
  const resolvedUrl =
    candidateUrl && candidateUrl.trim()
      ? candidateUrl.trim()
      : "postgresql://moducraft:moducraft_local_only@127.0.0.1:5432/moducraft";

  // Parse and validate URL structure
  let parsed: URL;
  try {
    parsed = new URL(resolvedUrl);
  } catch {
    throw new MigrationTargetValidationError(
      `[FAIL-CLOSED MIGRATION TARGET] Malformed database URL provided for migration command '${command}'. ` +
        `Expected a valid postgresql:// connection string.`
    );
  }

  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new MigrationTargetValidationError(
      `[FAIL-CLOSED MIGRATION TARGET] Invalid database protocol '${parsed.protocol}' for migration command '${command}'. ` +
        `Expected 'postgresql:'.`
    );
  }

  const rawDbName = parsed.pathname.replace(/^\/+/, "").trim();
  const dbName = decodeURIComponent(rawDbName);

  if (!dbName) {
    throw new MigrationTargetValidationError(
      `[FAIL-CLOSED MIGRATION TARGET] Database URL for migration command '${command}' specifies no target database name.`
    );
  }

  const sanitizedTarget = `${parsed.host}/${dbName}`;

  // Rule 2: In test/provisioning mode, state-changing commands CANNOT target primary database 'moducraft'
  if (isTestMode && isStateChanging) {
    if (dbName.toLowerCase() === PROHIBITED_PRIMARY_DB_NAME) {
      throw new MigrationTargetValidationError(
        `[FAIL-CLOSED MIGRATION TARGET] FATAL SAFETY VIOLATION: State-changing migration command '${command}' ` +
          `is strictly prohibited against primary database '${PROHIBITED_PRIMARY_DB_NAME}' in test/provisioning mode.`
      );
    }

    const isDisposable =
      dbName.startsWith("moducraft_disposable_") &&
      /^moducraft_disposable_[a-z0-9_]+$/.test(dbName);

    if (dbName !== APPROVED_TEST_DB_NAME && !isDisposable) {
      throw new MigrationTargetValidationError(
        `[FAIL-CLOSED MIGRATION TARGET] Database target '${dbName}' is unapproved for migrations in test mode. ` +
          `Must target '${APPROVED_TEST_DB_NAME}' or a valid 'moducraft_disposable_*' database.`
      );
    }
  }

  return {
    databaseUrl: resolvedUrl,
    dbName,
    sanitizedTarget,
    isTestMode,
  };
}
