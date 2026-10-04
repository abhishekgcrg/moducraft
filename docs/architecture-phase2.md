# Phase 2 Architecture Decisions

- Start with modular monolith; do not add microservices without evidence.
- PostgreSQL is the canonical store for tenant, membership, project, and audit metadata.
- Keep identity provider behind an internal adapter. Keycloak is a candidate, not legally or security cleared here.
- Keep user-facing IDs separate from provider-specific claims; canonical identity key is verified `(issuer, subject)`.
- RLS is defense in depth and does not replace API authorization.
- Production needs migration versioning, backup/restore tests, secret management, CI and independent security review.
