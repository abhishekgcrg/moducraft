import pg from "pg";

const { Pool } = pg;

export interface RoleInspectionResult {
  currentUser: string;
  sessionUser: string;
  isSuperuser: boolean;
  bypassRls: boolean;
}

export class PrivilegedConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivilegedConnectionError";
  }
}

export function createDatabasePool(connectionString: string): pg.Pool {
  if (process.env.NODE_ENV === "test") {
    try {
      const parsed = new URL(connectionString);
      const dbName = decodeURIComponent(parsed.pathname.replace(/^\/+/, "").trim());
      if (dbName.toLowerCase() === "moducraft") {
        throw new Error(
          `[FAIL-CLOSED SAFETY GUARD] createDatabasePool() attempted to connect to primary database 'moducraft' in test environment (NODE_ENV=test). Tests must target dedicated test database 'moducraft_test'.`
        );
      }
    } catch (err: any) {
      if (err.message.includes("[FAIL-CLOSED SAFETY GUARD]")) {
        throw err;
      }
    }
  }

  return new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
}

/**
 * Asserts that the connected database role is strictly an unprivileged runtime role.
 * If the connection is a superuser or possesses BYPASSRLS, this method throws an error
 * to prevent accidental privileged application database access.
 */
export async function assertRestrictedRole(pool: pg.Pool): Promise<RoleInspectionResult> {
  const result = await pool.query<{
    current_user: string;
    session_user: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
  }>(`
    SELECT 
      current_user,
      session_user,
      r.rolsuper,
      r.rolbypassrls
    FROM pg_roles r
    WHERE r.rolname = current_user;
  `);

  if (result.rows.length === 0) {
    throw new PrivilegedConnectionError(
      "Unable to inspect role attributes for current database connection."
    );
  }

  const row = result.rows[0];
  const inspection: RoleInspectionResult = {
    currentUser: row.current_user,
    sessionUser: row.session_user,
    isSuperuser: row.rolsuper,
    bypassRls: row.rolbypassrls,
  };

  if (inspection.isSuperuser) {
    throw new PrivilegedConnectionError(
      `SECURITY VIOLATION: Database connection is using superuser role "${inspection.currentUser}". Application requests MUST connect as an unprivileged runtime role.`
    );
  }

  if (inspection.bypassRls) {
    throw new PrivilegedConnectionError(
      `SECURITY VIOLATION: Database connection role "${inspection.currentUser}" has BYPASSRLS privilege. Application requests MUST NOT bypass Row-Level Security.`
    );
  }

  return inspection;
}
