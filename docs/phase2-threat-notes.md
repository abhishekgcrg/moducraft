# Phase 2 & Phase 3 Threat Notes & Identity Trust Boundary Analysis

## 1. Verified Core Threat Mitigations
- **RLS Bypass Prevention:** Verified that runtime role `moducraft_runtime` possesses `NOSUPERUSER` and `NOBYPASSRLS`. Administrative superusers bypass RLS even under `FORCE ROW LEVEL SECURITY`. Therefore, application traffic must never connect as the `moducraft` admin role.
- **Tenant Isolation:** Enforced via RLS across `organizations`, `projects`, `organization_memberships`, `audit_events`, and `app_users`.
- **Privilege Separation:** Direct mutation (`INSERT`, `UPDATE`, `DELETE`) on `app_users`, `organizations`, `organization_memberships`, and `audit_events` is denied at the table privilege level to `moducraft_runtime`.
- **Immutability of Ownership & Tenant Fields:** Runtime role is granted column-level `UPDATE` on `projects` only for `name`, `slug`, and `description`. Attempts to alter `organization_id`, `created_by`, or `id` fail with column permission errors.
- **Audit Tampering:** `audit_events` is append-only via trusted administrative/system workflows. The runtime role has only `SELECT` privilege on records belonging to its authorized tenant.
- **Identity Linking:** Email is explicitly treated as mutable user metadata; the canonical immutable identity anchor is `(identity_issuer, identity_subject)`.

## 2. Identity Context Boundary & Spoofing Assessment (`app.user_id`)
During Phase 2 & 3 verification, execution of:
```sql
SELECT set_config('app.user_id', '<target-user-uuid>', true);
```
was explicitly tested under `moducraft_runtime`.

### Critical Finding:
`set_config('app.user_id', ..., true)` executes successfully under the restricted runtime role without requiring elevated privileges. 

### Security Implications:
1. **Not Cryptographic Identity Proof:** `app.user_id` is a transaction-local state mechanism designed solely to pass context from a trusted application layer down into PostgreSQL RLS policies. It provides **zero authentication or proof of identity** on its own.
2. **Threat Vector — SQL Injection (SQLi):** If an application query contains an unparameterized SQL injection flaw, an attacker could inject `SELECT set_config('app.user_id', '<victim-uuid>', true)` and subsequently impersonate any user or tenant across all RLS-protected queries in that transaction.
3. **Threat Vector — Untrusted Direct DB Connections:** Any client connecting directly with the `moducraft_runtime` credentials can forge any user UUID at will.
4. **Threat Vector — Connection Pool State Leakage:** If the backend uses persistent database connections and sets session-level configuration (`is_local = false`), a subsequent request reusing the same connection could inherit the previous user's identity context if an unhandled error interrupts session reset.

## 3. Phase 3B Audit SECURITY DEFINER Boundary Analysis
In Phase 3B, `public.moducraft_record_audit_event(...)` was introduced as a constrained `SECURITY DEFINER` function with pinned `search_path = 'pg_catalog', 'pg_temp'`.

### Trust Boundary & Controls:
1. **Actor Derivation:** The actor is derived exclusively from `public.moducraft_current_user_id()`. The caller cannot pass an arbitrary `actor_user_id` to forge someone else's action.
2. **Mandatory Organization Scope:** `organization_id` is strictly required (`IS NOT NULL`) and verified via `public.moducraft_is_org_member(p_organization_id)`. Callers cannot emit audit events for tenants they do not belong to.
3. **Metadata Sanitization & Key Filtering:** Sensitive attributes (`password`, `secret`, `token`, `apiKey`, `authorization`, `cookie`, `jwt`, `private_key`) are actively rejected at the database function level to prevent credential leakage into logs.
4. **Atomicity Guarantee:** Audits are executed in the caller's transaction. If project mutation fails, the audit write is rolled back, preventing phantom audit records.

## 4. Recommended Production Deployment Hardening
1. **Network Boundary:** PostgreSQL port 5432 must be restricted to internal VPC/private Docker networks; external access must be disabled.
2. **Strict Driver Parameterization:** Continue enforcing static query parameterization so user input cannot escape into SQL fragments.
3. **PgBouncer / Connection Pooler:** In production environments with PgBouncer in transaction pooling mode, transaction-local configuration (`is_local = true`) is strictly required to prevent context leakage across pooling clients.
