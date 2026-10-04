# Phase 4D.6 — Migration Integrity, Recovery Authorization & Sensitive Journal Audit Report

**Date:** 2026-10-03  
**Status:** Audit Completed — Remediation & Hardening Implemented  
**Scope:** Phase 4D.6 Migration Tracking, Schema Drift, Forced RLS, Runtime Privileges, Administrative Recovery Authorization, Divergence Safeguards, and Sensitive Data Redaction.  
**Production Readiness Status:** **NOT Production Ready** (Phase 4 development milestone; MicroVM isolation, automated schema migration tracking tool, and cross-node distributed consensus remain prerequisites).

---

## 1. Executive Summary & Audit Classification

During Phase 4D.6, ModuCraft conducted an adversarial security, integrity, and authorization audit covering the durable patch recovery mechanism introduced in Phase 4D.5, migration replay pipelines, primary database drift, and sensitive data leakage risks. 

All adversarial tests were conducted against real PostgreSQL instances (`moducraft` primary and transient disposable test databases) using the unprivileged `moducraft_runtime` role and `moducraft` administrative credentials.

### Summary of Audit Findings & Status

| ID | Category | Severity | Description | Status |
| :--- | :--- | :--- | :--- | :--- |
| **SEC-4D6-01** | Migration Infrastructure | **Medium** | Absence of formal migration tracking table (`schema_migrations`). Primary DB relied on raw SQL execution logs. | **Documented & Replay Verified** (Verified on disposable DB; forward tracking table roadmap defined). |
| **SEC-4D6-02** | Data Loss Risk | **High** | Administrative recovery (`restore_baseline` / `commit_patch`) would overwrite uncommitted user workspace edits without confirmation. | **Resolved** (Divergence check added; requires explicit `force: true` to overwrite user edits). |
| **SEC-4D6-03** | Information Disclosure | **Medium** | Unredacted exception strings and recovery reasons could leak bearer tokens, API keys, and connection strings into `recovery_details` JSONB. | **Resolved** (Integrated `redactSensitiveData` for errors, rollbacks, and recovery justifications). |
| **SEC-4D6-04** | Resource Exhaustion (DoS) | **Medium** | Baseline state snapshots accepted arbitrarily large file contents into JSONB columns, posing DB memory and payload bloat risks. | **Resolved** (Enforced `MAX_BASELINE_FILE_SIZE_BYTES = 1048576` [1 MB limit] on all baseline reads). |
| **SEC-4D6-05** | Integrity / Tampering | **High** | Journal recovery lacked explicit assertion that `journal.targetContentHash` matches artifact `contentHash`. | **Resolved** (Enforced tamper-evident content hash binding in `adminRecoverWorkspace`). |
| **SEC-4D6-06** | Privilege Escalation | **Critical** | Verification that `moducraft_runtime` cannot bypass RLS or delete journal audit trails. | **Verified Secure** (`relforcerowsecurity = t`, 0 DELETE grants to runtime role). |

---

## 2. Primary Database Safety & Zero-Drift Audit

### 2.1 Database Preservation Policy
Throughout Phase 4D.6, the primary `moducraft` database was **never dropped, truncated, recreated, or altered with speculative manual schema changes**. All schema verification queries ran read-only.

### 2.2 Live Schema & Constraint Audit
Inspection of `public.patch_application_journals` on the primary database confirmed exact alignment with `db/migrations/0010_durable_patch_journal.sql`:
- **Columns (14):** `id`, `organization_id`, `project_id`, `task_id`, `patch_artifact_id`, `approval_id`, `target_content_hash`, `status`, `baseline_state`, `applied_files`, `recovery_details`, `created_by`, `created_at`, `updated_at`.
- **Primary & Foreign Key Constraints (4):**
  - `patch_application_journals_pkey` on `id`
  - `patch_journals_org_fk` -> `organizations(id)`
  - `patch_journals_project_fk` -> `projects(id)`
  - `patch_journals_task_fk` -> `agent_tasks(id)`
- **Check Constraints (2):**
  - `patch_journals_status_check`: `status IN ('applying', 'applied', 'rolled_back', 'recovery_required', 'recovered')`
  - `patch_journals_content_hash_check`: `target_content_hash ~ '^[a-f0-9]{64}$'`
- **Indexes (4):** Primary key, `idx_patch_journals_task_status`, `idx_patch_journals_project_status`, `idx_patch_journals_org`.
- **Row-Level Security & Grants:**
  - `relrowsecurity = true`
  - `relforcerowsecurity = true` (enforced unconditionally even for table owners when acting as runtime session)
  - Grants to `moducraft_runtime`: `SELECT, INSERT, UPDATE`
  - Privilege check: **No `DELETE` grant** on `patch_application_journals` or `audit_events`.

### 2.3 Migration Tracking Analysis
- **Finding:** ModuCraft historically used direct sequential `psql` pipelines rather than a dedicated migration table (`schema_migrations` / Knex / Flyway).
- **Drift Assessment:** Zero drift was detected between migration files `0001` through `0010` and the live schema. All 16 tables in `public` match their respective migration definitions.
- **Safety Decision:** To uphold strict database safety, no synthetic `schema_migrations` table was injected directly into production during this test phase; a disposable database was used to prove migration replay and atomicity.

---

## 3. Disposable Database Migration Replay & DDL Atomicity

To safely validate migration reproducibility and transactional atomicity without endangering the primary database, test suite `apps/api/test/migration-recovery-audit.test.ts` provisioned disposable databases (`moducraft_disposable_migration_audit` and `moducraft_disposable_fault_test`) via the postgres superuser.

### 3.1 Sequential Replay (Migrations 0001 through 0010)
- **Execution:** Migrations `0001_core_schema.sql` through `0010_durable_patch_journal.sql` were executed sequentially against a blank database.
- **Result:** Successfully created all 16 public tables:
  1. `organizations`
  2. `users`
  3. `organization_members`
  4. `projects`
  5. `agent_tasks`
  6. `agent_task_steps`
  7. `agent_artifacts`
  8. `agent_approvals`
  9. `agent_sessions`
  10. `audit_events`
  11. `agent_tools`
  12. `agent_task_tool_authorizations`
  13. `agent_memories`
  14. `project_dirty_flags`
  15. `task_revisions`
  16. `patch_application_journals`
- **RLS Verification:** Confirmed that `relrowsecurity = true` and `relforcerowsecurity = true` are properly enabled on `patch_application_journals` upon creation.
- **Idempotency:** Re-executing `0010_durable_patch_journal.sql` against the fully migrated schema completed with exit code 0 (`CREATE TABLE IF NOT EXISTS`, idempotent index/constraint/grant definitions).

### 3.2 Transactional DDL Failure Atomicity
- **Fault Injection:** A multi-statement migration wrapped in `BEGIN ... COMMIT` with an intentional syntax failure in statement 2 was executed.
- **Result:** PostgreSQL's transactional DDL cleanly aborted the entire transaction. Zero orphan tables or half-applied catalog objects were retained.

---

## 4. Forced Row-Level Security & Cross-Tenant Recovery Isolation

### 4.1 Tenant Boundary Isolation
Adversarial tests verified isolation using distinct organizations (`Org Alpha` and `Org Beta`) under the `moducraft_runtime` connection pool:
- **Direct Queries:** An Org Beta user querying `patch_application_journals` with `app.current_organization_id = 'org_beta'` receives 0 rows when attempting to select Org Alpha's journals.
- **Service API Calls:** Org Beta users attempting to inspect or recover an Org Alpha journal receive `NotFoundError ("Patch application journal not found in tenant")`.

### 4.2 Role-Based Authorization
- **Non-Admin Execution:** Regular organization members attempting to invoke `adminRecoverWorkspace` are rejected with `ForbiddenError ("Administrative privileges required to recover workspace")`.
- **Cross-Organization Admin Execution:** An admin of Org Beta attempting to recover an Org Alpha workspace receives `NotFoundError` due to the RLS filter failing closed.

---

## 5. Administrative Recovery Safeguards & Workspace Integrity

### 5.1 Uncommitted User Edit Protection (Divergence Guard)
When an administrator executes `adminRecoverWorkspace` (`restore_baseline` or `commit_patch`), the workspace runner checks the current hash of all target files:
- If a target file matches the baseline snapshot, it proceeds.
- If a target file matches the expected patch result, it proceeds.
- **If a target file has been modified by a user after the crash and differs from both baseline and target:**
  - **Default Behavior:** Throws `ConflictError ("Refusing to overwrite divergent user edits without explicit force: true.")`.
  - **Force Flag:** If `force: true` is explicitly provided in `AdminRecoverInput`, the administrator acknowledges data loss and the workspace is restored.

### 5.2 Immutable Artifact Hash Binding
`adminRecoverWorkspace` retrieves the patch proposal artifact and asserts that `artifact.contentHash === journal.targetContentHash`. Any detected tampering or mismatched proposal fails closed with `ValidationError`.

### 5.3 Concurrency & Row-Locking Serialization
Concurrent recovery requests against the same journal row execute `SELECT ... FOR UPDATE`. The first transaction acquires the row and transitions status to `recovered`. The second transaction awakens, discovers status is no longer `recovery_required`, and aborts with `ConflictError ("Recovery not required")`.

---

## 6. Sensitive Data Redaction & Unbounded Payload Safeguards

### 6.1 Redaction of Error Details & Recovery Reasons
In `apps/api/src/modules/workflows/patch.service.ts`:
- Commit errors from runner writes and compensating rollback errors are passed through `redactSensitiveData(message).text` before insertion into `recovery_details` and `audit_events`.
- Admin-supplied recovery justification strings are sanitized to redact Anthropic API keys (`sk-ant-...`), OpenAI keys (`sk-live-...`), JWT tokens, and database connection strings (`postgresql://...`).

### 6.2 Bounded Baseline Snapshots
- Constant `MAX_BASELINE_FILE_SIZE_BYTES = 1048576` (1 MB) is enforced when reading existing workspace files during diff staging and baseline generation.
- Attempting to patch or baseline a file larger than 1 MB triggers `ValidationError ("File '...' exceeds maximum supported baseline snapshot size (1048576 bytes).")`, preventing memory exhaustion and unbounded JSONB document growth.

---

## 7. Verification Evidence & Test Results

All verification commands executed successfully on the real test environment:

| Test Command | Test Focus | Pass / Total | Exit Code | Duration |
| :--- | :--- | :--- | :--- | :--- |
| `pnpm --filter @moducraft/api exec tsx --test test/migration-recovery-audit.test.ts` | Disposable DB Replay, Cross-Tenant RLS, Divergence Protection, Redaction, Bounds | **17 / 17** | **0** | 3.3s |
| `pnpm --filter @moducraft/api exec tsx --test test/crash-consistency.test.ts` | Multi-phase Durable Patch Journal, Boundary Faults, Process Kill | **17 / 17** | **0** | 2.6s |
| `pnpm --filter @moducraft/api exec tsx --test test/failure-recovery.test.ts` | Compensating Rollback, Expired Approvals, Docker Isolation | **22 / 22** | **0** | 13.4s |
| `pnpm --filter @moducraft/api exec tsx --test test/runner.test.ts` | Isolated Docker Runner, Network None, Read-Only FS, User 1000 | **30 / 30** | **0** | 20.0s |
| `pnpm typecheck` | Monorepo TypeScript static analysis across all workspaces | **Clean** | **0** | ~30s |
| `pnpm build` | Full production build (`apps/api` tsc + `apps/web` Next.js 15) | **Clean** | **0** | ~45s |

**Total Phase 4D Test Pass Rate: 86 / 86 tests passing (100%).**

---

## 8. Limitations & Unresolved Risks

1. **Host-Level Container Engine vs MicroVM:** The current implementation executes on Docker with hardened security flags (`--network none`, `--read-only`, non-root `1000:1000`, `MODUCRAFT_REQUIRE_MICROVM=false`). Host-level kernel isolation remains dependent on the underlying OS kernel. MicroVM execution (e.g. Firecracker / gVisor) is required for multi-tenant production hosting.
2. **Dedicated Migration Tracking Tooling:** While migrations 0001–0010 are idempotent and verified on disposable databases, a production deployment should incorporate a formal migration manager with checksum locking (e.g., node-pg-migrate or Flyway) to prevent out-of-order schema drift across distributed instances.
3. **Workspace Filesystem Clustering:** The current runner manages isolated workspaces on local volume mounts. Distributed, multi-node deployments will require a distributed storage layer or network-attached shared volume with file locking.
