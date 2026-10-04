import type pg from "pg";

export interface ScopedTransaction {
  /**
   * Executes a parameterized query strictly within the boundaries of this transaction.
   */
  query<R extends pg.QueryResultRow = any, I extends any[] = any[]>(
    queryText: string,
    values?: I
  ): Promise<pg.QueryResult<R>>;
}

/**
 * Reusable database transaction helper for authenticated requests.
 *
 * Security & Isolation Guarantees:
 * 1. Acquires a dedicated client from the pool.
 * 2. Begins an explicit transaction (`BEGIN`).
 * 3. Sets `app.user_id` using parameterized SQL with transaction-local scope:
 *    `SELECT set_config('app.user_id', $1, true)`. The `true` argument ensures
 *    the setting is local to the transaction and automatically reverted on COMMIT/ROLLBACK.
 * 4. Pass-through: Only exposes `ScopedTransaction` to the callback, preventing accidental
 *    queries against an unscoped pool connection.
 * 5. Commits strictly on success; rolls back on any error; always releases client back to the pool.
 *
 * NOTE ON TRUST BOUNDARY:
 * `app.user_id` is an application-to-database context forwarding mechanism, NOT a cryptographic
 * proof of identity. Any client that can issue arbitrary SQL directly under the runtime role
 * can invoke `set_config('app.user_id', ...)` to spoof this value. It is critical that all
 * application queries use parameterized inputs to prevent SQL injection.
 */
export async function withAuthenticatedContext<T>(
  pool: pg.Pool,
  userId: string,
  fn: (tx: ScopedTransaction) => Promise<T>
): Promise<T> {
  if (!userId || typeof userId !== "string") {
    throw new Error("withAuthenticatedContext requires a valid user ID string.");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    // Explicit parameterized setting with is_local = true (transaction-local)
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);

    const tx: ScopedTransaction = {
      query: <R extends pg.QueryResultRow = any>(queryText: string, values?: any[]) => {
        if (values !== undefined) {
          return client.query<R>(queryText, values);
        }
        return client.query<R>(queryText);
      },
    };

    const result = await fn(tx);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Retain original error for debugging while ensuring rollback attempt
    }
    throw error;
  } finally {
    client.release();
  }
}
