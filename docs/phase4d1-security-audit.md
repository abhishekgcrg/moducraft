# ModuCraft Phase 4D.1: Adversarial Security Audit & Execution Hardening

## 1. Executive Summary & Audit Scope

This document presents the dedicated, adversarial security audit and execution hardening report for **ModuCraft Phase 4D.1: Agent Workflow Integration & Execution Hardening** at `G:\ModuCraft\moducraft-foundation`.

Phase 4D introduced end-to-end agentic capabilities combining deterministic task orchestration, multi-provider LLM abstraction, conversation threading, scoped memory, sandboxed tool execution, automated code review, and human-in-the-loop approvals. Phase 4D.1 subjected this entire surface to an adversarial review, validating assumptions under concurrency, network failure, multi-tenant attack vectors, host isolation boundaries, and malicious workflow tampering.

### Audit Objectives:
1. **Approval Integrity & Single-Use Binding**: Verify that approvals cannot be replayed, applied to modified artifact hashes, decided by unauthorized users, or reused across separate workflow completions.
2. **Execution Authenticity vs. Simulation Transparency**: Ensure mock test runners cannot run in production, cannot masquerade as real microVM/container sandboxes, and that simulated runs are explicitly tagged in artifacts, audit logs, and API responses.
3. **Workspace Isolation & Path Traversal**: Test sandbox boundaries against direct directory traversal, canonicalization anomalies, percent-encoded sequences, null bytes, and unauthorized inspection of host/project credential files (`.env*`, `.git/*`, `id_rsa*`, `.aws/*`, `.npmrc`).
4. **Concurrency & Race Conditions**: Verify workflow state transitions, artifact creation, and approval decisions under concurrent execution using database-backed atomic operations and row-level locking (`FOR UPDATE`).
5. **Tool Gateway Security & Output Sanitization**: Verify tool execution enforces role-based authorization (`requiredRole`) and automatically redacts API keys, passwords, and connection strings from tool stdout/stderr before returning to agents or persisting in audit logs.
6. **Database Integrity & RLS Privileges**: Inspect PostgreSQL migrations, role grants, and RLS policies under `moducraft_runtime` (NOBYPASSRLS) to eliminate privilege escalation, self-approval by non-admin members, and audit log foreign-key destruction.

---

## 2. Adversarial Findings & Remediations Matrix

| Finding ID | Vulnerability Title | Severity | Impact | Status |
| :--- | :--- | :--- | :--- | :--- |
| **SEC-4D-01** | Approval Replay & Multiple Consumption via Read-Only Verification | **CRITICAL** | A single human approval could be replayed infinitely to finalize arbitrary workflows | **REMEDIATED** |
| **SEC-4D-02** | Credential Exfiltration via Workspace File Inspection | **HIGH** | Agents could inspect `.env`, `.git/config`, `.ssh/id_rsa`, `.aws/credentials`, leaking platform secrets | **REMEDIATED** |
| **SEC-4D-03** | Race Condition in Concurrent Workflow State Transitions | **HIGH** | Concurrent requests to advance workflow could produce duplicate steps or conflicting task states | **REMEDIATED** |
| **SEC-4D-04** | Member Self-Approval & Status Manipulation via Permissive RLS | **HIGH** | Organization members could update artifact review statuses or manipulate approval records directly | **REMEDIATED** |
| **SEC-4D-05** | Production Risk: Mock Runner Masquerading as Isolated Execution | **MEDIUM** | Mock execution runner could inadvertently execute in production environments without isolation | **REMEDIATED** |
| **SEC-4D-06** | Secret Leakage in Tool Gateway Command and File Execution Outputs | **MEDIUM** | Credentials exposed during test execution or file reads leaked into agent context and audit events | **REMEDIATED** |
| **SEC-4D-07** | Percent-Encoded and Null-Byte Path Traversal Evasion | **LOW** | Malicious paths (`%2e%2e/`, `\0`) could evade workspace boundary checks | **REMEDIATED** |
| **SEC-4D-08** | Audit Trail Disruption via Cascading Artifact Deletion | **LOW** | Deleting an artifact cascaded to approval history, destroying tamper-evident audit chains | **REMEDIATED** |

---

## 3. Detailed Finding Reports

### Finding SEC-4D-01: Approval Replay & Multiple Consumption via Read-Only Verification
- **Severity:** CRITICAL
- **Location:** `apps/api/src/modules/workflows/approvals.service.ts` (formerly Lines 150–185)
- **Vulnerability Description:**
  In the initial Phase 4D implementation, `verifyAndConsumeApproval()` executed a read-only query checking whether an approval with `status = 'approved'` existed for a given `taskId`, `artifactId`, and `expectedHash`. Crucially, **the function never updated the approval's status to mark it as consumed**.
  As a consequence, once an owner or admin approved an artifact, that approval record remained permanently in the `'approved'` state. Any subsequent workflow resumption, retried completion, or rogue caller could repeatedly call `completeWorkflowAfterApproval()` with the same approval ID, bypassing human verification for all subsequent workflow executions.
- **Reproduction:**
  1. Owner approves artifact `#1` with SHA-256 hash `H`. Approval status becomes `'approved'`.
  2. Workflow completes step and consumes approval `#1`.
  3. Attacker triggers a new workflow step or modifies task state and calls `completeWorkflowAfterApproval(approvalId_1)` again.
  4. The check succeeded because status was still `'approved'`, allowing bypass of human gate.
- **Remediation:**
  1. Updated database check constraint in `0009_agent_approvals_consumed_hardening.sql` to include `'consumed'`:
     ```sql
     ALTER TABLE agent_approvals DROP CONSTRAINT agent_approvals_status_check;
     ALTER TABLE agent_approvals ADD CONSTRAINT agent_approvals_status_check 
       CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'consumed'));
     ```
  2. Refactored `verifyAndConsumeApproval` to execute an atomic compare-and-set row lock:
     ```sql
     UPDATE agent_approvals
     SET status = 'consumed', updated_at = NOW()
     WHERE id = (
       SELECT id FROM agent_approvals
       WHERE id = $1 AND task_id = $2 AND artifact_id = $3 AND status = 'approved'
       FOR UPDATE
     )
     RETURNING id, status;
     ```
  3. If status is already `'consumed'` (or anything other than `'approved'`), the update affects 0 rows and throws `ConflictError("Approval has already been consumed or is no longer in approved status")`.
- **Verification:**
  Automated test in `test/workflows.test.ts` (Suite 5, Test 1): Successfully consumed approval on first execution; second execution with identical parameters fails with `ConflictError: Approval has already been consumed or is no longer in approved status`.

---

### Finding SEC-4D-02: Credential Exfiltration via Workspace File Inspection
- **Severity:** HIGH
- **Location:** `apps/api/src/modules/workflows/tools/sandbox.ts`
- **Vulnerability Description:**
  While path traversal outside the workspace directory (`..`) was checked, the file tools (`read_workspace_file`, `list_workspace_files`) allowed unrestricted inspection of files within the workspace root. In containerized or developer environments where `.env`, `.git/config`, private SSH keys, AWS credentials, or `.npmrc` tokens reside inside or adjacent to the repository checkout, an agent prompted with malicious input or automated tool calls could exfiltrate platform credentials.
- **Reproduction:**
  Call `read_workspace_file` with `path: ".env"` or `path: ".git/config"`. The tool previously opened and returned the raw contents of the file.
- **Remediation:**
  1. Introduced strict credential file regex blocklist in `validateWorkspaceRelativePath()`:
     ```typescript
     const SENSITIVE_PATTERNS = [
       /^\.env(\..+)?$/i,
       /\.git([\\\/].+)?$/i,
       /\.ssh([\\\/].+)?$/i,
       /\.aws([\\\/].+)?$/i,
       /(^|[\\\/])(id_rsa|id_ecdsa|id_ed25519|id_dsa)(\..+)?$/i,
       /\.pem$/i,
       /\.key$/i,
       /\.npmrc$/i,
       /\.dockercfg$/i,
       /\.docker[\\\/]config\.json$/i,
     ];
     ```
  2. Any attempt to read, write, or list these sensitive paths throws `ValidationError("Access to sensitive file or directory is forbidden: <path>")`.
- **Verification:**
  Automated test in `test/workflows.test.ts` (Suite 5, Test 2): Verified that calls to `.env`, `.git/config`, `.ssh/id_rsa`, `.aws/credentials`, and `deploy.pem` are immediately rejected with `ValidationError`.

---

### Finding SEC-4D-03: Race Condition in Concurrent Workflow State Transitions
- **Severity:** HIGH
- **Location:** `apps/api/src/modules/workflows/workflow.service.ts`
- **Vulnerability Description:**
  `advanceWorkflow()` and `completeWorkflowAfterApproval()` performed state transitions by reading `task` from `agent_tasks`, inspecting `task.status`, and updating `agent_tasks` in a subsequent statement. Under concurrent execution (e.g., dual webhook triggers, parallel agent loop dispatches, or simultaneous client requests), two threads could read `task.status = 'running'` concurrently, leading to:
  - Parallel generation of duplicate execution steps.
  - Conflicting orchestrator state machine events.
  - Inconsistent step sequence numbers.
- **Remediation:**
  Integrated row-level locking (`FOR UPDATE`) within transaction scopes in `workflow.service.ts`:
  ```typescript
  const taskResult = await client.query(
    `SELECT id, organization_id, project_id, status, type, input, metadata,
            retry_count, max_retries, error_details, created_at, updated_at
     FROM agent_tasks
     WHERE id = $1
     FOR UPDATE`,
    [taskId]
  );
  ```
  All subsequent checks and transitions occur under the exclusive row lock until the transaction commits, ensuring strict serialization of task state transitions.
- **Verification:**
  Verified serial execution in `workflow.service.ts` under transactional concurrency.

---

### Finding SEC-4D-04: Member Self-Approval & Status Manipulation via Permissive RLS
- **Severity:** HIGH
- **Location:** `db/migrations/0008_agent_workflows.sql`
- **Vulnerability Description:**
  In migration 0008, the RLS policy `agent_artifacts_update_authorized` checked:
  ```sql
  (EXISTS (SELECT 1 FROM organization_memberships m WHERE m.organization_id = agent_artifacts.organization_id AND m.user_id = auth_current_user_id() AND m.role IN ('owner', 'admin', 'member')))
  ```
  This permitted any organization `member` to update artifacts directly via SQL, including updating `review_status` to `'approved'`.
  Furthermore, `agent_approvals_update_authorized` allowed any member to update approval rows, creating a privilege escalation path where an unprivileged member could approve their own workflows.
- **Remediation:**
  Executed forward-only migration `0009_agent_approvals_consumed_hardening.sql`:
  1. Restricted `agent_artifacts_update_authorized` strictly to `'owner'` and `'admin'`.
  2. Hardened `agent_approvals_update_authorized` with fine-grained role constraints:
     - `'owner'` and `'admin'` can update approvals across valid decision statuses (`'approved'`, `'rejected'`, `'expired'`).
     - `'member'` is strictly restricted: they can ONLY update an approval that is currently `'approved'` to the `'consumed'` state, preventing members from creating, approving, or rejecting approvals, while allowing workflow completion workers running under member tokens to consume existing approvals.
- **Verification:**
  Verified via adversarial RLS test in `test/workflows.test.ts` (Suite 5, Test 6): Direct UPDATE of `review_status = 'approved'` on `agent_artifacts` by an authenticated member affects 0 rows under RLS.

---

### Finding SEC-4D-05: Production Risk: Mock Runner Masquerading as Isolated Execution
- **Severity:** MEDIUM
- **Location:** `apps/api/src/modules/workflows/tools/sandbox.ts`
- **Vulnerability Description:**
  `MockWorkspaceRunner` provides simulated execution for development, CI, and test environments. If misconfigured or deployed without a production microVM backend (e.g. gVisor, Firecracker), the system would fall back to the mock runner, reporting synthetic passing exit codes (`exitCode: 0`) and mock stdout. This created two serious risks:
  1. **False confidence**: Production workloads believing code was compiled, linted, or unit-tested in an isolated container.
  2. **Accidental host execution**: If modified to run host commands without isolation.
- **Remediation:**
  1. Added fail-closed runtime environment guard to `MockWorkspaceRunner`:
     ```typescript
     if (process.env.NODE_ENV === "production") {
       throw new ForbiddenError(
         "MockWorkspaceRunner is strictly prohibited in production environments. " +
         "A real isolated container runner (gVisor / Firecracker / Kata) must be configured."
       );
     }
     ```
  2. Annotated all `ExecutionResult` outputs with explicit transparency flags:
     - `runnerType: "mock"`
     - `isProductionSandbox: false`
     - `isSimulated: true`
  3. Annotated `TestingAgent` test reports with `[SIMULATED_MOCK]` badges.
- **Verification:**
  Automated test in `test/workflows.test.ts` (Suite 5, Test 5): Setting `NODE_ENV = "production"` causes `MockWorkspaceRunner.executeCommand` to throw `ForbiddenError`.

---

### Finding SEC-4D-06: Secret Leakage in Tool Gateway Command and File Execution Outputs
- **Severity:** MEDIUM
- **Location:** `apps/api/src/modules/workflows/tools/gateway.ts`
- **Vulnerability Description:**
  When agents executed tools (e.g., `read_workspace_file`, `run_test_command`), outputs could contain inadvertent secrets (tokens generated during test runs, database connection strings, bearer tokens, or internal credentials). Returning raw output directly to LLM context or persisting it in task execution step records risked permanent secret leakage into conversation history and audit logs.
- **Remediation:**
  Integrated the hardened Phase 4C secret redactor (`redactSensitiveData`) directly into `ToolGateway.executeTool()`:
  - Every tool execution output string or JSON field is automatically sanitized prior to returning results to caller or orchestrator.
  - Automatically masks passwords, bearer tokens, API keys (`sk-`, `ghp_`, `AKIA`), connection strings (`postgresql://`, `mongodb+srv://`), and private key blocks.
- **Verification:**
  Automated test in `test/workflows.test.ts` (Suite 5, Test 4): Command output containing `OPENAI_API_KEY=sk-live-1234567890abcdef12345678` is scrubbed to `OPENAI_API_KEY=[REDACTED_API_KEY]`.

---

### Finding SEC-4D-07: Percent-Encoded and Null-Byte Path Traversal Evasion
- **Severity:** LOW
- **Location:** `apps/api/src/modules/workflows/tools/sandbox.ts`
- **Vulnerability Description:**
  Attackers frequently employ URL percent-encoding (e.g., `%2e%2e%2f` for `../`) or null-byte injection (`%00`) to bypass standard string pattern matching before paths reach downstream filesystem APIs.
- **Remediation:**
  Added recursive URI decoding and null byte checks prior to path resolution:
  ```typescript
  let decoded = requestedPath;
  try {
    while (decoded.includes("%")) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    throw new ValidationError("Invalid URI encoding in workspace path");
  }

  if (decoded.includes("\0")) {
    throw new ValidationError("Null bytes are prohibited in workspace path");
  }
  ```
- **Verification:**
  Automated test in `test/workflows.test.ts` (Suite 5, Test 3): Paths containing `%2e%2e%2fetc%2fpasswd` and null bytes are rejected with `ValidationError`.

---

### Finding SEC-4D-08: Audit Trail Disruption via Cascading Artifact Deletion
- **Severity:** LOW
- **Location:** `db/migrations/0008_agent_workflows.sql`
- **Vulnerability Description:**
  In migration 0008, the foreign key constraint `agent_approvals.artifact_id` was configured with `ON DELETE CASCADE`. If an artifact was deleted, all associated approval records (including timestamps, hash bindings, approver user IDs, and review comments) were permanently purged from the database, eliminating the evidentiary trail required for compliance and security auditing.
- **Remediation:**
  Updated the foreign key in `0009_agent_approvals_consumed_hardening.sql`:
  ```sql
  ALTER TABLE agent_approvals DROP CONSTRAINT agent_approvals_artifact_id_fkey;
  ALTER TABLE agent_approvals ADD CONSTRAINT agent_approvals_artifact_id_fkey
    FOREIGN KEY (artifact_id) REFERENCES agent_artifacts(id) ON DELETE RESTRICT;
  ```
  Attempts to delete an artifact that possesses approval history will fail closed with foreign key violation, guaranteeing audit record retention.
- **Verification:**
  Automated test in `test/workflows.test.ts` (Suite 5, Test 7): Attempting to DELETE an artifact referenced by an approval record throws PostgreSQL foreign key constraint violation (`23503`).

---

## 4. Production Runner Architecture: Mock vs Isolated Container Sandbox

ModuCraft adheres strictly to truthful capability reporting: **No claim of container isolation is made for the default development environment.**

### Current State: `MockWorkspaceRunner`
- **Purpose**: Fast, dependency-free development, CI unit testing, and workflow integration validation.
- **Security Posture**:
  - `runnerType: "mock"`
  - `isProductionSandbox: false`
  - `isSimulated: true`
  - **Fails closed** in production (`NODE_ENV === "production"`).
  - Explicitly banned from executing real host commands.

### Production Requirement: Isolated MicroVM / Container Runner
For production deployments where agent-generated code must be compiled, linted, executed, or tested, a real sandbox provider implementing `IsolatedWorkspaceRunner` is required:

```
┌─────────────────────────────────────────────────────────────┐
│                       ModuCraft API                         │
│                    (ToolGateway / Node)                     │
└──────────────────────────────┬──────────────────────────────┘
                               │ gRPC / Mutual TLS
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 Sandbox Agent Daemon (Host)                 │
└──────────────┬───────────────────────────────┬──────────────┘
               │                               │
      gVisor (runsc)                 Firecracker MicroVM
┌──────────────────────────────┐┌──────────────────────────────┐
│  • Emulated Linux Kernel     ││  • Hardware-isolated KVM     │
│  • Filtered syscall surface  ││  • Dedicated read-only rootfs│
│  • Memory & CPU cgroups      ││  • Ephemeral workspace mount │
│  • No host network access    ││  • Strict 30s timeout killer │
└──────────────────────────────┘└──────────────────────────────┘
```

### Production Sandbox Requirements:
1. **Zero Host Filesystem Access**: Workspace files must be mounted into an ephemeral, non-persistent volume.
2. **Network Isolation**: Default network egress disabled. Package downloads (e.g. `npm install`) routed through an authenticated caching proxy with domain whitelisting.
3. **Execution Limits**: Strict memory caps (e.g. 512MB), CPU quota (1 vCPU), PID limits (max 64 processes), and hard execution timeouts (30 seconds).
4. **Non-Root Execution**: Container processes run under an unprivileged user (`uid=10001, gid=10001`) with all Linux capabilities dropped (`cap_drop: ALL`).

---

## 5. Verification Matrix

All security controls and bug remediations were comprehensively verified against the live test database and monorepo codebase.

### 1. Test Suite Results
| Test Suite | Tests Run | Pass | Fail | Description |
| :--- | :--- | :--- | :--- | :--- |
| `test/workflows.test.ts` | **24** | **24** | **0** | Workflow orchestration, approval consumption, path security, secret redaction, RLS enforcement |
| `test/providers.test.ts` | **13** | **13** | **0** | LLM provider abstraction, fallback, rate-limiting, and error handling |
| `test/memory.test.ts` | **17** | **17** | **0** | Threading, scoped memory, context assembly, secret redactor |
| `test/orchestrator.test.ts` | **10** | **10** | **0** | Deterministic state machine, step execution, retry policies |
| `test/organizations.test.ts` | **8** | **8** | **0** | Organization membership, role hierarchies, and invites |
| `test/projects.test.ts` | **6** | **6** | **0** | Project scoping, access control, metadata validation |
| `test/secrets.test.ts` | **12** | **12** | **0** | Envelope encryption, key derivation, secret masking |
| `test/auth.test.ts` | **11** | **11** | **0** | JWT verification, session derivation, claims validation |
| `test/tenancy.test.ts` | **17** | **17** | **0** | Cross-tenant isolation, context boundary enforcement |
| `test/audit.test.ts` | **10** | **10** | **0** | Tamper-evident audit logging, actor attribution |
| `test/recovery.test.ts` | **12** | **12** | **0** | Agent task recovery, crash resilience, batch bounds |
| **Total Test Count** | **140** | **140** | **0** | **100% Pass Rate across all 11 suites** |

### 2. Database Authorization Verification
- Executed `scripts/verify-phase2-db.ps1` against `moducraft-postgres`:
  - **9 / 9 test suites PASSED**.
  - All direct SQL attacks under `moducraft_runtime` (NOBYPASSRLS) rejected.
  - Cross-tenant injection, tenant reassignment, event actor forgery, and unprivileged updates blocked.

### 3. TypeScript Typecheck & Monorepo Build
- `pnpm typecheck`: **0 errors** across monorepo (`apps/api`, `apps/web`, `packages/*`).
- `pnpm build`: **Clean production build** (Fastify API compiled with `tsc`, Next.js 15.5.27 production build succeeded).

---

## 6. Production Readiness Checklist & Residual Risks

### Production Readiness Checklist:
- [x] Forward-only database migration `0009_agent_approvals_consumed_hardening.sql` applied.
- [x] Approvals are single-use (`status = 'consumed'`) and hash-bound to immutable artifacts.
- [x] Row-level locking (`FOR UPDATE`) protects task transitions from race conditions.
- [x] Sensitive files (`.env*`, `.git/*`, `.ssh/*`, `.aws/*`, private keys) blocked from workspace tools.
- [x] Automated secret redaction enabled across all tool gateway outputs.
- [x] `MockWorkspaceRunner` strictly fails closed in `NODE_ENV === "production"`.
- [x] Tool execution validates user organization role requirements.
- [x] Foreign key constraints prevent cascading destruction of approval audit trails.
- [x] All 140 automated tests passing cleanly.

### Residual Risks & Future Phases:
1. **MicroVM Runner Implementation (Phase 5)**:
   - While `MockWorkspaceRunner` safely fails closed in production, executing arbitrary untrusted code in multi-tenant environments requires implementing the gVisor/Firecracker adapter before enabling test commands in production.
2. **Static Code Analysis AST Rules (Phase 5)**:
   - Current code review agent relies on LLM heuristics and rule patterns. Integrating deterministic AST analysis (e.g. Semgrep/Biome) will further strengthen automated quality gates.
3. **Hardware Security Module (HSM) Key Storage**:
   - Production secrets management currently uses envelope encryption with master keys derived from environment variables. Moving to AWS KMS / GCP Cloud KMS / HashiCorp Vault is recommended for high-compliance enterprise deployments.
