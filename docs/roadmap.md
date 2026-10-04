# Zero-to-One Roadmap

## Phase 1 — Foundation
- [x] Establish repository workspace and starter UI/API shells
- [x] Document architecture boundaries and provider interfaces
- [x] Establish security and open-source review gates
- [ ] Confirm local developer environment and run initial smoke tests
- [ ] Add CI, formatting, linting, test coverage, and dependency/SBOM checks

## Phase 2 — Identity and tenant-safe core
- Organizations, users, projects, membership, roles, session lifecycle
- Tenant isolation tests and audit events
- Database migrations and secret/provider settings model

## Phase 3 — Agent workflow engine
- Orchestrator and typed agent task contracts
- Durable workflow state, event history, retries, cancellation, approvals
- Model-provider adapters and usage/limits
- Agent tools allowlist and isolated execution boundary

## Phase 4 — IDE MVP
- Chat-to-plan flow, project workspace, file tree/editor, task status
- Generate patch -> review -> test -> approve workflow
- Never silently overwrite user work

## Phase 5 — Cloud MVP
- Project resource inventory, database/storage provisioning adapters
- Build/deploy pipeline, logs, environment variables via secret manager
- Rollback and deployment approval

## Phase 6 — Marketplace and hardening
- Signed/verified package metadata, license manifest, security review
- Publishing approval and versioning
- Restore drills, penetration testing, quotas, operational runbooks

## Definition of done
A feature is not complete until it has implementation, tests, documentation, security considerations, observable failure handling, and acceptance evidence.
