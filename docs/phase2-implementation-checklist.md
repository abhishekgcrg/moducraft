# Phase 2 & Phase 3 Implementation Checklist

- [x] User identity mapping by verified issuer + subject
- [x] Organizations, memberships, projects, audit event schema
- [x] RLS enabled and forced on core tables
- [x] Write operations denied by default until API policies exist
- [x] Apply migration locally and review output
- [x] Run isolation tests as a non-owner role with `NOBYPASSRLS`
- [x] Select/review identity provider integration (OIDC/JWKS via `jose` fail-closed)
- [x] Verify token issuer, audience, signature, expiry, and key rotation
- [x] Map verified identity to `app_users.id`; never trust IDs from request bodies
- [x] Set `app.user_id` transaction-locally inside request transaction
- [x] Implement org/project CRUD with role checks and audit logging
- [x] Test owner/admin/member/viewer permissions and cross-tenant denial
- [x] Add input validation (Zod schemas with strict validation, slug regex, uuid checks)
- [ ] Add rate limits, migration rollback strategy, and CI pipeline

Do not deploy publicly until unchecked tasks and security hardening are complete.
