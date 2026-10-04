# Phase 3A Implementation Report — Secure Backend Identity and Database Integration

## 1. Overview & Verification Status
- **Date:** 2026-10-02
- **Environment:** Fastify API (`@moducraft/api`), Node.js, TypeScript, PostgreSQL 17 Docker container (`moducraft-postgres`).
- **Connection Role:** `moducraft_runtime` (Restricted: `NOSUPERUSER`, `NOBYPASSRLS`, `NOLOGIN` updated to `LOGIN` with least privilege).
- **Automated Test Results:**
  - API Test Suite (`apps/api/test/**/*.test.ts`): **21 / 21 tests passed (4 suites)**, Exit Code: `0`.
  - Database Authorization Suite (`db/tests/phase2_authorization_test.sql`): **All 9 test blocks passed**, Exit Code: `0`.
  - Workspace Suite (`pnpm test`): **Passed cleanly**, Exit Code: `0`.

---

## 2. Architecture Changes

### A. Database Connection & Role Privilege Separation
- **Separation of Concerns:** The administrative role `moducraft` (superuser) is strictly prohibited from serving runtime API requests.
- **Fail-Fast Privilege Guard:** The connection pool startup runs `assertRestrictedRole()`. If an application is misconfigured with superuser or `BYPASSRLS` credentials, startup is aborted with a `PrivilegedConnectionError`.
- **Direct Runtime Connection:** Migration `0003_runtime_login_role.sql` enabled `LOGIN` directly on `moducraft_runtime` without granting any elevated privileges (`NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEDB`, `NOCREATEROLE` remain enforced).

### B. Transaction-Scoped Identity Context
- **Helper:** `withAuthenticatedContext<T>(pool, userId, callback)` encapsulates every authenticated database interaction.
- **Transaction-Local Isolation:** Executes `SELECT set_config('app.user_id', $1, true)` with `is_local = true`. This parameterizes the user context and guarantees that the setting is cleared by PostgreSQL as soon as `COMMIT` or `ROLLBACK` executes.
- **Leakage Prevention:** Handler callbacks are granted access only through a `ScopedTransaction` object bound to that dedicated client. No unscoped connection calls are possible.
- **Connection Pool Safety:** Exhaustively tested on a pool restricted to 1 connection. Directly inspected connections immediately after transaction completion confirmed `current_setting('app.user_id', true)` is `NULL`.

### C. Authentication Boundary & Fail-Closed Design
- **Fail-Closed Security:** In the absence of identity provider configuration (`AUTH_ISSUER`, `AUTH_JWKS_URI`), the API refuses all access to protected endpoints, returning HTTP `401 AUTH_NOT_CONFIGURED`.
- **Zero-Trust Identity Inputs:** No IDs from headers, body, or path are trusted. Only tokens with verified cryptographic signatures (via `jose` using remote JWKS or configured key) are accepted.
- **Identity Resolution Helper:** Created `SECURITY DEFINER` function `moducraft_resolve_identity(p_issuer, p_subject)` with pinned `search_path = 'pg_catalog', 'pg_temp'`. This resolves verified claims to internal `app_users.id` without requiring `app_users` RLS policies to be weakened.
- **Provisioning Enforcement:** If a token is cryptographically valid but the user has not been provisioned in `app_users`, the request is rejected with `401 USER_NOT_PROVISIONED`.

### D. API Foundation Endpoints
- `GET /health`: Liveness probe returning `200 { "status": "ok", "service": "moducraft-api" }`.
- `GET /ready`: Readiness probe verifying database connectivity via `SELECT 1` on the restricted pool. Returns `200` or `503` without leaking database connection details.
- `GET /api/v1/identity/me`: Protected endpoint returning internal user metadata strictly evaluated within `withAuthenticatedContext` under forced RLS.

---

## 3. Files Created or Modified

| File | Status | Description |
| :--- | :--- | :--- |
| [`apps/api/package.json`](file:///g:/ModuCraft/moducraft-foundation/apps/api/package.json) | Modified | Added `pg`, `jose`, `@types/pg` dependencies; configured `tsx --test`. |
| [`apps/api/src/config/env.ts`](file:///g:/ModuCraft/moducraft-foundation/apps/api/src/config/env.ts) | Created | Environment configuration loader with safe restricted defaults. |
| [`apps/api/src/db/pool.ts`](file:///g:/ModuCraft/moducraft-foundation/apps/api/src/db/pool.ts) | Created | Connection pool factory with `assertRestrictedRole` enforcement. |
| [`apps/api/src/db/transaction.ts`](file:///g:/ModuCraft/moducraft-foundation/apps/api/src/db/transaction.ts) | Created | `withAuthenticatedContext` transaction helper. |
| [`apps/api/src/auth/types.ts`](file:///g:/ModuCraft/moducraft-foundation/apps/api/src/auth/types.ts) | Created | TypeScript interfaces and custom `AuthenticationError` types. |
| [`apps/api/src/auth/verifier.ts`](file:///g:/ModuCraft/moducraft-foundation/apps/api/src/auth/verifier.ts) | Created | Cryptographic JWT verifier using `jose` with strict claims validation. |
| [`apps/api/src/auth/middleware.ts`](file:///g:/ModuCraft/moducraft-foundation/apps/api/src/auth/middleware.ts) | Created | Fastify `preHandler` hook enforcing token verification and DB identity resolution. |
| [`apps/api/src/routes/health.ts`](file:///g:/ModuCraft/moducraft-foundation/apps/api/src/routes/health.ts) | Created | `/health` and `/ready` endpoints. |
| [`apps/api/src/routes/identity.ts`](file:///g:/ModuCraft/moducraft-foundation/apps/api/src/routes/identity.ts) | Created | Protected `GET /api/v1/identity/me` endpoint. |
| [`apps/api/src/app.ts`](file:///g:/ModuCraft/moducraft-foundation/apps/api/src/app.ts) | Created | Fastify application factory with secrets redaction. |
| [`apps/api/src/server.ts`](file:///g:/ModuCraft/moducraft-foundation/apps/api/src/server.ts) | Modified | Server boot script utilizing `buildApp()`. |
| [`apps/api/test/db-pool.test.ts`](file:///g:/ModuCraft/moducraft-foundation/apps/api/test/db-pool.test.ts) | Created | Automated tests for role attributes and privilege denial. |
| [`apps/api/test/transaction.test.ts`](file:///g:/ModuCraft/moducraft-foundation/apps/api/test/transaction.test.ts) | Created | Automated tests for transaction-scoped context, rollback, and pooling leakage. |
| [`apps/api/test/auth-verifier.test.ts`](file:///g:/ModuCraft/moducraft-foundation/apps/api/test/auth-verifier.test.ts) | Created | Automated tests for fail-closed JWT signature, expiration, issuer, audience. |
| [`apps/api/test/api-identity.test.ts`](file:///g:/ModuCraft/moducraft-foundation/apps/api/test/api-identity.test.ts) | Created | Integration tests for Fastify endpoints and cross-user isolation. |
| [`db/migrations/0003_runtime_login_role.sql`](file:///g:/ModuCraft/moducraft-foundation/db/migrations/0003_runtime_login_role.sql) | Created | Versioned migration enabling `LOGIN` and `moducraft_resolve_identity`. |
| [`.env.example`](file:///g:/ModuCraft/moducraft-foundation/.env.example) | Modified | Updated with restricted runtime connection and auth variable templates. |

---

## 4. Environment Variables Required

| Variable | Required | Default / Example | Purpose |
| :--- | :---: | :--- | :--- |
| `NODE_ENV` | Optional | `development` | Runtime environment mode. |
| `API_PORT` | Optional | `4000` | Port for Fastify HTTP server. |
| `API_HOST` | Optional | `127.0.0.1` | Network interface to bind. |
| `DATABASE_URL` | **Required** | `postgresql://moducraft_runtime:...@127.0.0.1:5432/moducraft` | Must use the restricted runtime role (`moducraft_runtime`). Application crashes on boot if connected as superuser. |
| `AUTH_ISSUER` | Required for Auth | `https://auth.example.com/realms/moducraft` | Expected OIDC issuer claim (`iss`). |
| `AUTH_AUDIENCE` | Required for Auth | `moducraft-api` | Expected target audience claim (`aud`). |
| `AUTH_JWKS_URI` | Required for OIDC | `https://auth.example.com/.../certs` | Remote JWKS endpoint for signature verification and public key rotation. |
| `AUTH_PUBLIC_KEY` | Optional | PEM format string | Static asymmetric public key (alternative to JWKS). |
| `AUTH_SECRET` | Optional (Dev/Test) | Min 32-character string | Symmetric HMAC secret for local testing. |

---

## 5. How to Run Migrations and Tests

### Run Migrations:
```powershell
Get-Content g:\ModuCraft\moducraft-foundation\db\migrations\0001_identity_tenant_core.sql | docker exec -i moducraft-postgres psql -U moducraft -d moducraft -v ON_ERROR_STOP=1
Get-Content g:\ModuCraft\moducraft-foundation\db\migrations\0002_project_crud_and_runtime_role.sql | docker exec -i moducraft-postgres psql -U moducraft -d moducraft -v ON_ERROR_STOP=1
Get-Content g:\ModuCraft\moducraft-foundation\db\migrations\0003_runtime_login_role.sql | docker exec -i moducraft-postgres psql -U moducraft -d moducraft -v ON_ERROR_STOP=1
```

### Run Database Authorization Test Suite:
```powershell
Get-Content g:\ModuCraft\moducraft-foundation\db\tests\phase2_authorization_test.sql | docker exec -i moducraft-postgres psql -U moducraft -d moducraft -v ON_ERROR_STOP=1
```

### Run API Automated Test Suite:
```powershell
pnpm --filter @moducraft/api test
```

### Run Full Workspace Test Suite:
```powershell
pnpm test
```

---

## 6. Authentication Provider Configuration Still Required
Before deploying protected application endpoints in staging/production, the following external identity provider items must be configured:
1. **OIDC Provider Selection:** Deploy Keycloak, Auth0, or equivalent OIDC identity provider.
2. **Client Scope & Audience:** Register `moducraft-api` as an authorized audience in access tokens.
3. **JWKS Key Rotation:** Set `AUTH_JWKS_URI` pointing to the provider's standard `.well-known/jwks.json` endpoint.
4. **User Provisioning Workflow:** Implement JIT (Just-In-Time) provisioning or an administrative user synchronization workflow to populate `app_users` with matching `(identity_issuer, identity_subject)` records before user first login.

---

## 7. Identity Spoofing & Connection Pooling Risks

### Trust Boundary Analysis:
- `SELECT set_config('app.user_id', ..., true)` is executed by the API on behalf of the user.
- **SQL Injection Risk:** If any future API endpoint introduces dynamic SQL concatenation rather than parameterized queries, an attacker could invoke `set_config` and spoof identity. Parameterized queries remain mandatory for all queries.
- **Direct Database Client Risk:** Any actor possessing raw network access and `moducraft_runtime` credentials can connect to PostgreSQL and set arbitrary user IDs. Database network ingress must remain strictly isolated inside the container/VPC network.
- **Connection Pooling State Safety:** Verified that `is_local = true` prevents cross-request context leakage. Session-level settings (`is_local = false`) must never be used.

---

## 8. Exact Next Action for the Developer
Proceed to **Phase 3B: Organization & Project CRUD API Implementation**:
1. Implement organization retrieval and membership role checks in API service layer.
2. Implement project CRUD endpoints (`POST /api/v1/projects`, `GET /api/v1/projects`, `PATCH /api/v1/projects/:id`, `DELETE /api/v1/projects/:id`) routing through `withAuthenticatedContext`.
3. Add structured audit event generation within the same transaction for sensitive mutations.
