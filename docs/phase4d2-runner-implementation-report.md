# ModuCraft Phase 4D.2: Real Isolated Workspace Runner & Patch Application Implementation Report

## 1. Executive Summary

This report documents the design, implementation, and adversarial validation of **ModuCraft Phase 4D.2: Real Isolated Workspace Runner & Approved Patch Application** at `G:\ModuCraft\moducraft-foundation`.

Phase 4D.2 addresses the execution boundary between autonomous AI agents and underlying host systems. Prior to Phase 4D.2, development relied on `MockWorkspaceRunner`, which was hardened in Phase 4D.1 to fail closed in production. Phase 4D.2 introduces:
1. **A production-grade, unprivileged ephemeral container runner (`DockerWorkspaceRunner`)** enforcing strict Linux isolation controls without mounting host directories or exposing daemon sockets.
2. **A deterministic fail-closed adapter (`FailClosedWorkspaceRunner`)** ensuring production environments never silently fall back to mock execution when isolation is unavailable or misconfigured.
3. **A unified configuration factory (`createWorkspaceRunner`)** dynamically selecting the appropriate backend with strict preflight verification.
4. **An immutable, hash-bound patch application service (`ApprovedPatchService`)** validating patch integrity, preventing approval replay, neutralizing directory traversal, and recording audit logs.
5. **A dedicated adversarial test suite (`runner.test.ts`)** demonstrating 100% pass rate (19/19 tests) across isolation, timeout, cancellation, network egress blocking, secret redaction, and patch application.

---

## 2. Host Environment Preflight Findings & Limitations

A comprehensive preflight inspection of the active host environment was conducted before implementation:

### 2.1 Host Telemetry
- **Host Operating System:** Microsoft Windows 10 Pro (Build 19045, 64-bit).
- **Node.js Runtime:** v22.23.1.
- **Docker Engine:** Docker Desktop v29.8.0 (build 88096ef).
- **Container Host Kernel:** Linux 6.18.40.1-microsoft-standard-WSL2 (x86_64).
- **Default Container Runtime:** `runc` (v1.4.3-0-gbb14dabe).
- **Available Security Modules:** `seccomp` (Profile: builtin), `cgroupns`, cgroups v2.
- **Available Base Images:** `alpine:latest` (ID: 294b683cb724), `postgres:17`.
- **Missing / Unavailable Tooling:** `podman` is not installed; microVM runtimes (`runsc` / gVisor, `kata`, `firecracker`) are **not** configured in the Docker Desktop runtime list (`Runtimes: io.containerd.runc.v2 nvidia runc`).

### 2.2 Host Isolation Defensibility Analysis
1. **Unprivileged Container Isolation (`runc`):**
   - The host Docker daemon successfully enforces `--read-only`, `--network none`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--user 1000:1000`, `--tmpfs`, and memory/CPU/PID limits.
   - This provides defense against accidental filesystem destruction, environment leakage, network attacks, and runaway processes.
2. **Defensibility Blocker for Multi-Tenant Untrusted Code:**
   - Standard `runc` shares the host Linux kernel (WSL2 VM kernel). For multi-tenant environments running untrusted, model-generated arbitrary code, containerization alone without a virtualization boundary (such as gVisor `runsc` or Firecracker microVMs) presents residual kernel exploit risks.
   - **Resolution:** `DockerWorkspaceRunner` supports a strict `requireMicroVM` configuration flag (`MODUCRAFT_REQUIRE_MICROVM=true`). When enabled, the runner checks the daemon runtime during preflight and strictly fails closed if `runsc` or `kata` is absent.

---

## 3. Architecture & Contracts

### 3.1 Runner Interface Hierarchy

```
                      ┌───────────────────────────────┐
                      │    IsolatedWorkspaceRunner    │
                      │          (Interface)          │
                      └──────────────┬────────────────┘
                                     │
         ┌───────────────────────────┼───────────────────────────┐
         ▼                           ▼                           ▼
┌───────────────────┐     ┌─────────────────────┐     ┌─────────────────────┐
│MockWorkspaceRunner│     │DockerWorkspaceRunner│     │FailClosedWorkspace..│
├───────────────────┤     ├─────────────────────┤     ├─────────────────────┤
│ • In-memory cache │     │ • Ephemeral container│    │ • Production guard  │
│ • Simulated flag  │     │ • --network none    │     │ • Always throws     │
│ • Test/Dev only   │     │ • --read-only rootfs│     │   ForbiddenError    │
│ • Banned in prod  │     │ • Unprivileged UID  │     │ • Never runs mock   │
└───────────────────┘     └─────────────────────┘     └─────────────────────┘
```

### 3.2 Key Type Contracts (`apps/api/src/modules/workflows/types.ts`)
```typescript
export type RunnerType = "mock" | "isolated_container" | "microvm" | "fail_closed";
export type IsolationLevel = "none" | "process" | "unprivileged_container" | "microvm";

export interface WorkspaceExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  isSimulated: boolean;
  runnerType: RunnerType;
  isolationLevel: IsolationLevel;
  timedOut?: boolean;
  cancelled?: boolean;
}

export interface IsolatedWorkspaceRunner {
  readonly runnerType: RunnerType;
  readonly isProductionSandbox: boolean;
  readonly isolationLevel: IsolationLevel;
  readFile(projectId: string, relativePath: string): Promise<string>;
  readManifest(projectId: string): Promise<Record<string, unknown>>;
  runAllowlistedCommand(
    projectId: string,
    command: AllowlistedCommand,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<WorkspaceExecutionResult>;
  cleanupWorkspace?(projectId: string): Promise<void>;
}
```

---

## 4. Implementation Details

### 4.1 Ephemeral Container Isolation (`DockerWorkspaceRunner`)
Located at `apps/api/src/modules/workflows/tools/docker-runner.ts`:
- **Zero Host Filesystem Mounts:** Host drives and directories (`C:\`, `G:\`, `/`, `.git`, `.env`) are **never mounted**. Instead, an isolated in-memory `tmpfs` volume is mounted at `/workspace` with `mode=0700,uid=1000,gid=1000`.
- **Zero Daemon Socket Exposure:** Neither `/var/run/docker.sock` nor Windows named pipes (`\\.\pipe\docker_engine`) are mounted into the container.
- **Rootless / Unprivileged Execution:** The container runs under unprivileged non-root credentials (`--user 1000:1000`) with `--security-opt no-new-privileges`.
- **Linux Capabilities Dropped:** All Linux capabilities are stripped (`--cap-drop ALL`).
- **Read-Only Root Filesystem:** Rootfs is mounted immutable (`--read-only`).
- **Strict Outbound Network Disabled:** `--network none` is attached by default. Container network interfaces cannot route traffic to local loopback, cloud metadata endpoints (`169.254.169.254`), internal subnets, or public internet.
- **Resource Constraints:**
  - Memory: `--memory 512m`
  - CPU: `--cpus 1.0`
  - PID quota: `--pids-limit 64`
  - Timeout: Configurable (default 15s, maximum 30s).
- **Process Tree Kill:** On timeout or cancellation via `AbortSignal`, the runner terminates both the child process and issues `docker kill <containerName>` to ensure no orphan processes remain on the host daemon.
- **Output Sanitization & Bounding:** Stdout and stderr are capped at `maxOutputBytes` (256 KB) and automatically scrubbed with `redactSensitiveData` before returning to agents or persisting in audit logs.

### 4.2 Production Safe Guard (`FailClosedWorkspaceRunner`)
Located at `apps/api/src/modules/workflows/tools/docker-runner.ts`:
- When running in production (`NODE_ENV === "production"`) with misconfigured or missing runner settings, `createWorkspaceRunner()` returns `FailClosedWorkspaceRunner`.
- Any attempt to execute commands or inspect files immediately throws `ForbiddenError` with an actionable failure reason.
- **Eliminates silent fallback to mock runners.**

### 4.3 Approved Patch Application Service (`ApprovedPatchService`)
Located at `apps/api/src/modules/workflows/patch.service.ts`:
- **Cryptographic Hash Re-Verification:** Recomputes the SHA-256 hash of the artifact content at application time and compares against `artifact.contentHash` and `input.expectedHash`. Rejects modified or tampered patches with `ConflictError`.
- **Path Traversal & Credential File Protection:** Parses unified diff headers (`--- a/...`, `+++ b/...`) and validates every file path against `validateWorkspaceRelativePath()`. Rejects directory traversal (`..`), percent-encoded sequences (`%2e%2e`), null bytes, and sensitive files (`.env*`, `.git/*`, `.ssh/*`, `.aws/*`, private keys, `.npmrc`).
- **Binary Patch Rejection:** Inspects patch content and rejects binary diffs (`GIT binary patch` or null bytes) with `ValidationError`.
- **Atomic Single-Use Consumption:** Invokes `ApprovalsService.verifyAndConsumeApproval()`, which executes an atomic `SELECT ... FOR UPDATE` row-lock and updates `status = 'consumed'`. Any duplicate attempt or replayed approval immediately fails with `ConflictError`.
- **Audit Event Emission:** Records `patch.applied` in `agent_task_events` via `moducraft_record_audit_event`.

---

## 5. Verification Matrix & Test Evidence

### 5.1 Test Execution Summary
All tests were executed against the live PostgreSQL database (`moducraft-postgres` on `127.0.0.1:5432`) and local Docker daemon:

| Test Suite File | Subtests | Passed | Failed | Description |
| :--- | :--- | :--- | :--- | :--- |
| `test/runner.test.ts` | **19** | **19** | **0** | **Phase 4D.2**: Production fail-closed, Docker runner isolation, network egress, timeout killer, patch service |
| `test/workflows.test.ts` | **24** | **24** | **0** | Phase 4D/4D.1: Workflows, atomic single-use approvals, path safety, tool gateway role checks |
| `test/providers.test.ts` | **13** | **13** | **0** | Phase 4B: Provider abstraction, fallback, rate limits |
| `test/memory.test.ts` | **17** | **17** | **0** | Phase 4C: Threads, scoped memory, context assembler, secret redactor |
| `test/orchestrator.test.ts` | **10** | **10** | **0** | Phase 4A: State machine, step transitions, retries |
| `test/tenancy.test.ts` | **17** | **17** | **0** | Phase 2: Tenant isolation, NOBYPASSRLS, cross-tenant denial |
| `test/auth.test.ts` | **11** | **11** | **0** | Phase 2: JWT validation, claims, session context |
| `test/secrets.test.ts` | **12** | **12** | **0** | Phase 2: Envelope encryption, key derivation |
| `test/audit.test.ts` | **10** | **10** | **0** | Phase 2: Audit logging, actor verification |
| `test/recovery.test.ts` | **12** | **12** | **0** | Phase 4A: Task crash recovery and batch bounds |
| `test/organizations.test.ts` | **8** | **8** | **0** | Phase 2: Org CRUD, memberships, invite flows |
| `test/projects.test.ts` | **6** | **6** | **0** | Phase 2: Project scoping and metadata |
| **Total Test Count** | **159** | **159** | **0** | **100% Pass Rate across all 12 test suites** |

### 5.2 Specific Phase 4D.2 Test Cases (`test/runner.test.ts`)
- **Test 1.1:** Refuses mock runner in production (`NODE_ENV=production`) and returns `FailClosedWorkspaceRunner` (PASSED).
- **Test 1.2:** `FailClosedWorkspaceRunner` strictly blocks command execution, file reads, and manifest inspection with `ForbiddenError` (PASSED).
- **Test 1.3:** Config resolver validates operational bounds: 512MB RAM, 1.0 CPU, 15s timeout, network disabled (PASSED).
- **Test 1.4:** When `MODUCRAFT_REQUIRE_MICROVM=true`, rejects execution on host `runc` daemon with `ForbiddenError` (PASSED).
- **Test 2.1:** Docker preflight check confirms engine connectivity and reports default runtime (`runc`) (PASSED).
- **Test 2.2:** Command policy allowlist strictly blocks arbitrary command execution (`rm -rf /`, `cat /etc/shadow`) (PASSED).
- **Test 2.3:** Runs allowlisted command in unprivileged container without host mounts, reporting `isSimulated: false` and `isolationLevel: "unprivileged_container"` (PASSED).
- **Test 2.4:** Network isolation test confirms `--network none` blocks external outbound traffic (PASSED).
- **Test 2.5:** Execution timeout test confirms process tree termination after 1.5s timeout with `timedOut: true` and exit code 124 (PASSED).
- **Test 2.6:** Cancellation test confirms `AbortSignal` terminates container with `cancelled: true` and exit code 130 (PASSED).
- **Test 2.7:** Redacts API keys (`sk-proj-...`) and connection strings (`postgresql://...`) from container stdout/stderr (PASSED).
- **Test 2.8:** Confirms host environment variables (`MODUCRAFT_SUPER_SECRET`, `DATABASE_URL`) are isolated from container (PASSED).
- **Test 3.1:** Rejects patch application if artifact content hash does not match expected hash (PASSED).
- **Test 3.2:** Rejects binary diffs with `ValidationError` (PASSED).
- **Test 3.3:** Rejects path traversal (`../../etc/passwd`) and sensitive files (`.env`) in patch target files (PASSED).
- **Test 3.4:** Valid patch with human approval succeeds on first application; second application fails with `ConflictError` (replay protection) (PASSED).
- **Test 3.5:** Rejects cross-tenant patch application (Org Beta cannot apply Org Alpha patch) (PASSED).
- **Test 4.1:** Mock runner outputs are explicitly tagged `isSimulated: true`, `runnerType: "mock"`, `isolationLevel: "none"` (PASSED).
- **Test 4.2:** Docker runner outputs are explicitly tagged `isSimulated: false`, `runnerType: "isolated_container"`, `isolationLevel: "unprivileged_container"` (PASSED).

### 5.3 Monorepo Typecheck & Production Build
- **Static Typecheck:** `pnpm typecheck` passed with **0 errors** across all workspace projects (`apps/api`, `apps/web`).
- **Production Build:** `pnpm build` succeeded with exit code 0 (Fastify API compiled via `tsc`, Next.js 15.5.27 production build succeeded).

---

## 6. Changed Files & Components

| File Path | Description |
| :--- | :--- |
| `apps/api/src/modules/workflows/types.ts` | Expanded runner interfaces: `WorkspaceExecutionResult`, `IsolationLevel`, `WorkspaceRunnerConfig`, `ApplyPatchInput`, `ApplyPatchResult`. |
| `apps/api/src/modules/workflows/tools/docker-runner.ts` | **New**: `DockerWorkspaceRunner` (ephemeral container, unprivileged UID, `--network none`, `--read-only`, tmpfs workspace, timeout killer) & `FailClosedWorkspaceRunner`. |
| `apps/api/src/modules/workflows/tools/runner-factory.ts` | **New**: `createWorkspaceRunner()` and `resolveRunnerConfig()` factory with production fail-closed rules. |
| `apps/api/src/modules/workflows/patch.service.ts` | **New**: `ApprovedPatchService` for hash-verified, single-use approved patch application. |
| `apps/api/src/modules/workflows/tools/sandbox.ts` | Updated `MockWorkspaceRunner` to implement enriched `IsolatedWorkspaceRunner` interface. |
| `apps/api/src/modules/workflows/tools/gateway.ts` | Integrated `createWorkspaceRunner()` by default; exposes `isolationLevel` in tool outputs. |
| `apps/api/src/modules/workflows/workflow.service.ts` | Integrated `ApprovedPatchService` into `completeWorkflowAfterApproval()`. |
| `apps/api/src/modules/workflows/index.ts` | Exported `DockerWorkspaceRunner`, `FailClosedWorkspaceRunner`, `createWorkspaceRunner`, and `ApprovedPatchService`. |
| `apps/api/test/runner.test.ts` | **New**: 19 adversarial tests for runner isolation, fail-closed boundaries, and patch security. |

---

## 7. Residual Risks & Production Deployment Guide

### 7.1 Residual Host Risks
1. **Kernel Surface Sharing under `runc`:**
   - Although `--cap-drop ALL`, `--security-opt no-new-privileges`, and `--read-only` significantly constrain container capabilities, `runc` containers share the host Linux kernel. In multi-tenant environments with hostile workloads, zero-day kernel vulnerabilities could theoretically facilitate container breakout.
2. **Docker Socket Management:**
   - The API server requires communication with the Docker daemon CLI on the host. In production, the API service must run under a dedicated OS service account with minimal group privileges, and the Docker daemon socket must NEVER be mounted into any application container.

### 7.2 Production Hardening Instructions (gVisor / Firecracker)
To upgrade the container runtime from `runc` to gVisor (`runsc`) on a production Linux host:
1. Install `runsc` via standard packages:
   ```bash
   sudo apt-get install -y runsc
   sudo runsc install
   sudo systemctl restart docker
   ```
2. Set environment variables for ModuCraft API:
   ```env
   NODE_ENV=production
   MODUCRAFT_WORKSPACE_RUNNER=docker
   MODUCRAFT_REQUIRE_MICROVM=true
   MODUCRAFT_DOCKER_IMAGE=node:20-alpine
   ```
3. When `MODUCRAFT_REQUIRE_MICROVM=true`, `DockerWorkspaceRunner` validates that the daemon default runtime is `runsc` or `kata` during preflight, ensuring hard microVM boundaries.
