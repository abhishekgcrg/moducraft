# ModuCraft Phase 4A — AI Agent Orchestrator Security Audit

## 1. Executive Summary & Assessment

An adversarial security audit of the completed ModuCraft Phase 4A AI Agent Orchestrator was performed on 2026-10-02. The audit evaluated SQL migrations, database privileges, row-level security (RLS) enforcement, state machine transitions, concurrency control, input validation schemas, execution sandboxing, and recovery mechanisms.

### Final Readiness Assessment: **GO FOR PHASE 4B** (Conditional on documented boundaries)
- **Status:** All identified High and Medium severity security vulnerabilities were verified, remediated, regression-tested, and verified on disposable and primary test environments.
- **Automated Test Suite Status:** **74 / 74 tests passing (21 suites)** across monorepo workspaces.
- **Database Authorization Status:** All 9 Phase 2 authorization test blocks and all adversarial security checks passed with Exit Code 0.
- **Primary Database Integrity:** The primary database (`moducraft`) was preserved throughout; all destructive attacks and migration experiments were executed exclusively against disposable databases (`moducraft_disposable_audit`).

---

## 2. Findings Matrix

| Finding ID | Severity | Category | Title | Status |
| :--- | :---: | :---: | :--- | :---: |
| **SEC-4A-001** | **HIGH** | Database RLS | `agent_task_events` RLS INSERT Policy Permitted Actor User ID Impersonation | **RESOLVED** |
| **SEC-4A-002** | **MEDIUM** | API & Concurrency | `POST /api/v1/agent-tasks/recover` Lacked Batch Limits (Unbounded Row Locking DoS) | **RESOLVED** |
| **SEC-4A-003** | **MEDIUM** | Input Validation | Title Length Validation Mismatch Between Zod Schema (255) and Database CHECK (200) | **RESOLVED** |
| **SEC-4A-004** | **LOW** | Information Safety | Potential Credential Leakage in Lifecycle Event Metadata | **RESOLVED** |
| **SEC-4A-005** | **INFORMATIONAL** | Trust Boundary | Direct Column Grants for Runtime Role vs Application Validation Layer | **DOCUMENTED** |

---

## 3. Detailed Vulnerability Analyses & Remediations

### Finding SEC-4A-001: Event Actor Spoofing via Unconstrained RLS INSERT Policy
- **Severity:** **HIGH**
- **Affected File:** `db/migrations/0005_agent_orchestrator.sql` (Line 156–161)
- **Vulnerability Description:**
  In migration `0005_agent_orchestrator.sql`, the policy `agent_task_events_insert_authorized` checked only organization membership role:
  ```sql
  CREATE POLICY agent_task_events_insert_authorized ON public.agent_task_events FOR INSERT
      TO moducraft_runtime
      WITH CHECK (
          moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text, 'member'::text])
      );
  ```
  Unlike `agent_tasks_insert_authorized` (which enforces `created_by = moducraft_current_user_id()`), `agent_task_events` did not verify `actor_user_id`. An authenticated member could insert lifecycle events with an arbitrary `actor_user_id` (e.g. an admin or cross-tenant user ID), forging audit trails and event histories.
- **Reproducible Evidence:**
  Direct SQL test on disposable database:
  ```sql
  -- Authenticated as User A1
  INSERT INTO public.agent_task_events (
      task_id, organization_id, step_id, event_type, actor_user_id, metadata
  ) VALUES (
      'a3333333-0000-4000-8000-000000000001',
      'a1111111-0000-4000-8000-000000000001',
      'a4444444-0000-4000-8000-000000000001',
      'forged.event',
      'b0000000-0000-4000-8000-000000000001', -- Spoofed actor
      '{}'::jsonb
  );
  -- SUCCEEDED prior to remediation!
  ```
- **Remediation Applied:**
  Updated the RLS policy in `0005_agent_orchestrator.sql` and the database to enforce that `actor_user_id` is either NULL (system event) or matches `moducraft_current_user_id()`:
  ```sql
  DROP POLICY IF EXISTS agent_task_events_insert_authorized ON public.agent_task_events;
  CREATE POLICY agent_task_events_insert_authorized ON public.agent_task_events FOR INSERT
      TO moducraft_runtime
      WITH CHECK (
          moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text, 'member'::text])
          AND (actor_user_id IS NULL OR actor_user_id = moducraft_current_user_id())
      );
  ```
- **Post-Fix Verification:** Direct insert with spoofed actor now produces:
  `ERROR: new row violates row-level security policy for table "agent_task_events"`.
  Verified via automated test: `should prevent event actor forgery under RLS for runtime role` in `apps/api/test/agent-orchestrator.test.ts`.

---

### Finding SEC-4A-002: Unbounded Row Locking in Task Recovery Endpoint
- **Severity:** **MEDIUM**
- **Affected Files:**
  - `apps/api/src/modules/orchestrator/orchestrator.service.ts` (Lines 652–657)
  - `apps/api/src/modules/orchestrator/schemas.ts` (Line 31–35)
- **Vulnerability Description:**
  The `recoverInterruptedTasks` method executed an unpaged, unconstrained query:
  ```sql
  SELECT id FROM agent_tasks
  WHERE organization_id = $1 AND status IN ('planning', 'running')
  FOR UPDATE;
  ```
  If an organization accumulated a large backlog of running or interrupted tasks, calling `POST /api/v1/agent-tasks/recover` would acquire exclusive row locks across all matching records simultaneously. This could lead to transaction timeouts, lock starvation, and denial of service. Furthermore, task version numbers were not updated when steps were reset to `ready`.
- **Remediation Applied:**
  1. Updated `RecoverTasksSchema` to accept an optional `limit` parameter bounded to `[1, 100]` with a default of `50`.
  2. Updated the recovery query to enforce `ORDER BY updated_at ASC LIMIT $2 FOR UPDATE`.
  3. Incremented `agent_tasks.version` when running steps are restored to `ready`.
  4. Added audit logging via `moducraft_record_audit_event` on successful recovery.
- **Post-Fix Verification:** Verified that batch sizes are bounded and that task versions increment upon recovery.

---

### Finding SEC-4A-003: Title Length Validation Discrepancy
- **Severity:** **MEDIUM**
- **Affected File:** `apps/api/src/modules/orchestrator/schemas.ts` (Line 16)
- **Vulnerability Description:**
  In migration `0005_agent_orchestrator.sql`, the database constraint defines:
  `CHECK(length(trim(title)) BETWEEN 1 AND 200)`.
  However, `CreateAgentTaskSchema` defined:
  `z.string().trim().min(1).max(255)`.
  Submitting a title between 201 and 255 characters passed API validation but triggered an unhandled PostgreSQL constraint violation, producing an HTTP 500 error instead of a clean HTTP 400 validation error.
- **Remediation Applied:**
  Adjusted `CreateAgentTaskSchema` to enforce `max(200)` matching the database schema.
- **Post-Fix Verification:** Added regression test `should reject task title exceeding 200 characters with 400 Bad Request`. Verified HTTP 400 response with `VALIDATION_ERROR` code.

---

### Finding SEC-4A-004: Lack of Metadata Sensitive Key Redaction
- **Severity:** **LOW**
- **Affected File:** `apps/api/src/modules/orchestrator/orchestrator.service.ts` (Lines 157–170)
- **Vulnerability Description:**
  Event metadata passed into `recordEvent` was directly serialized to JSONB without checking for sensitive keys (e.g., `password`, `secret`, `token`, `apiKey`, `authorization`).
- **Remediation Applied:**
  Implemented recursive `sanitizeMetadata()` filtering in `orchestrator.service.ts` matching the redaction pattern used by the database audit function. Keys matching sensitive patterns are redacted to `"[REDACTED]"`.
- **Post-Fix Verification:** Added regression test `should sanitize and redact sensitive keys from event metadata` verifying redaction in `agent_task_events`.

---

### Finding SEC-4A-005: Runtime Database Role Privilege Scope (Informational)
- **Severity:** **INFORMATIONAL**
- **Affected File:** `db/migrations/0005_agent_orchestrator.sql` (Line 172)
- **Observation:**
  `moducraft_runtime` possesses column-level update grants on `agent_task_steps (status, result_data, error_code, error_message, attempt_count, started_at, completed_at)`.
  The Fastify API strictly guards these updates through state machine validation and sequential execution logic. However, at the raw SQL level, a session authenticated as `moducraft_runtime` with valid tenant membership could theoretically update `attempt_count` or `status` directly.
- **Assessment & Risk:**
  This is architectural by design in a modular monolith where the API service layer orchestrates step lifecycle changes using standard SQL statements. Direct SQL access is unavailable to end-users (external clients interact exclusively via authenticated HTTP REST endpoints). The database enforces that primary keys, tenant IDs, input data, and audit records remain immutable.
- **Recommendation for Future Hardening:** In Phase 5/6, consider migrating step execution claims and attempt counter increments into a PostgreSQL stored procedure or trigger to enforce monotonically increasing counters at the database engine level.

---

## 4. Adversarial Attack Verification Results

| Attack Vector | Target Table / Endpoint | Test Role | Result |
| :--- | :--- | :--- | :---: |
| **Cross-Tenant SELECT** | `agent_tasks`, `agent_task_steps`, `agent_task_events` | `moducraft_runtime` (Tenant B) | **BLOCKED** (0 rows returned via RLS) |
| **Cross-Tenant INSERT** | `agent_tasks` | `moducraft_runtime` (Tenant B) | **BLOCKED** (Violates RLS WITH CHECK) |
| **Cross-Tenant UPDATE** | `agent_tasks` | `moducraft_runtime` (Tenant B) | **BLOCKED** (0 rows affected) |
| **Cross-Tenant DELETE** | `agent_tasks` | `moducraft_runtime` (Tenant B) | **BLOCKED** (0 rows affected) |
| **Tenant ID Reassignment** | `agent_tasks.organization_id`, `agent_task_steps.organization_id` | `moducraft_runtime` (Tenant A) | **BLOCKED** (Permission denied by column grants) |
| **Identity Reassignment** | `agent_tasks.created_by` | `moducraft_runtime` (Tenant A) | **BLOCKED** (Permission denied by column grants) |
| **Primary Key Mutation** | `agent_tasks.id` | `moducraft_runtime` (Tenant A) | **BLOCKED** (Permission denied by column grants) |
| **Event Journal Tampering** | `agent_task_events` (UPDATE/DELETE) | `moducraft_runtime` (Tenant A) | **BLOCKED** (Permission denied on table) |
| **Event Actor Spoofing** | `agent_task_events.actor_user_id` | `moducraft_runtime` (Tenant A) | **BLOCKED** (Violates RLS WITH CHECK) |
| **Org Mismatch (Task -> Project)** | `agent_tasks(organization_id, project_id)` | `moducraft_runtime` (Tenant A) | **BLOCKED** (Composite Foreign Key Violation) |
| **Org Mismatch (Step -> Task)** | `agent_task_steps(organization_id, task_id)` | `moducraft_runtime` (Tenant A) | **BLOCKED** (Composite Foreign Key & RLS) |
| **Viewer Role INSERT/UPDATE** | `agent_tasks` | `moducraft_runtime` (Viewer) | **BLOCKED** (RLS policy denied) |

---

## 5. Sandboxing & Execution Safety Audit

1. **Subprocess Spawning:** Zero calls to `child_process`, `exec`, `spawn`, `fork` exist in the orchestrator codebase.
2. **Filesystem Writes:** Zero calls to `fs`, `fs/promises`, or path-traversal write operations exist in the orchestrator.
3. **Network & External Providers:** Zero external HTTP requests, sockets, or cloud provider SDKs are imported or invoked by `SafePlaceholderExecutor`.
4. **Code Evaluation:** No use of `eval()`, `new Function()`, or dynamic module loading.

---

## 6. Pre-Phase 4B Readiness Checklist

- [x] All 74 automated integration tests passing.
- [x] All Phase 2 database authorization tests passing.
- [x] All adversarial SQL tests passing on disposable test database.
- [x] Full monorepo TypeScript typecheck passing with 0 errors.
- [x] Actor spoofing vulnerability resolved and verified.
- [x] Recovery batch limits enforced and concurrency-safe.
- [x] Event metadata sanitized against credential leakage.
- [x] Primary database integrity preserved.

### Assessment Conclusion
ModuCraft Phase 4A AI Agent Orchestrator Foundation is verified secure within its documented architectural boundaries. Ready to proceed to **Phase 4B**.
