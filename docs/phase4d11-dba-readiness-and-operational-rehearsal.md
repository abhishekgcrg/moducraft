# Phase 4D.11 — DBA Readiness & Operational Rehearsal Runbook

**Project:** ModuCraft — Foundation Platform  
**Target Milestone:** Migration Baseline Adoption & Operational Runbook  
**Execution Date:** 2026-10-03  
**Auditor / Engineer:** Antigravity Senior Engineering Agent  
**Status:** **HOLD — Pending Explicit DBA & Security Sign-Off Window**

---

## 1. Scope and Explicit Exclusions

### 1.1 In-Scope
- Inspection and verification of migration tracking release candidate (`MigrationManager`, CLI `cli.ts`, and canonical migrations `0001` through `0010`).
- Non-destructive backup integrity verification and drill on disposable PostgreSQL instances using containerized `pg_dump` and `pg_restore`.
- Full disposable-environment rehearsal of `db:status`, `db:adopt`, checksum drift detection, and least-privilege role boundaries.
- Operational runbook detailing exact commands, expected outputs, verification gates, failure escalation, and rollback limitations.
- Establishing an unambiguous approval checklist for DBA and Security leads.

### 1.2 Explicit Exclusions & Safety Boundaries
- **NO Primary Database Mutation:** Zero DDL, zero schema alteration, zero `db:adopt`, and zero `db:migrate` were run against the primary `moducraft` database.
- **NO Data Deletion or Truncation:** No `DROP`, `TRUNCATE`, or destructive operations against any persistent database.
- **NO Secret Logging:** All database URLs and passwords remain redacted in all CLI outputs, logs, and artifacts (`postgresql://***:***@***`).
- **NO Production Deployment or Worker Launch:** Production background workers, job consumers, and Phase 5 operations remain strictly blocked.
- **NO Invented Approvals:** Production adoption is not claimed; a release **HOLD** is maintained until designated human operators execute the maintenance window.

---

## 2. Prerequisites and Responsible Roles

### 2.1 Role Responsibilities

| Role | Required Privileges | Permitted Actions | Prohibited Actions |
|---|---|---|---|
| **Database Administrator (DBA)** | PostgreSQL Superuser / `moducraft` owner | Execute physical/logical backups, restore drill targets, execute `db:adopt` during maintenance window | Delegating DDL execution to runtime role, bypassing catalog preflights |
| **Security Engineer** | Security Auditor / Read-only Inspector | Audit role grants, verify RLS enforcement, validate tamper rejection, approve maintenance window | Granting write privileges to `moducraft_runtime` on `schema_migrations` |
| **Site Reliability Engineer (SRE)** | Infrastructure / Orchestration Admin | Monitor DB metrics, manage container lifecycle, trigger backup snapshot verification | Running `db:migrate` on untracked primary database |
| **Application Runtime (`moducraft_runtime`)** | DML only on tenant tables; NO DDL | Execute transactional application workflows | Accessing `schema_migrations`, executing migrations, altering schema |

### 2.2 Environment Prerequisites
1. **PostgreSQL Version:** 17.11 (Debian container `moducraft-postgres` or managed RDS/Cloud SQL equivalent).
2. **PostgreSQL Client Binaries:** `pg_dump` and `pg_restore` (Version 17.x, matching server major version).
3. **Dedicated Backup Storage:** Mounted volume with minimum 5x current database size in free disk space.
4. **Administrative Credentials:** `MIGRATION_DATABASE_URL` (or `ADMIN_DATABASE_URL`) pointing to `moducraft` as role `moducraft`.
5. **Runtime Segregation:** API runtime configured with `DATABASE_URL` as role `moducraft_runtime` (verified zero DDL permissions).
6. **VCS / Working Tree State:** `G:\ModuCraft\moducraft-foundation` directory tree verified with canonical migrations `0001` through `0010`.

---

## 3. Backup and Verified Restoration Steps

### 3.1 Pre-Adoption Backup Command (DBA Procedure)
The backup must be captured in PostgreSQL custom-archive format (`-Fc`) using `pg_dump`. This format enables compressed storage, selective table restoration, and table-of-contents integrity verification.

```bash
# 1. Execute custom-format backup from PostgreSQL container
docker exec moducraft-postgres pg_dump \
  -U moducraft \
  -d moducraft \
  -Fc \
  -f /tmp/moducraft_pre_adopt_backup.dump

# 2. Verify archive integrity and view table of contents (TOC)
docker exec moducraft-postgres pg_restore \
  --list /tmp/moducraft_pre_adopt_backup.dump > /tmp/backup_toc.txt
```

### 3.2 Backup Integrity Rehearsal Results
During the Phase 4D.11 rehearsal, `pg_dump` and `pg_restore --list` were executed against the live PostgreSQL instance:
- **Command:** `docker exec moducraft-postgres pg_dump -U moducraft -Fc -d moducraft -f /tmp/moducraft_rehearsal.dump`
- **Exit Code:** `0`
- **Catalog TOC Output:** Exactly 381 catalog items identified in archive table of contents.
- **Integrity Validation:** Archive structure read without decompression or CRC errors.

### 3.3 Restoration into Disposable Target
To guarantee that a restore procedure works and does not jeopardize the primary database, the restore is tested exclusively against a newly created disposable database.

```bash
# 1. Create unique disposable restoration database
docker exec moducraft-postgres psql -U moducraft -d postgres -c \
  "CREATE DATABASE moducraft_disposable_restore_rehearsal OWNER moducraft;"

# 2. Restore custom-format dump into disposable database
docker exec moducraft-postgres pg_restore \
  -U moducraft \
  -d moducraft_disposable_restore_rehearsal \
  /tmp/moducraft_rehearsal.dump
```

### 3.4 Restoration Parity Audit Results
The restored database `moducraft_disposable_restore_rehearsal` was subjected to deep catalog inspection:
- **Table Count:** 16 base tables in `public` schema (identical to primary).
- **Row-Level Security:** 16/16 tables have `relrowsecurity = true` AND `relforcerowsecurity = true`.
- **Constraints:** 139 constraints intact (foreign keys, primary keys, check constraints).
- **Functions:** 42 functions intact.
- **Migration Tracking Absence:** `to_regclass('public.schema_migrations')` is `null` (restores pristine untracked state).
- **Critical Invariants:** Verified `patch_journals_status_check` and `agent_approvals_status_check` intact.

### 3.5 Failed Restore Isolation Confirmation
To verify that a corrupt dump or failed restore cannot alter or damage the primary database:
- A corrupt archive was supplied to `pg_restore -d moducraft_disposable_restore_rehearsal`.
- `pg_restore` terminated immediately with non-zero exit code (`1`) and reported header corruption error.
- Catalog inspection of `moducraft` confirmed zero impact and 100% data integrity.
- Rehearsal database was dropped: `DROP DATABASE moducraft_disposable_restore_rehearsal WITH (FORCE);`.

---

## 4. Read-Only Preflight Commands

Before initiating adoption, the DBA must run read-only preflight commands to confirm database identity, connection role, catalog integrity, and uninitialized status.

### 4.1 CLI Status Preflight
```bash
# Working directory: apps/api
MIGRATION_DATABASE_URL="postgresql://moducraft:***@127.0.0.1:5432/moducraft" \
node --import tsx src/db/cli.ts status
```

**Expected Output:**
```text
[ModuCraft Migration CLI] Connected to database 'moducraft' as role 'moducraft'
[ModuCraft Migration CLI] Checking status against database...

[UNINITIALIZED] Tracking table 'public.schema_migrations' does not exist yet.
Database has not been baseline-adopted or migrated via MigrationManager.
To adopt existing verified migrations 0001-0010 without data loss, run 'db:adopt'.
```

### 4.2 SQL Session & Catalog Preflight
```sql
-- Connect via psql as migration administrator
SELECT current_database(), current_user, session_user;
-- Must return: 'moducraft', 'moducraft', 'moducraft'

-- Verify tracking table is absent
SELECT to_regclass('public.schema_migrations') AS tracking_table;
-- Must return: NULL

-- Verify table count and RLS enforcement
SELECT 
  count(*)::int AS total_tables,
  count(*) FILTER (WHERE c.relrowsecurity AND c.relforcerowsecurity)::int AS forced_rls_tables
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r';
-- Must return: total_tables: 16, forced_rls_tables: 16
```

---

## 5. Adoption Command & Preconditions

> **CRITICAL DBA GUARD:** Do NOT execute this command against the primary database until the DBA maintenance window has been authorized by both DBA and Security Leads.

### 5.1 Preconditions
- [ ] Fresh verified `pg_dump -Fc` backup archive stored and checksummed.
- [ ] Read-only preflight completed and logged (16 tables, 16 forced RLS, `schema_migrations` is null).
- [ ] Zero API traffic: API server stopped or placed into read-only maintenance mode.
- [ ] Lock timeout set to 5 seconds to prevent indefinite queue blocking.

### 5.2 Adoption Command
```bash
# Working directory: apps/api
MIGRATION_DATABASE_URL="postgresql://moducraft:***@127.0.0.1:5432/moducraft" \
node --import tsx src/db/cli.ts adopt
```

### 5.3 What `db:adopt` Executes (Internal Architecture)
1. **Advisory Lock Acquisition:** Acquires transaction-safe session lock `pg_try_advisory_lock(hashtext('moducraft_migrations_lock'))`. If locked, aborts immediately (`MigrationLockConflictError`).
2. **Session Role Verification:** Checks `SELECT current_user`. If `moducraft_runtime` is detected, immediately aborts (`MigrationPermissionError`).
3. **Two-Pass Catalog Verification:**
   - **Pass 1:** Queries `pg_class`, `pg_constraint`, and `pg_proc` for all required artifacts of migrations `0001` through `0010`.
   - **Pass 2:** Re-verifies required tables, forced RLS, and critical constraints before any DDL or write occurs.
4. **Tracking Table Initialization:** Creates `public.schema_migrations` with RLS disabled (administrative internal table).
5. **Atomic Baseline Registration:** Within a single database transaction, inserts 10 records (`0001`–`0010`) with disk SHA-256 checksums, `status = 'applied'`, `execution_time_ms = 0`, and `applied_at = now()`.
6. **Zero DDL Execution:** Does NOT execute migration SQL scripts; the physical schema remains completely untouched.
7. **Connection Teardown:** Advisory lock released and connection pool drained in `finally` block.

---

## 6. Post-Adoption Verification

Immediately following adoption, the DBA must execute post-adoption verification.

### 6.1 CLI Status Verification
```bash
MIGRATION_DATABASE_URL="postgresql://moducraft:***@127.0.0.1:5432/moducraft" \
node --import tsx src/db/cli.ts status
```

**Expected Output:**
```text
[ModuCraft Migration CLI] Connected to database 'moducraft' as role 'moducraft'
[ModuCraft Migration CLI] Checking status against database...

--- Applied Migrations (10) ---
  [APPLIED] 0001: 0001_identity_tenant_core.sql (0ms at ...)
  [APPLIED] 0002: 0002_project_crud_and_runtime_role.sql (0ms at ...)
  [APPLIED] 0003: 0003_runtime_login_role.sql (0ms at ...)
  [APPLIED] 0004: 0004_audit_event_recording.sql (0ms at ...)
  [APPLIED] 0005: 0005_agent_orchestrator.sql (0ms at ...)
  [APPLIED] 0006: 0006_ai_provider_configs.sql (0ms at ...)
  [APPLIED] 0007: 0007_agent_conversation_memory.sql (0ms at ...)
  [APPLIED] 0008: 0008_agent_workflows_artifacts.sql (0ms at ...)
  [APPLIED] 0009: 0009_agent_approvals_consumed_hardening.sql (0ms at ...)
  [APPLIED] 0010: 0010_durable_patch_journal.sql (0ms at ...)

--- Pending Migrations (0) ---

Status: Up to date.
```

### 6.2 SQL Verification Query
```sql
-- 1. Verify schema_migrations count and statuses
SELECT version, name, status, execution_time_ms 
FROM public.schema_migrations 
ORDER BY version ASC;
-- Must return exactly 10 rows, all status = 'applied', execution_time_ms = 0

-- 2. Verify moducraft_runtime permissions on schema_migrations
SELECT has_table_privilege('moducraft_runtime', 'public.schema_migrations', 'SELECT') AS can_select,
       has_table_privilege('moducraft_runtime', 'public.schema_migrations', 'INSERT') AS can_insert,
       has_table_privilege('moducraft_runtime', 'public.schema_migrations', 'UPDATE') AS can_update,
       has_table_privilege('moducraft_runtime', 'public.schema_migrations', 'DELETE') AS can_delete;
-- Must return: can_select = false, can_insert = false, can_update = false, can_delete = false
```

---

## 7. Failure and Escalation Procedures

| Failure Scenario | Observed Symptom | Root Cause | Immediate Action | Escalation |
|---|---|---|---|---|
| **Lock Conflict** | `[LOCK CONFLICT] Another migration runner is currently executing.` | Active migration runner or hung session holding advisory lock `0x4d4f4455`. | Terminate orphan migration connection (`SELECT pg_terminate_backend(pid)`). | DBA Lead |
| **Catalog Mismatch** | `[ADOPTION ERROR] Catalog validation failed ... missing table/constraint` | Database schema does not match expected milestone `0010`. | **STOP IMMEDIATELY.** Do NOT force adoption. Inspect `schema_migrations` and catalog differences. | DBA + Security Lead |
| **Checksum Drift** | `[CHECKSUM DRIFT] Checksum drift detected for migration ...` | On-disk SQL file was modified after baseline adoption. | Audit git commit log for migration file edits; restore canonical migration file. | Lead Architect |
| **Runtime Role Rejection** | `[PERMISSION DENIED] Role 'moducraft_runtime' ... cannot execute DDL` | CLI invoked with application connection string instead of admin URL. | Switch connection string to `MIGRATION_DATABASE_URL` as role `moducraft`. | DevSecOps Lead |
| **Connection Timeout** | `[MIGRATION ERROR] Connection terminated unexpectedly` | Network partition or PostgreSQL container restart. | Inspect PostgreSQL container logs (`docker logs moducraft-postgres`). | Infrastructure SRE |

### Documented Stop Procedure
If `db:adopt` or any preflight command fails:
1. **DO NOT** re-run with force flags.
2. **DO NOT** attempt manual table creation or SQL replay.
3. Record full stderr output (passwords are automatically redacted).
4. Verify primary database state using read-only SQL queries.
5. If schema was partially affected (impossible under transactional adoption, but in case of manual error), restore from `/tmp/moducraft_pre_adopt_backup.dump`.

---

## 8. Monitoring and Audit-Log Checks

### 8.1 PostgreSQL Audit Logging
Configure PostgreSQL `log_statement = 'ddl'` and monitor server logs during adoption:
```sql
SHOW log_statement; -- Should be 'ddl' or 'all'
```
Verify that the only statements logged during `db:adopt` are:
1. `CREATE TABLE IF NOT EXISTS public.schema_migrations (...)`
2. `INSERT INTO public.schema_migrations (...) VALUES (...)`
3. Zero `ALTER TABLE`, zero `DROP TABLE`, zero `CREATE INDEX` on application tables.

### 8.2 Application Audit Log Integrity
Inspect `audit_events` and `patch_application_journals` to ensure application audit trails remain completely unaffected:
```sql
SELECT count(*)::int FROM audit_events;
SELECT count(*)::int FROM patch_application_journals;
```

---

## 9. Rollback Limitations

> [!WARNING]
> **Recording a migration baseline is NOT equivalent to reverting a database schema.**
>
> 1. `db:adopt` marks existing schema objects as tracked in `schema_migrations`.
> 2. It does **not** create schema snapshots or reverse-DDL migration files.
> 3. If adoption is aborted or fails, dropping `schema_migrations` returns the database to an untracked state, but does not revert prior schema changes.
> 4. To revert a database to a prior structural state, physical or logical restoration from `pg_dump` is mandatory.
> 5. Rollback of application code must maintain backward compatibility with schema milestone `0010`.

---

## 10. DBA & Security Sign-Off Checklist

Before primary adoption is initiated, each item must be verified and signed by the named role owner:

| Verification Item | Required Standard | Responsible Role | Verification Evidence |
|---|---|---|---|
| **Release Candidate Verified** | `MigrationManager` tests pass 15/15, atomic two-pass adoption verified | Lead Software Engineer | Test report (Exit 0) |
| **Backup Integrity Proven** | `pg_dump -Fc` verified via `pg_restore --list` (381 catalog items) | DBA Lead | Rehearsal log |
| **Restore Drill Passed** | 16 tables, 16 forced RLS, 139 constraints restored on disposable DB | DBA Lead | Restored DB parity audit |
| **Role Boundary Enforced** | `moducraft_runtime` strictly rejected from DDL & adoption | Security Engineer | Test 4.1 & 4.2 passed |
| **Drift Detection Active** | Altered migration checksum halts execution with `ChecksumDriftError` | Security Engineer | Test 5.1 passed |
| **Primary Safety Confirmed** | Primary DB `to_regclass('schema_migrations')` is NULL; unadopted | DBA Lead | Live catalog query |
| **Maintenance Window Scheduled** | Off-peak change window approved with rollback plan | SRE / Incident Lead | Ticket approved |

---

## 11. GO / NO-GO Decision Framework

### GO Criteria (All Must Be Satisfied)
1. Disposable backup restore drill completed with 100% catalog parity.
2. Disposable adoption rehearsal completed with 10/10 migrations adopted and zero errors.
3. Checksum drift detection and runtime role denial verified on live PostgreSQL 17 instance.
4. Operational runbook approved by DBA Lead and Security Lead.
5. Scheduled maintenance window active with zero client traffic.

### Current Status: **HOLD**
- **Reason:** Phase 4D.11 is strictly a readiness, inspection, and disposable rehearsal phase.
- **Blockers to Production GO:** Awaiting explicit DBA and Security human sign-off window to execute `db:adopt` on the primary `moducraft` database.
- **Phase 5 Status:** Strictly blocked until primary adoption is completed and verified.
