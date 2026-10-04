# ModuCraft Phase 4D: Baseline Architecture & Preflight Report

**Date:** 2026-10-03  
**Auditor/Implementer:** Antigravity  
**Repository:** `G:\ModuCraft\moducraft-foundation`  
**Current Phase:** Phase 4D — Agent Workflow Integration

---

## 1. Existing Foundation & Modules Inventory

### 1.1 Database Migrations (0001–0007)
1. **0001_identity_tenant_core.sql**:
   - `organizations`, `app_users`, `organization_memberships`.
   - Core functions: `moducraft_is_org_member()`, `moducraft_has_org_role()`, `moducraft_current_user_id()`.
   - Forced RLS with tenant isolation.
2. **0002_project_crud_and_runtime_role.sql**:
   - `projects` table with composite `(organization_id, id)` uniqueness and foreign keys.
   - `moducraft_runtime` least-privilege role.
3. **0003_runtime_login_role.sql**:
   - Hardened `moducraft_runtime` login credentials and runtime role assignment.
4. **0004_audit_event_recording.sql**:
   - `audit_events` append-only table.
   - `moducraft_record_audit_event()` SECURITY DEFINER function with strict search path and parameter validation.
5. **0005_agent_orchestrator.sql**:
   - `agent_tasks`, `agent_task_steps`, `agent_task_events`.
   - Task lifecycle (`queued`, `planning`, `running`, `waiting_for_approval`, `succeeded`, `failed`, `cancelled`).
   - Step lifecycle (`pending`, `ready`, `running`, `succeeded`, `failed`, `skipped`, `cancelled`).
   - Append-only events table (`GRANT INSERT, SELECT` only).
6. **0006_ai_provider_configs.sql**:
   - `ai_provider_configs` table with AES-256-GCM encrypted API keys.
   - SSRF protection on base URLs.
7. **0007_agent_conversation_memory.sql**:
   - `conversations`, `conversation_messages`, and `agent_memories`.
   - Scoped memory (`user`, `organization`, `project`, `task`).
   - Append-only message history with strict sequence numbering.

### 1.2 Orchestrator Engine (`apps/api/src/modules/orchestrator/`)
- **`AgentOrchestratorService`**:
  - Task and step creation, listing, recovery, and step progression.
  - Concurrency management with `SELECT ... FOR UPDATE` row locks.
  - Recovery mechanism for crashed/interrupted tasks (`recoverInterruptedTasks`).
  - Approval hook for `waiting_for_approval` tasks (`approveTask`).
- **`DeterministicTaskPlanner`**:
  - Plans `project_summary`, `repository_review_plan`, `implementation_plan`, and `ai_text_generation`.
- **`SafePlaceholderExecutor`**:
  - Deterministic step execution without arbitrary shell or host processes.

### 1.3 AI Provider Abstraction (`apps/api/src/modules/providers/`)
- Unified interface for chat completions (`AIProviderService`, `BaseAIProviderAdapter`, `OpenAICompatibleAdapter`, Anthropic, Gemini).
- Built-in retry with exponential backoff and circuit-breaking resilience.
- Strict SSRF protection rejecting private IP addresses, AWS/GCP metadata endpoints (169.254.169.254), and loopback targets.

### 1.4 Agent Memory & Conversation (`apps/api/src/modules/memory/`)
- Conversational threads and ordered message history.
- Multi-tier memory store with deterministic redaction (`Redactor`).
- Context assembly with sliding-window token budgeting (`ContextAssembler`) and XML delimiter escaping.

---

## 2. Identified Gaps for Phase 4D

1. **Multi-Agent Workflow Pipelines**:
   - Currently, tasks are linear step sequences generated mostly for single-focus tasks.
   - Need higher-level multi-agent workflows connecting:
     `Planner` -> `Coding` -> `Testing` -> `Code Review` -> `Security Review` -> `Documentation`.
2. **Typed Agent Contracts**:
   - No explicit agent contract interface for each specialized agent role defining inputs, outputs, allowed capabilities, context token budgets, and error formats.
3. **Controlled Tool Gateway**:
   - Currently, executor is a monolithic switch-statement. There is no typed tool registry with explicit schemas, workspace boundaries, path traversal prevention, output limits, and quota enforcement.
   - Missing explicit tools: `read_workflow_status`, `read_project_manifest`, `inspect_file`, `create_patch_proposal`, `run_test_command`, `produce_review_report`.
4. **Artifact Management**:
   - No database table or model for versioned/immutable artifacts (patch proposals, test reports, review reports, documentation).
   - Patches are not currently inspectable or diffable as discrete, hash-verified entities.
5. **Hash-Bound, Single-Use Approval Gates**:
   - Existing approval sets `status = 'running'` on the task without cryptographically binding approval to an exact patch content SHA-256 hash, an expiration deadline, or single-use consumption.
6. **Workspace Runner Interface**:
   - No clean, bounded interface for executing allowlisted test commands in isolated disposable workspaces without exposing arbitrary shell execution.

---

## 3. Minimal Schema Design (Migration 0008)

To support Phase 4D without rewriting or destabilizing existing tables:
- **`agent_artifacts`**:
  - `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`
  - `organization_id uuid NOT NULL`
  - `project_id uuid`
  - `task_id uuid NOT NULL`
  - `step_id uuid`
  - `artifact_type text NOT NULL` (`patch_proposal`, `test_report`, `code_review`, `security_review`, `documentation`, `plan`)
  - `title text NOT NULL`
  - `content text NOT NULL`
  - `content_hash text NOT NULL` (SHA-256)
  - `size_bytes integer NOT NULL`
  - `review_status text NOT NULL DEFAULT 'pending'` (`pending`, `approved`, `rejected`)
  - `metadata jsonb NOT NULL DEFAULT '{}'::jsonb`
  - `created_by uuid NOT NULL REFERENCES public.app_users(id)`
  - Composite foreign keys for tenant safety.
  - Forced RLS + `moducraft_runtime` grants.
- **`agent_approvals`**:
  - `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`
  - `organization_id uuid NOT NULL`
  - `task_id uuid NOT NULL`
  - `step_id uuid`
  - `artifact_id uuid REFERENCES public.agent_artifacts(id) ON DELETE CASCADE`
  - `action text NOT NULL` (`apply_patch`, `execute_step`, `deploy`)
  - `target_content_hash text NOT NULL` (SHA-256 hash)
  - `status text NOT NULL DEFAULT 'pending'` (`pending`, `approved`, `rejected`, `expired`)
  - `required_role text NOT NULL DEFAULT 'admin'` (`admin`, `owner`)
  - `expires_at timestamptz NOT NULL`
  - `decided_at timestamptz`
  - `decision_reason text`
  - `approved_by uuid REFERENCES public.app_users(id)`
  - Forced RLS + `moducraft_runtime` grants.

---

## 4. Implementation Plan

1. **Step 1**: Author forward-only migration `db/migrations/0008_agent_workflows_artifacts.sql` with forced RLS and grants. Apply to development container.
2. **Step 2**: Implement typed agent contracts (`Planner`, `Coding`, `Testing`, `CodeReview`, `SecurityReview`, `Documentation`) in `apps/api/src/modules/workflows/agents/`.
3. **Step 3**: Implement controlled tool gateway (`ToolGateway`, `ToolRegistry`, safe workspace inspection, allowlisted test runner interface) in `apps/api/src/modules/workflows/tools/`.
4. **Step 4**: Implement artifact storage & versioning service and hash-bound approval service in `apps/api/src/modules/workflows/`.
5. **Step 5**: Integrate agent workflow orchestration with `AgentOrchestratorService`, `AIProviderService`, and `MemoryService`.
6. **Step 6**: Register API routes for workflow pipelines, artifact inspection, and approval decisions.
7. **Step 7**: Write comprehensive unit, integration, and adversarial security tests in `apps/api/test/workflows.test.ts`.
8. **Step 8**: Run all test suites, typechecks, and authorization tests. Document complete architecture and audit reports.
