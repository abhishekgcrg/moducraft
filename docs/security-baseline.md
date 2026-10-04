# Security Baseline — Required Before Production

- Enforce tenant isolation in every data-access path; test cross-tenant denial.
- Deny by default; least privilege for users, agents, workers, and service accounts.
- Store secrets in a dedicated secret-management interface; encrypt at rest and redact from logs.
- Never execute model-generated code on the API host. Use disposable, resource-limited sandboxes with network egress disabled by default.
- Require explicit approval for destructive actions, public exposure, production deployment, and permission changes.
- Validate uploads, archive extraction paths, webhooks, URLs, and tool arguments.
- Add rate limits, quotas, timeouts, bounded retries, cancellation, and idempotency for mutations.
- Keep tamper-resistant audit events for sensitive actions.
- Pin dependencies where appropriate; scan direct/transitive dependencies and produce an SBOM.
- Review licenses, notices, provenance, trademarks, and patent terms for every adopted project and bundled asset.
- Add backup restore tests, incident response steps, and security regression tests before production.
- Do not claim production readiness until threat modeling and independent review are completed.
