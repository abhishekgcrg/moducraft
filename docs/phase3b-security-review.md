# Phase 3B Security Review & Hardening Report

## 1. Executive Summary

This security review evaluates the implementation of the ModuCraft Phase 3B Organization and Project CRUD APIs, focusing on the PostgreSQL database security boundary, forced Row-Level Security (RLS), connection pooling safety, the audit logging `SECURITY DEFINER` function, and API input validation.

### Verification Highlights:
- **Clean Database Reproducibility:** Migrations `0001` through `0004` were verified by applying them in sequence onto a pristine disposable database (`moducraft_disposable_test`), confirming full reproducibility and idempotency.
- **Automated Test Coverage:**
  - Fastify API & Database Integration Suites: **60 / 60 tests passed across 7 test suites** (`pnpm --filter @moducraft/api test`).
  - PostgreSQL Authorization Regression Suite: **All 9 test blocks passed** (`phase2_authorization_test.sql`).
  - Monorepo Typecheck: **0 errors** (`pnpm typecheck`).
- **Audit Logging Function Hardened:** The `public.moducraft_record_audit_event(...)` function was hardened to enforce mandatory organization ID checks, argument bounds, JSON object validation, and database-level blocking of sensitive credential keys (`password`, `secret`, `token`, `apiKey`, `authorization`, `cookie`, `jwt`, `private_key`).

---

## 2. Review of the Audit `SECURITY DEFINER` Function

### A. Ownership, Privileges & Search Path
- **Owner:** `moducraft` (table owner).
- **Execution Grant:** Revoked from `PUBLIC`; granted strictly to `moducraft_runtime`.
- **Search Path:** Pinned to `'pg_catalog', 'pg_temp'`, preventing schema-hijacking attacks.

### B. Security Defenses & Invariants
1. **Actor Spoofing Protection:** The function takes no `actor_user_id` argument. The actor is derived exclusively via `v_actor_id := public.moducraft_current_user_id()`. An attacker or caller cannot forge audit logs on behalf of another user.
2. **Mandatory Organization Scope:** `p_organization_id` is strictly mandatory (`IS NOT NULL`). Calling the function with `NULL` organization ID raises an exception. Furthermore, `public.moducraft_is_org_member(p_organization_id)` is evaluated to prevent cross-tenant audit injection.
3. **Sensitive Metadata Filter:** In addition to backend logger redaction, the database function itself verifies that metadata does not contain sensitive keys (`password`, `secret`, `token`, `apiKey`, `authorization`, `cookie`, `jwt`, `private_key`).
4. **Metadata Structure:** Metadata must be a valid JSON object (`jsonb_typeof = 'object'`), blocking unstructured strings or arrays.
5. **Outcome & Length Checks:** `outcome` must be one of `'success'`, `'denied'`, `'failure'`. `action` (1–120 chars) and `resource_type` (1–80 chars) are length-bounded.
6. **Direct Table Manipulation Prohibited:** `moducraft_runtime` has only `SELECT` on `audit_events`. Direct `INSERT`, `UPDATE`, and `DELETE` remain denied by PostgreSQL table grants (`42501`).
7. **Transactional Atomicity:** Audit writes occur within the caller's active database transaction (`ScopedTransaction`). If any mutation fails (e.g. unique slug collision), the audit entry rolls back with the mutation, preventing phantom audit entries.

---

## 3. Database Authorization & RLS Verification

Tests executed against the live Docker PostgreSQL container confirmed the following:
- **Role Permissions:**
  - `owner`: Can create, read, update projects, and delete projects.
  - `admin`: Can create, read, update projects, and delete projects.
  - `member`: Can create, read, and update projects; **cannot delete projects** (`403 Forbidden`).
  - `viewer`: Can only read projects; **cannot create, update, or delete projects** (`403 Forbidden`).
- **Tenant Isolation:**
  - Users can only view organizations and projects in tenants where they have active memberships.
  - Cross-tenant requests to organizations or projects return `404 Not Found` (never `403`), preventing tenant enumeration.
- **Column Immutability:**
  - Fine-grained column grants (`GRANT UPDATE (name, slug, description) ON public.projects`) prevent modifying `id`, `organization_id`, or `created_by`.
  - Database trigger `projects_set_updated_at` automatically maintains `updated_at`.
- **Identity Isolation Across Pooled Connections:**
  - Tested on a pool restricted to 1 connection. Consecutive requests with alternating user tokens verified that `current_setting('app.user_id', true)` is cleared at transaction end and never leaks across requests.

---

## 4. API Input Validation & Information Leakage Prevention

- **Zod Schema Validation:**
  - Strict object validation (`.strict()`) rejects requests attempting to pass `id`, `created_by`, `organization_id`, or unknown fields.
  - Slug validation enforces regex `^[a-z0-9]+(-[a-z0-9]+)*$` up to 120 characters.
  - `limit` parameter is capped between 1 and 100 (default 20); `offset` must be non-negative.
- **Sanitized Global Error Handling:**
  - `Fastify.setErrorHandler` catches domain `AppError` and validation errors.
  - Database errors (e.g. 500) return a generic `"An internal server error occurred."` with zero SQL queries, table names, or stack traces leaked to clients.

---

## 5. Migration Reproducibility Verification

1. **Applied Migrations in Repository:**
   - `0001_identity_tenant_core.sql`: Core schema, forced RLS on 5 tables.
   - `0002_project_crud_and_runtime_role.sql`: `moducraft_runtime` role, RBAC functions, column-level grants, RLS policies.
   - `0003_runtime_login_role.sql`: `moducraft_runtime WITH LOGIN`, identity resolution helper.
   - `0004_audit_event_recording.sql`: Hardened audit event recording function.
2. **Clean Disposable Database Verification:**
   - Executed `CREATE DATABASE moducraft_disposable_test`.
   - Executed migrations `0001`, `0002`, `0003`, `0004` sequentially with `ON_ERROR_STOP=1`.
   - All migrations applied with exit code 0 and no errors.
   - Executed `phase2_authorization_test.sql` against the new database; all 9 test blocks passed.
   - Dropped the disposable database; development database remained untouched.

---

## 6. Categorized Findings

### A. Verified Findings
- RLS policies and table grants strictly prevent cross-tenant data access.
- Non-members cannot discover whether an organization or project exists (returns 404).
- Application traffic connects exclusively through unprivileged `moducraft_runtime`.
- Runtime role cannot bypass RLS (`NOBYPASSRLS`, `NOSUPERUSER`).
- Direct audit event tampering is prevented by table privilege denial.
- Identity setting `set_config('app.user_id', ..., true)` is transaction-local and does not leak across pooled connections.

### B. Fixed Findings during Review
1. **Audit NULL Organization ID Bypass:** Previously, a NULL `organization_id` bypassed membership validation. Fixed by requiring `p_organization_id IS NOT NULL` and verifying membership.
2. **Audit Metadata Credential Leakage:** Hardened `moducraft_record_audit_event` to inspect metadata keys and reject sensitive credential names (`password`, `secret`, `token`, `apiKey`, `authorization`, `cookie`, `jwt`, `private_key`).
3. **Audit Input Validation:** Added bounds checking for action, resource type, resource ID, and JSON object validation on metadata.
4. **Project `updated_at` Column Privilege:** Removed explicit `updated_at` column assignment from API update queries, respecting database column privileges and relying on the `projects_set_updated_at` trigger.

### C. Remaining Risks
- **`app.user_id` Trust Boundary:** Any caller with direct SQL access using the `moducraft_runtime` credentials can manually execute `set_config('app.user_id', ...)`. Tenant isolation at the database layer depends on the API backend enforcing authentication and authorization.

### D. Blocked Checks
- None. All automated test suites and live database checks ran to completion.

### E. Production Deployment Prerequisites
1. **Database Network Isolation:** Restrict PostgreSQL port 5432 to internal VPC/private Docker networks; external access must be disabled.
2. **Rotate Test Secrets:** Replace local development passwords and symmetric JWT secrets with production credentials stored in a dedicated secrets manager.
3. **OIDC Provider Connection:** Configure live OIDC discovery (`AUTH_JWKS_URI`) and issuer verification (`AUTH_ISSUER`, `AUTH_AUDIENCE`).
4. **Rate Limiting:** Implement rate limiting middleware (e.g. `@fastify/rate-limit`) prior to public deployment.
5. **Connection Pooler Policy:** If using PgBouncer in production, ensure transaction pooling mode is configured to prevent session-level leakage.
