# ModuCraft Phase 4A — AI Agent Orchestrator Threat Model

## 1. Scope & Objective

This threat model analyzes the security boundaries, potential attack vectors, and implemented defensive mitigations for the Phase 4A AI Agent Orchestrator in ModuCraft.

---

## 2. Threat Analysis & Mitigations

### Threat 1: Direct Client Forgery of Task Status, Results, or Attempts
- **Threat Vector:** A malicious or compromised client submits a payload to `POST /api/v1/agent-tasks` or update endpoints specifying `status = 'succeeded'`, `resultData = { ... }`, `version = 999`, or `attemptCount = 0`.
- **Mitigation:**
  - **Strict Zod Schemas:** Input schemas enforce `.strict()`. Any unexpected or restricted properties result in HTTP `400 Bad Request`.
  - **SQL Column Privileges:** The `moducraft_runtime` role has no `UPDATE` grant on `agent_tasks.input_data`, `created_by`, `organization_id`, or `project_id`.
  - **State Machine Enforcement:** All transitions are strictly validated in `OrchestratorStateMachine`. Transitions cannot bypass valid lifecycle paths.

### Threat 2: Cross-Tenant Task Tampering and Step Injection
- **Threat Vector:** An attacker in Organization A attempts to view, execute, retry, or cancel a task belonging to Organization B, or link steps/events to a different tenant.
- **Mitigation:**
  - **Forced PostgreSQL RLS:** `agent_tasks`, `agent_task_steps`, and `agent_task_events` enforce RLS using `moducraft_is_org_member(organization_id)`.
  - **Composite Foreign Key Integrity:** Foreign keys in child tables reference `(organization_id, task_id)` on `agent_tasks`. It is impossible at the database engine level to link a step with Organization A to a task with Organization B.
  - **Zero Leakage (404 Responses):** Cross-tenant queries return `404 Not Found` rather than `403 Forbidden`, eliminating enumeration risks.

### Threat 3: Concurrency Race Conditions on Step Execution
- **Threat Vector:** Multiple concurrent workers or API calls invoke `POST /api/v1/agent-tasks/:id/run` simultaneously, leading to double-execution of a single step or simultaneous step completions.
- **Mitigation:**
  - **Row Locks (`FOR UPDATE`):** The orchestrator acquires an exclusive row lock on `agent_tasks` and `agent_task_steps` at the beginning of the transaction before inspecting status.
  - **Optimistic Version Bumping:** The `version` column is incremented atomically on every mutation.
  - **Idempotency Guards:** If a step has already succeeded or is currently running, subsequent calls evaluate safely without repeating side effects.

### Threat 4: Unbounded Retries & Resource Exhaustion (DoS)
- **Threat Vector:** A user repeatedly invokes the retry endpoint on a failing task, consuming infinite compute cycles or database log storage.
- **Mitigation:**
  - **Bounded Retry Limits:** Each step enforces `attempt_count < max_attempts` (default: 3).
  - **Rejection of Exhausted Retries:** The retry endpoint verifies `attempt_count < max_attempts` and returns `400 Validation Error` if the limit has been reached.

### Threat 5: Untrusted Code or Shell Execution via AI Tooling
- **Threat Vector:** AI prompts or task types trigger arbitrary system commands, shell execution, external network calls, or filesystem tampering.
- **Mitigation:**
  - **Deterministic Local Sandboxing:** The Phase 4A executor (`SafePlaceholderExecutor`) contains only pure deterministic in-memory routines. No subprocess spawning, no shell evaluation, no filesystem writes, and no external HTTP requests exist in the executor.

### Threat 6: Identity Context Spoofing (`app.user_id`)
- **Threat Vector:** An attacker attempts to forge another user's identity by manipulating transaction settings.
- **Mitigation:**
  - **Server-Side Token Verification:** Identity is established solely via cryptographically signed JWTs validated by `JoseJwtVerifier`.
  - **Transaction-Local Configuration:** `set_config('app.user_id', $1, true)` is set with `is_local = true` inside `withAuthenticatedContext`. The variable is automatically cleared upon transaction termination.
  - **Direct Privilege Denial:** `moducraft_runtime` cannot bypass RLS or alter audit logs directly.
