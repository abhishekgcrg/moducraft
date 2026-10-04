# ModuCraft Phase 3B — Organization & Project CRUD API Implementation Report

## 1. Overview & Verification Summary

- **Date:** 2026-10-02
- **Environment:** Fastify API (`@moducraft/api`), Node.js, TypeScript, PostgreSQL 17 Docker container (`moducraft-postgres`).
- **Connection Role:** Restricted runtime connection strictly using `moducraft_runtime` (`NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEDB`, `NOCREATEROLE`).
- **Automated Test Results:**
  - **API Test Suite (`pnpm --filter @moducraft/api test`):** **60 / 60 tests passed (7 suites)**, Exit Code: `0`, Duration: ~34s.
  - **Database Authorization Suite (`db/tests/phase2_authorization_test.sql`):** **All 9 test blocks passed**, Exit Code: `0`.
  - **Clean Database Reproducibility (`moducraft_disposable_test`):** **Migrations 0001–0004 applied cleanly and passed authorization tests**, Exit Code: `0`.
  - **TypeScript Typecheck (`pnpm --filter @moducraft/api typecheck`):** **Passed with 0 errors**, Exit Code: `0`.

---

## 2. Architecture & Design Principles

### A. Strict Database Role & Tenant Isolation
- **Application Pool Isolation:** Runtime connection to PostgreSQL is authenticated strictly as `moducraft_runtime`. Administrative superuser credentials (`moducraft`) are prohibited from serving application requests and are rejected at server boot by `assertRestrictedRole(pool)`.
- **Forced Row-Level Security:** PostgreSQL forced RLS is enabled and active on all core tables: `app_users`, `organizations`, `organization_memberships`, `projects`, and `audit_events`.
- **Transaction-Local Identity:** Every authenticated database operation executes within `withAuthenticatedContext(pool, userId, callback)`. Identity context is established via `set_config('app.user_id', $1, true)` where `is_local = true`. The identity setting is cleared automatically upon transaction `COMMIT` or `ROLLBACK`.
- **Cross-Tenant Information Leakage Prevention:** Requests attempting to access nonexistent or foreign-tenant organizations/projects receive HTTP `404 Not Found`, never `403 Forbidden`, preventing tenant enumeration attacks.

### B. Fine-Grained Column Privileges & Automation
- In accordance with migration `0002_project_crud_and_runtime_role.sql`, `moducraft_runtime` possesses column-level write grants:
  - `INSERT (organization_id, name, slug, description, created_by) ON public.projects`
  - `UPDATE (name, slug, description) ON public.projects`
  - `DELETE ON public.projects`
- Client attempts to mutate `id`, `organization_id`, or `created_by` are rejected at the API validation boundary (`400 Validation Error`) and structurally blocked by PostgreSQL column grants.
- `updated_at` timestamp management is strictly managed by database trigger `projects_set_updated_at` firing `moducraft_set_updated_at()`.

### C. Atomic Audit Event Recording & Security Hardening
- Migration `0004_audit_event_recording.sql` defines `public.moducraft_record_audit_event(...)` as a constrained `SECURITY DEFINER` function with pinned `search_path = 'pg_catalog', 'pg_temp'`.
- Direct `INSERT`, `UPDATE`, and `DELETE` on `audit_events` remain denied to `moducraft_runtime`.
- **Hardened Constraints in Function:**
  1. `actor_user_id` is derived strictly from `moducraft_current_user_id()` (cannot be forged by caller).
  2. `organization_id` is strictly mandatory (`IS NOT NULL`) and verified via `moducraft_is_org_member(p_organization_id)`.
  3. Action, resource_type, resource_id, outcome, and metadata shapes are verified.
  4. Metadata is restricted to JSON objects (`jsonb_typeof = 'object'`) and sensitive keys (`password`, `secret`, `token`, `apiKey`, `authorization`, `cookie`, `jwt`, `private_key`) are blocked.
  5. Audit writes commit or roll back atomically with project mutations within the same transaction.

---

## 3. Endpoints & Route Specifications

| Method | Path | Auth Required | Permitted Roles | Description |
| :--- | :--- | :---: | :--- | :--- |
| `GET` | `/api/v1/organizations` | Yes (JWT) | Authenticated Member | Lists all organizations where user has an active membership, returning org details and user's role (`owner`, `admin`, `member`, `viewer`). |
| `GET` | `/api/v1/organizations/:id` | Yes (JWT) | Member of Org | Retrieves organization details with user's role. Returns `404` for non-members to prevent tenant existence probing. |
| `POST` | `/api/v1/projects` | Yes (JWT) | `owner`, `admin`, `member` | Creates a new project in the specified organization. Derives `created_by` from verified JWT identity. Atomically records `project.created` audit event. |
| `GET` | `/api/v1/projects` | Yes (JWT) | Tenant Members | Lists projects accessible under forced RLS. Supports optional `organizationId` filter and pagination (`limit`, `offset`). |
| `GET` | `/api/v1/projects/:id` | Yes (JWT) | Tenant Members | Retrieves project details by UUID. Returns `404` for cross-tenant requests. |
| `PATCH` | `/api/v1/projects/:id` | Yes (JWT) | `owner`, `admin`, `member` | Updates editable fields (`name`, `slug`, `description`). Rejects changes to immutable columns. Records `project.updated` audit event. |
| `DELETE` | `/api/v1/projects/:id` | Yes (JWT) | `owner`, `admin` only | Deletes project. Denies `member` and `viewer` with `403`. Records `project.deleted` audit event prior to deletion. |

---

## 4. Role & Authorization Matrix

| Action | Organization Owner | Organization Admin | Organization Member | Organization Viewer | Cross-Tenant User |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **List Own Organizations** | Allow | Allow | Allow | Allow | Denied (No Visibility) |
| **Get Organization Detail** | Allow | Allow | Allow | Allow | 404 Not Found |
| **Create Project** | Allow | Allow | Allow | 403 Forbidden | 404 Not Found |
| **List Projects** | Allow | Allow | Allow | Allow | Denied (Isolated by RLS) |
| **Get Project Detail** | Allow | Allow | Allow | Allow | 404 Not Found |
| **Update Project** | Allow | Allow | Allow | 403 Forbidden | 404 Not Found |
| **Delete Project** | Allow | Allow | 403 Forbidden | 403 Forbidden | 404 Not Found |

---

## 5. Request & Response Examples

### A. List Organizations
**Request:**
`GET /api/v1/organizations`
`Authorization: Bearer <valid_jwt>`

**Response (200 OK):**
```json
{
  "data": {
    "organizations": [
      {
        "id": "11111111-aaaa-4000-8000-000000000001",
        "name": "Acme Aerospace",
        "slug": "acme-aerospace",
        "createdAt": "2026-10-02T16:00:00.000Z",
        "updatedAt": "2026-10-02T16:00:00.000Z",
        "role": "owner"
      }
    ]
  }
}
```

### B. Create Project
**Request:**
`POST /api/v1/projects`
`Authorization: Bearer <valid_jwt>`
```json
{
  "organizationId": "11111111-aaaa-4000-8000-000000000001",
  "name": "Navigation Subsystem",
  "slug": "nav-subsystem",
  "description": "Avionics and orbital navigation routines."
}
```

**Response (201 Created):**
```json
{
  "data": {
    "project": {
      "id": "e9b5f5fa-7f89-42b3-9e45-8c76b9d6e321",
      "organizationId": "11111111-aaaa-4000-8000-000000000001",
      "name": "Navigation Subsystem",
      "slug": "nav-subsystem",
      "description": "Avionics and orbital navigation routines.",
      "createdBy": "33333333-1111-4000-8000-000000000001",
      "createdAt": "2026-10-02T17:00:00.000Z",
      "updatedAt": "2026-10-02T17:00:00.000Z"
    }
  }
}
```

### C. List Projects with Pagination
**Request:**
`GET /api/v1/projects?organizationId=11111111-aaaa-4000-8000-000000000001&limit=10&offset=0`
`Authorization: Bearer <valid_jwt>`

**Response (200 OK):**
```json
{
  "data": {
    "projects": [
      {
        "id": "e9b5f5fa-7f89-42b3-9e45-8c76b9d6e321",
        "organizationId": "11111111-aaaa-4000-8000-000000000001",
        "name": "Navigation Subsystem",
        "slug": "nav-subsystem",
        "description": "Avionics and orbital navigation routines.",
        "createdBy": "33333333-1111-4000-8000-000000000001",
        "createdAt": "2026-10-02T17:00:00.000Z",
        "updatedAt": "2026-10-02T17:00:00.000Z"
      }
    ],
    "pagination": {
      "total": 1,
      "limit": 10,
      "offset": 0
    }
  }
}
```

### D. Update Project
**Request:**
`PATCH /api/v1/projects/e9b5f5fa-7f89-42b3-9e45-8c76b9d6e321`
`Authorization: Bearer <valid_jwt>`
```json
{
  "name": "Navigation Subsystem v2",
  "description": "Updated flight dynamics."
}
```

**Response (200 OK):**
```json
{
  "data": {
    "project": {
      "id": "e9b5f5fa-7f89-42b3-9e45-8c76b9d6e321",
      "organizationId": "11111111-aaaa-4000-8000-000000000001",
      "name": "Navigation Subsystem v2",
      "slug": "nav-subsystem",
      "description": "Updated flight dynamics.",
      "createdBy": "33333333-1111-4000-8000-000000000001",
      "createdAt": "2026-10-02T17:00:00.000Z",
      "updatedAt": "2026-10-02T17:05:00.000Z"
    }
  }
}
```

### E. Delete Project
**Request:**
`DELETE /api/v1/projects/e9b5f5fa-7f89-42b3-9e45-8c76b9d6e321`
`Authorization: Bearer <valid_jwt>`

**Response (200 OK):**
```json
{
  "data": {
    "success": true,
    "message": "Project deleted successfully."
  }
}
```

---

## 6. Files Created & Modified

| File | Status | Description |
| :--- | :--- | :--- |
| [`db/migrations/0004_audit_event_recording.sql`](file:///g:/ModuCraft/moducraft-foundation/db/migrations/0004_audit_event_recording.sql) | Created & Applied | Secure `SECURITY DEFINER` audit recording function with pinned search path and actor derivation. |
| [`apps/api/package.json`](file:///g:/ModuCraft/moducraft-foundation/apps/api/package.json) | Modified | Added `zod` dependency for schema validation. |
| [`apps/api/src/errors/app-errors.ts`](file:///g:/ModuCraft/moducraft-foundation/apps/api/src/errors/app-errors.ts) | Created | Domain error classes: `AppError`, `ValidationError`, `NotFoundError`, `ForbiddenError`, `ConflictError`. |
| [`apps/api/src/validation/schemas.ts`](file:///g:/ModuCraft/moducraft-foundation/apps/api/src/validation/schemas.ts) | Created | Strict Zod validation schemas for project creation, updates, slug format, and pagination. |
| [`apps/api/src/services/organization.service.ts`](file:///g:/ModuCraft/moducraft-foundation/apps/api/src/services/organization.service.ts) | Created | Service layer for listing user organizations and retrieving details under forced RLS. |
| [`apps/api/src/services/project.service.ts`](file:///g:/ModuCraft/moducraft-foundation/apps/api/src/services/project.service.ts) | Created | Project CRUD service with RBAC enforcement, immutable field protection, and atomic audit logging. |
| [`apps/api/src/routes/organizations.ts`](file:///g:/ModuCraft/moducraft-foundation/apps/api/src/routes/organizations.ts) | Created | Route handlers for `GET /api/v1/organizations` and `GET /api/v1/organizations/:id`. |
| [`apps/api/src/routes/projects.ts`](file:///g:/ModuCraft/moducraft-foundation/apps/api/src/routes/projects.ts) | Created | Route handlers for project CRUD endpoints. |
| [`apps/api/src/app.ts`](file:///g:/ModuCraft/moducraft-foundation/apps/api/src/app.ts) | Modified | Registered organization & project routes, and configured global sanitized error handler. |
| [`apps/api/test/organizations.test.ts`](file:///g:/ModuCraft/moducraft-foundation/apps/api/test/organizations.test.ts) | Created | 7 integration tests covering auth, tenant isolation, role inclusion, and format checks. |
| [`apps/api/test/projects.test.ts`](file:///g:/ModuCraft/moducraft-foundation/apps/api/test/projects.test.ts) | Created | 20 integration tests covering full CRUD, RBAC, slug uniqueness, audit atomicity, and pooling safety. |
| [`docs/phase2-implementation-checklist.md`](file:///g:/ModuCraft/moducraft-foundation/docs/phase2-implementation-checklist.md) | Modified | Updated checklist status to reflect Phase 3B completion. |

---

## 7. Security Findings, Trust Boundaries & Residual Risks

1. **Identity Context Trust Boundary (`set_config`):**
   - Setting `set_config('app.user_id', ..., true)` is performed by the trusted API backend only after validating the cryptographic JWT and resolving the issuer and subject to `app_users.id`.
   - **Residual Risk:** Anyone with direct SQL execution access using the `moducraft_runtime` connection credentials can execute `set_config('app.user_id', ...)` manually. The database role cannot verify how the caller determined the user ID; identity guarantees rely entirely on the API gateway and backend enforcement.
2. **Audit Tamper-Resistance:**
   - `moducraft_runtime` has no direct `INSERT`, `UPDATE`, or `DELETE` rights on `audit_events`.
   - Audit writes must route through `public.moducraft_record_audit_event(...)`, which enforces that `actor_user_id` matches `moducraft_current_user_id()`. Direct tampering with historical audit logs is impossible through runtime credentials.
3. **Information Leakage Prevention:**
   - Cross-tenant requests to organizations or projects return `404 Not Found` (never `403 Forbidden`).
   - Global error handler sanitizes internal database errors and stack traces, ensuring zero SQL or credential leakage in production responses.
4. **Future Work:**
   - Organization creation, membership invitation, and role modification endpoints are deferred to subsequent phases as the current scope specifies read-only organization access.

---

## 8. Exact Local Verification Commands

### Execute Migrations
```powershell
Get-Content g:\ModuCraft\moducraft-foundation\db\migrations\0001_identity_tenant_core.sql | docker exec -i moducraft-postgres psql -U moducraft -d moducraft -v ON_ERROR_STOP=1
Get-Content g:\ModuCraft\moducraft-foundation\db\migrations\0002_project_crud_and_runtime_role.sql | docker exec -i moducraft-postgres psql -U moducraft -d moducraft -v ON_ERROR_STOP=1
Get-Content g:\ModuCraft\moducraft-foundation\db\migrations\0003_runtime_login_role.sql | docker exec -i moducraft-postgres psql -U moducraft -d moducraft -v ON_ERROR_STOP=1
Get-Content g:\ModuCraft\moducraft-foundation\db\migrations\0004_audit_event_recording.sql | docker exec -i moducraft-postgres psql -U moducraft -d moducraft -v ON_ERROR_STOP=1
```

### Run Phase 2 Regression Tests
```powershell
Get-Content g:\ModuCraft\moducraft-foundation\db\tests\phase2_authorization_test.sql | docker exec -i moducraft-postgres psql -U moducraft -d moducraft -v ON_ERROR_STOP=1
```

### Run API Automated Test Suite
```powershell
pnpm --filter @moducraft/api test
```

### Run API Typecheck
```powershell
pnpm --filter @moducraft/api typecheck
```
