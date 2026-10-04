import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { createDatabasePool } from "../src/db/pool.js";
import { withAuthenticatedContext } from "../src/db/transaction.js";
import { getTestDatabaseUrls } from "./helpers/test-db-guard.js";
import {
  createWorkspaceRunner,
  resolveRunnerConfig,
} from "../src/modules/workflows/tools/runner-factory.js";
import {
  DockerWorkspaceRunner,
  FailClosedWorkspaceRunner,
} from "../src/modules/workflows/tools/docker-runner.js";
import { MockWorkspaceRunner } from "../src/modules/workflows/tools/sandbox.js";
import { ApprovedPatchService } from "../src/modules/workflows/patch.service.js";
import { ApprovalsService } from "../src/modules/workflows/approvals.service.js";
import { ArtifactsService } from "../src/modules/workflows/artifacts.service.js";
import {
  ForbiddenError,
  ValidationError,
  ConflictError,
  NotFoundError,
} from "../src/errors/app-errors.js";

const { Pool } = pg;

describe("Phase 4D.3: Real Isolated Workspace Runner & Patch Lifecycle Verification", () => {
  const { runtimeDbUrl, superuserDbUrl } = getTestDatabaseUrls();

  const issuer = "https://auth.moducraft.test";

  // Test identities (isolated ffffffff and 12121212 prefixes)
  const userAdminId = "ffffffff-1111-4000-8000-000000000001";
  const userBetaId = "ffffffff-2222-4000-8000-000000000002";
  const orgAlphaId = "12121212-aaaa-4000-8000-000000000001";
  const orgBetaId = "12121212-bbbb-4000-8000-000000000002";
  const projAlphaId = "34343434-aaaa-4000-8000-000000000001";
  const taskAlphaId = "56565656-aaaa-4000-8000-000000000001";

  let runtimePool: pg.Pool;
  let adminPool: pg.Pool;
  let approvalsService: ApprovalsService;
  let artifactsService: ArtifactsService;
  let patchService: ApprovedPatchService;
  let testWorkspaceRunner: MockWorkspaceRunner;

  before(async () => {
    runtimePool = createDatabasePool(runtimeDbUrl);
    adminPool = new Pool({ connectionString: superuserDbUrl, max: 2 });
    approvalsService = new ApprovalsService();
    artifactsService = new ArtifactsService();
    testWorkspaceRunner = new MockWorkspaceRunner();
    patchService = new ApprovedPatchService(approvalsService, artifactsService, testWorkspaceRunner);

    // Seed test users
    await adminPool.query(
      `
      INSERT INTO app_users(id, identity_issuer, identity_subject, email, display_name)
      VALUES 
        ($1, $3, 'sub-runner-admin', 'runner-admin@moducraft.test', 'Runner Admin'),
        ($2, $3, 'sub-runner-beta', 'runner-beta@moducraft.test', 'Runner Beta')
      ON CONFLICT (id) DO NOTHING;
      `,
      [userAdminId, userBetaId, issuer]
    );

    // Seed test organizations
    await adminPool.query(
      `
      INSERT INTO organizations(id, name, slug, created_by)
      VALUES 
        ($1, 'Runner Org Alpha', 'runner-org-alpha', $3),
        ($2, 'Runner Org Beta', 'runner-org-beta', $4)
      ON CONFLICT (id) DO NOTHING;
      `,
      [orgAlphaId, orgBetaId, userAdminId, userBetaId]
    );

    // Seed memberships (Admin in Org Alpha, Member in Org Beta)
    await adminPool.query(
      `
      INSERT INTO organization_memberships(organization_id, user_id, role)
      VALUES 
        ($1, $2, 'admin'),
        ($3, $4, 'member')
      ON CONFLICT (organization_id, user_id) DO NOTHING;
      `,
      [orgAlphaId, userAdminId, orgBetaId, userBetaId]
    );

    // Seed test project
    await adminPool.query(
      `
      INSERT INTO projects(id, organization_id, name, slug, description, created_by)
      VALUES ($1, $2, 'Runner Alpha Project', 'runner-alpha-project', 'Test project for runner', $3)
      ON CONFLICT (id) DO NOTHING;
      `,
      [projAlphaId, orgAlphaId, userAdminId]
    );

    // Seed test task
    await adminPool.query(
      `
      INSERT INTO agent_tasks(id, organization_id, project_id, title, task_type, status, created_by, input_data)
      VALUES ($1, $2, $3, 'Runner Integration Task', 'workflow', 'running', $4, '{"test": true}'::jsonb)
      ON CONFLICT (id) DO NOTHING;
      `,
      [taskAlphaId, orgAlphaId, projAlphaId, userAdminId]
    );
  });
  after(async () => {
    if (adminPool) {
      await adminPool.query(`DELETE FROM patch_application_journals WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM agent_approvals WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM agent_artifacts WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM agent_tasks WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM projects WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM organization_memberships WHERE organization_id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM organizations WHERE id IN ($1, $2);`, [orgAlphaId, orgBetaId]);
      await adminPool.query(`DELETE FROM app_users WHERE id IN ($1, $2);`, [userAdminId, userBetaId]);
      await adminPool.end();
    }
    if (runtimePool) {
      await runtimePool.end();
    }
  });

  // ===========================================================================
  // Suite 1: Production Configuration & Fail-Closed Boundaries
  // ===========================================================================
  describe("1. Production Configuration & Fail-Closed Boundaries", () => {
    it("1.1 should return FailClosedWorkspaceRunner when NODE_ENV is production and runner is mock or unset", () => {
      const origEnv = process.env.NODE_ENV;
      const origRunner = process.env.MODUCRAFT_WORKSPACE_RUNNER;
      try {
        process.env.NODE_ENV = "production";
        delete process.env.MODUCRAFT_WORKSPACE_RUNNER;

        const runner = createWorkspaceRunner();
        assert.equal(runner.runnerType, "fail_closed");
        assert.equal(runner.isProductionSandbox, true);
        assert.equal(runner.isolationLevel, "none");
      } finally {
        process.env.NODE_ENV = origEnv;
        if (origRunner) process.env.MODUCRAFT_WORKSPACE_RUNNER = origRunner;
      }
    });

    it("1.2 should strictly reject command execution and file access under FailClosedWorkspaceRunner", async () => {
      const runner = new FailClosedWorkspaceRunner("Explicit production test block");

      await assert.rejects(
        async () => runner.readFile("test-project", "package.json"),
        (err: any) => err instanceof ForbiddenError && err.message.includes("FailClosedWorkspaceRunner")
      );

      await assert.rejects(
        async () => runner.readManifest("test-project"),
        (err: any) => err instanceof ForbiddenError && err.message.includes("FailClosedWorkspaceRunner")
      );

      await assert.rejects(
        async () => runner.runAllowlistedCommand("test-project", "test"),
        (err: any) => err instanceof ForbiddenError && err.message.includes("FailClosedWorkspaceRunner")
      );
    });

    it("1.3 should resolve runner config with safe default limits and parameters", () => {
      const config = resolveRunnerConfig();
      assert.equal(typeof config.maxMemoryMb, "number");
      assert.ok(config.maxMemoryMb! >= 256);
      assert.equal(typeof config.maxCpu, "number");
      assert.ok(config.maxCpu! >= 0.5);
      assert.equal(typeof config.timeoutMs, "number");
      assert.equal(config.networkDisabled, true);
      assert.equal(config.containerUid, 1000);
      assert.equal(config.containerGid, 1000);
    });

    it("1.4 should reject execution when microVM isolation is required but host only provides runc", async () => {
      const runner = new DockerWorkspaceRunner({
        requireMicroVM: true,
      });

      // runc on Docker Desktop does not satisfy microVM requirement
      await assert.rejects(
        async () => runner.runAllowlistedCommand("test-project", "test"),
        (err: any) => err instanceof ForbiddenError && err.message.includes("MicroVM isolation is required")
      );
    });
  });

  // ===========================================================================
  // Suite 2: Real Docker Isolated Workspace Runner (Integration Tests)
  // ===========================================================================
  describe("2. Real Docker Isolated Workspace Runner", () => {
    let dockerRunner: DockerWorkspaceRunner;
    let isDockerAvailable = false;

    before(async () => {
      dockerRunner = new DockerWorkspaceRunner({
        requireMicroVM: false,
        timeoutMs: 15000,
        dockerImage: "alpine:latest",
      });

      const preflight = await dockerRunner.preflightCheck();
      isDockerAvailable = preflight.ok;
    });

    it("2.1 should verify Docker daemon preflight check on host", async (t) => {
      const preflight = await dockerRunner.preflightCheck();
      assert.equal(typeof preflight.ok, "boolean");
      assert.equal(typeof preflight.runtime, "string");
      if (!preflight.ok) {
        t.skip(`Docker daemon unavailable: ${preflight.error}`);
        return;
      }
      assert.ok(preflight.ok, `Docker preflight should pass on host (found runtime: ${preflight.runtime})`);
    });

    it("2.2 should reject non-allowlisted arbitrary commands (command policy)", async () => {
      await assert.rejects(
        async () => (dockerRunner as any).runAllowlistedCommand("default", "rm -rf /"),
        (err: any) => err instanceof ForbiddenError && err.message.includes("not in the allowlisted sandbox commands")
      );

      await assert.rejects(
        async () => (dockerRunner as any).runAllowlistedCommand("default", "cat /etc/shadow"),
        (err: any) => err instanceof ForbiddenError
      );
    });

    it("2.3 should execute allowlisted command in unprivileged container without host mounts", async (t) => {
      if (!isDockerAvailable) {
        t.skip("Docker daemon unavailable or not configured");
        return;
      }

      const result = await dockerRunner.runAllowlistedCommand("default", "test");
      assert.equal(typeof result.exitCode, "number");
      assert.equal(result.isSimulated, false);
      assert.equal(result.runnerType, "isolated_container");
      assert.equal(result.isolationLevel, "unprivileged_container");
      assert.equal(typeof result.durationMs, "number");
      assert.ok(result.durationMs > 0);
    });

    it("2.4 should enforce network isolation (--network none)", async (t) => {
      if (!isDockerAvailable) {
        t.skip("Docker daemon unavailable or not configured");
        return;
      }

      // Stage a file that attempts network connection inside container
      dockerRunner.setFile(
        "net-test",
        "package.json",
        JSON.stringify({ name: "net-test", scripts: { test: "nc -z -w 1 1.1.1.1 53" } })
      );

      const result = await dockerRunner.runAllowlistedCommand("net-test", "test");
      // Under --network none, nc cannot connect to external network and exits non-zero
      assert.notEqual(result.exitCode, 0);
      assert.equal(result.isSimulated, false);
      assert.equal(result.isolationLevel, "unprivileged_container");
    });

    it("2.5 should terminate process tree on execution timeout", async (t) => {
      if (!isDockerAvailable) {
        t.skip("Docker daemon unavailable or not configured");
        return;
      }

      const fastTimeoutRunner = new DockerWorkspaceRunner({
        timeoutMs: 1500, // 1.5s timeout
        requireMicroVM: false,
      });

      fastTimeoutRunner.setFile(
        "timeout-test",
        "package.json",
        JSON.stringify({ name: "timeout-test", scripts: { test: "sleep 10" } })
      );

      const result = await fastTimeoutRunner.runAllowlistedCommand("timeout-test", "test", 1500);
      assert.equal(result.timedOut, true);
      assert.equal(result.exitCode, 124);
      assert.match(result.stderr, /Execution timed out/);
    });

    it("2.6 should terminate process tree on cancellation signal", async (t) => {
      if (!isDockerAvailable) {
        t.skip("Docker daemon unavailable or not configured");
        return;
      }

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 500);

      dockerRunner.setFile(
        "cancel-test",
        "package.json",
        JSON.stringify({ name: "cancel-test", scripts: { test: "sleep 10" } })
      );

      const result = await dockerRunner.runAllowlistedCommand(
        "cancel-test",
        "test",
        10000,
        controller.signal
      );
      assert.equal(result.cancelled, true);
      assert.equal(result.exitCode, 130);
      assert.match(result.stderr, /cancelled/i);
    });

    it("2.7 should redact credentials and sensitive secrets from stdout/stderr outputs", async (t) => {
      if (!isDockerAvailable) {
        t.skip("Docker daemon unavailable or not configured");
        return;
      }

      dockerRunner.setFile(
        "redact-test",
        "package.json",
        JSON.stringify({
          name: "redact-test",
          scripts: {
            test: "echo 'SECRET_TOKEN: sk-proj-1234567890abcdef1234567890' && echo 'DB: postgresql://admin:hunter2@db.internal:5432/prod' >&2",
          },
        })
      );

      const result = await dockerRunner.runAllowlistedCommand("redact-test", "test");
      assert.ok(!result.stdout.includes("sk-proj-1234567890abcdef1234567890"));
      assert.match(result.stdout, /\[REDACTED_API_KEY\]/);
      assert.ok(!result.stderr.includes("hunter2"));
      assert.match(result.stderr, /\[REDACTED_CONNECTION_STRING\]/);
    });

    it("2.8 should isolate host environment variables from sandbox container", async (t) => {
      if (!isDockerAvailable) {
        t.skip("Docker daemon unavailable or not configured");
        return;
      }

      process.env.MODUCRAFT_SUPER_SECRET = "TOP_SECRET_HOST_KEY_999";

      dockerRunner.setFile(
        "env-test",
        "package.json",
        JSON.stringify({
          name: "env-test",
          scripts: {
            test: "env",
          },
        })
      );

      const result = await dockerRunner.runAllowlistedCommand("env-test", "test");
      delete process.env.MODUCRAFT_SUPER_SECRET;

      assert.ok(!result.stdout.includes("TOP_SECRET_HOST_KEY_999"));
      assert.ok(!result.stdout.includes("DATABASE_URL"));
    });

    it("2.9 should verify non-root unprivileged UID:GID (1000:1000) inside container", async (t) => {
      if (!isDockerAvailable) {
        t.skip("Docker daemon unavailable or not configured");
        return;
      }

      dockerRunner.setFile(
        "uid-test",
        "package.json",
        JSON.stringify({
          name: "uid-test",
          scripts: {
            test: "echo UID=$(id -u) GID=$(id -g)",
          },
        })
      );

      const result = await dockerRunner.runAllowlistedCommand("uid-test", "test");
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /UID=1000/);
      assert.match(result.stdout, /GID=1000/);
      assert.ok(!result.stdout.includes("UID=0"), "Workload must NOT run as root (UID 0)");
    });

    it("2.10 should verify read-only root filesystem (--read-only)", async (t) => {
      if (!isDockerAvailable) {
        t.skip("Docker daemon unavailable or not configured");
        return;
      }

      dockerRunner.setFile(
        "ro-test",
        "package.json",
        JSON.stringify({
          name: "ro-test",
          scripts: {
            test: "touch /cant_write_here",
          },
        })
      );

      const result = await dockerRunner.runAllowlistedCommand("ro-test", "test");
      assert.notEqual(result.exitCode, 0, "Writing to rootfs must fail under --read-only");
      assert.match(result.stderr, /Read-only file system/i);
    });

    it("2.11 should confirm zero host mounts and Docker socket isolation", async (t) => {
      if (!isDockerAvailable) {
        t.skip("Docker daemon unavailable or not configured");
        return;
      }

      dockerRunner.setFile(
        "mount-isolation-test",
        "package.json",
        JSON.stringify({
          name: "mount-isolation-test",
          scripts: {
            test: "ls /var/run/docker.sock /root /etc/shadow 2>&1 || exit 42",
          },
        })
      );

      const result = await dockerRunner.runAllowlistedCommand("mount-isolation-test", "test");
      // Must fail or report not found: docker.sock is strictly isolated
      assert.ok(
        result.exitCode !== 0 || result.stdout.includes("No such file") || result.stderr.includes("No such file"),
        "Host Docker socket and secrets must not be mounted"
      );
    });

    it("2.12 should enforce bounded stdout/stderr outputs and truncate overflow", async (t) => {
      if (!isDockerAvailable) {
        t.skip("Docker daemon unavailable or not configured");
        return;
      }

      const cappedRunner = new DockerWorkspaceRunner({
        maxOutputBytes: 1024, // 1 KB bound
        requireMicroVM: false,
      });

      cappedRunner.setFile(
        "overflow-test",
        "package.json",
        JSON.stringify({
          name: "overflow-test",
          scripts: {
            // Generate 10KB of output
            test: "head -c 10000 /dev/zero | tr '\\0' 'A'",
          },
        })
      );

      const result = await cappedRunner.runAllowlistedCommand("overflow-test", "test");
      assert.match(result.stdout, /\[OUTPUT TRUNCATED: Exceeded max allowed size\]/);
      assert.ok(result.stdout.length <= 1500);
    });

    it("2.13 should clean up disposable container and leave no leaked containers", async (t) => {
      if (!isDockerAvailable) {
        t.skip("Docker daemon unavailable or not configured");
        return;
      }

      // Query running moducraft containers before
      const containersBefore = execSync("docker ps --filter name=moducraft-sandbox -q", {
        encoding: "utf-8",
      }).trim();

      await dockerRunner.runAllowlistedCommand("default", "test");

      // Query running moducraft containers after
      const containersAfter = execSync("docker ps --filter name=moducraft-sandbox -q", {
        encoding: "utf-8",
      }).trim();

      assert.equal(containersAfter, containersBefore, "Container must be cleanly removed via --rm");
    });
  });

  // ===========================================================================
  // Suite 3: Approved Patch Service & Hash-Bound Security
  // ===========================================================================
  describe("3. Approved Patch Service & Hash-Bound Security", () => {
    it("3.1 should reject patch application if patch artifact content hash does not match (tampered patch)", async () => {
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const patchContent = `--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1,3 +1,3 @@\n-export function greet() {}\n+export function greet() { return 'hello'; }\n`;
        const correctHash = crypto.createHash("sha256").update(patchContent).digest("hex");

        const artifact = await artifactsService.createArtifact(
          tx,
          userAdminId,
          orgAlphaId,
          {
            projectId: projAlphaId,
            taskId: taskAlphaId,
            artifactType: "patch_proposal",
            title: "Tampered Patch Test",
            content: patchContent,
          }
        );

        // Attempting to apply with forged expected hash
        await assert.rejects(
          async () =>
            patchService.applyApprovedPatch(
              tx,
              {
                taskId: taskAlphaId,
                projectId: projAlphaId,
                patchArtifactId: artifact.id,
                expectedHash: "0000000000000000000000000000000000000000000000000000000000000000",
              },
              userAdminId,
              orgAlphaId
            ),
          (err: any) => err instanceof ConflictError && err.message.includes("hash mismatch")
        );
      });
    });

    it("3.2 should reject binary patches with ValidationError", async () => {
      const fakeArtifact: any = {
        content: "GIT binary patch\nlzx1234567890abcdef",
        contentHash: "hash123",
      };

      assert.throws(
        () => patchService.validatePatchIntegrity(fakeArtifact),
        (err: any) => err instanceof ValidationError && err.message.includes("Binary patches are not supported")
      );
    });

    it("3.3 should reject patch target file path traversal and sensitive files", async () => {
      const traversalPatch: any = {
        content: `--- a/src/index.ts\n+++ b/../../etc/passwd\n@@ -1 +1 @@\n+root:x:0:0\n`,
        contentHash: crypto.createHash("sha256").update(`--- a/src/index.ts\n+++ b/../../etc/passwd\n@@ -1 +1 @@\n+root:x:0:0\n`).digest("hex"),
      };

      assert.throws(
        () => patchService.validatePatchIntegrity(traversalPatch),
        (err: any) => err instanceof ForbiddenError && err.message.includes("Path traversal")
      );

      const envPatch: any = {
        content: `--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n+SECRET=injected\n`,
        contentHash: crypto.createHash("sha256").update(`--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n+SECRET=injected\n`).digest("hex"),
      };

      assert.throws(
        () => patchService.validatePatchIntegrity(envPatch),
        (err: any) => err instanceof ForbiddenError && err.message.includes("Access to sensitive")
      );
    });

    it("3.4 should successfully apply patch with valid approval, genuinely update workspace files, and reject replay on second consumption", async () => {
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        // Prepare patch matching default src/index.ts
        const patchContent = [
          "--- a/src/index.ts",
          "+++ b/src/index.ts",
          "@@ -1,3 +1,4 @@",
          " export function greet(name: string): string {",
          "+  console.log('runner patch verified', name);",
          "   return `Hello, ${name}!`;",
          " }",
          "",
        ].join("\n");
        const contentHash = crypto.createHash("sha256").update(patchContent).digest("hex");

        const artifact = await artifactsService.createArtifact(
          tx,
          userAdminId,
          orgAlphaId,
          {
            projectId: projAlphaId,
            taskId: taskAlphaId,
            artifactType: "patch_proposal",
            title: "Valid Patch Test",
            content: patchContent,
          }
        );

        // Create approval request
        const approval = await approvalsService.createApprovalRequest(tx, orgAlphaId, {
          taskId: taskAlphaId,
          artifactId: artifact.id,
          action: "apply_patch",
          targetContentHash: contentHash,
          requiredRole: "admin",
          expiresInSeconds: 3600,
        });

        // Admin approves
        await approvalsService.decideApproval(
          tx,
          approval.id,
          userAdminId,
          orgAlphaId,
          { decision: "approved", reason: "LGTM" }
        );

        // First application: succeeds, modifies workspace file, and atomically consumes approval
        const result = await patchService.applyApprovedPatch(
          tx,
          {
            taskId: taskAlphaId,
            projectId: projAlphaId,
            patchArtifactId: artifact.id,
            expectedHash: contentHash,
          },
          userAdminId,
          orgAlphaId
        );

        assert.equal(result.success, true);
        assert.equal(result.contentHash, contentHash);
        assert.deepEqual(result.filesModified, ["src/index.ts"]);

        // Genuinely verify the workspace file was modified!
        const updatedFile = await testWorkspaceRunner.readFile(projAlphaId, "src/index.ts");
        assert.ok(updatedFile.includes("runner patch verified"));

        // Second application attempt with same approval: REJECTED with ConflictError (replay prevented)
        await assert.rejects(
          async () =>
            patchService.applyApprovedPatch(
              tx,
              {
                taskId: taskAlphaId,
                projectId: projAlphaId,
                patchArtifactId: artifact.id,
                expectedHash: contentHash,
              },
              userAdminId,
              orgAlphaId
            ),
          (err: any) => err instanceof ConflictError && err.message.includes("already been consumed")
        );
      });
    });

    it("3.5 should reject cross-tenant patch application (Org Beta cannot apply Org Alpha patch)", async () => {
      await withAuthenticatedContext(runtimePool, userBetaId, async (tx) => {
        // Attempting to apply Org Alpha's patch using Org Beta context
        await assert.rejects(
          async () =>
            patchService.applyApprovedPatch(
              tx,
              {
                taskId: taskAlphaId,
                projectId: projAlphaId,
                patchArtifactId: "00000000-0000-0000-0000-000000000000",
                expectedHash: "abc",
              },
              userBetaId,
              orgBetaId
            ),
          (err: any) => err instanceof NotFoundError
        );
      });
    });

    it("3.6 should reject patch application and preserve pre-existing user modifications if file content has diverged", async () => {
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        // Set pre-existing custom content in workspace
        const preExistingContent = "export function customUserCode() { return 42; }\n";
        testWorkspaceRunner.setFile(projAlphaId, "src/custom.ts", preExistingContent);

        // Patch assumes completely different context
        const patchContent = [
          "--- a/src/custom.ts",
          "+++ b/src/custom.ts",
          "@@ -1,2 +1,3 @@",
          " export function differentContext() {",
          "+  console.log('injected');",
          "   return 0;",
          " }",
          "",
        ].join("\n");

        const contentHash = crypto.createHash("sha256").update(patchContent).digest("hex");

        const artifact = await artifactsService.createArtifact(tx, userAdminId, orgAlphaId, {
          projectId: projAlphaId,
          taskId: taskAlphaId,
          artifactType: "patch_proposal",
          title: "Diverged Patch Test",
          content: patchContent,
        });

        const approval = await approvalsService.createApprovalRequest(tx, orgAlphaId, {
          taskId: taskAlphaId,
          artifactId: artifact.id,
          action: "apply_patch",
          targetContentHash: contentHash,
          requiredRole: "admin",
          expiresInSeconds: 3600,
        });

        await approvalsService.decideApproval(tx, approval.id, userAdminId, orgAlphaId, {
          decision: "approved",
          reason: "approved",
        });

        // Application MUST throw ConflictError due to context mismatch
        await assert.rejects(
          async () =>
            patchService.applyApprovedPatch(
              tx,
              {
                taskId: taskAlphaId,
                projectId: projAlphaId,
                patchArtifactId: artifact.id,
                expectedHash: contentHash,
              },
              userAdminId,
              orgAlphaId
            ),
          (err: any) =>
            err instanceof ConflictError &&
            err.message.includes("Pre-existing user modifications preserved")
        );

        // Verify pre-existing content was untouched!
        const retainedContent = await testWorkspaceRunner.readFile(projAlphaId, "src/custom.ts");
        assert.equal(retainedContent, preExistingContent);

        // Verify approval was NOT consumed
        const approvalCheck = await approvalsService.getApproval(tx, approval.id);
        assert.equal(approvalCheck.status, "approved");
      });
    });

    it("3.7 should atomically roll back all files if any file in a multi-file patch fails verification", async () => {
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const file1Original = "export const fileOne = 1;\n";
        const file2Original = "export const fileTwo = 2;\n";
        testWorkspaceRunner.setFile(projAlphaId, "src/file1.ts", file1Original);
        testWorkspaceRunner.setFile(projAlphaId, "src/file2.ts", file2Original);

        // Patch modifies file1 (matches) and file2 (diverged context)
        const multiDiff = [
          "--- a/src/file1.ts",
          "+++ b/src/file1.ts",
          "@@ -1 +1,2 @@",
          " export const fileOne = 1;",
          "+export const fileOneAdded = 100;",
          "--- a/src/file2.ts",
          "+++ b/src/file2.ts",
          "@@ -1 +1,2 @@",
          " export const divergentOld = 'WRONG';",
          "+export const fileTwoAdded = 200;",
          "",
        ].join("\n");

        const contentHash = crypto.createHash("sha256").update(multiDiff).digest("hex");

        const artifact = await artifactsService.createArtifact(tx, userAdminId, orgAlphaId, {
          projectId: projAlphaId,
          taskId: taskAlphaId,
          artifactType: "patch_proposal",
          title: "Multi-file Atomic Rollback Test",
          content: multiDiff,
        });

        const approval = await approvalsService.createApprovalRequest(tx, orgAlphaId, {
          taskId: taskAlphaId,
          artifactId: artifact.id,
          action: "apply_patch",
          targetContentHash: contentHash,
          requiredRole: "admin",
          expiresInSeconds: 3600,
        });

        await approvalsService.decideApproval(tx, approval.id, userAdminId, orgAlphaId, {
          decision: "approved",
          reason: "approved",
        });

        await assert.rejects(
          async () =>
            patchService.applyApprovedPatch(
              tx,
              {
                taskId: taskAlphaId,
                projectId: projAlphaId,
                patchArtifactId: artifact.id,
                expectedHash: contentHash,
              },
              userAdminId,
              orgAlphaId
            ),
          (err: any) => err instanceof ConflictError
        );

        // Crucial: File 1 was NOT modified even though its hunk was valid!
        const file1After = await testWorkspaceRunner.readFile(projAlphaId, "src/file1.ts");
        const file2After = await testWorkspaceRunner.readFile(projAlphaId, "src/file2.ts");
        assert.equal(file1After, file1Original);
        assert.equal(file2After, file2Original);
      });
    });

    it("3.8 should reject malformed unified diff with ValidationError", async () => {
      const malformedDiff = "--- a/src/index.ts\n@@ broken hunk @@\n+bad";
      assert.throws(
        () =>
          patchService.validatePatchIntegrity({
            content: malformedDiff,
            contentHash: crypto.createHash("sha256").update(malformedDiff).digest("hex"),
          } as any),
        (err: any) => err instanceof ValidationError && err.message.includes("Malformed unified diff")
      );
    });

    it("3.9 should reject patch application if approval is expired", async () => {
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        const fileContent = "export function expiredCheck() { return 1; }\n";
        testWorkspaceRunner.setFile(projAlphaId, "src/expired.ts", fileContent);

        const validPatch = [
          "--- a/src/expired.ts",
          "+++ b/src/expired.ts",
          "@@ -1 +1,2 @@",
          " export function expiredCheck() { return 1; }",
          "+// expired edit",
          "",
        ].join("\n");
        const contentHash = crypto.createHash("sha256").update(validPatch).digest("hex");

        const artifact = await artifactsService.createArtifact(tx, userAdminId, orgAlphaId, {
          projectId: projAlphaId,
          taskId: taskAlphaId,
          artifactType: "patch_proposal",
          title: "Expired Approval Patch",
          content: validPatch,
        });

        const approval = await approvalsService.createApprovalRequest(tx, orgAlphaId, {
          taskId: taskAlphaId,
          artifactId: artifact.id,
          action: "apply_patch",
          targetContentHash: contentHash,
          requiredRole: "admin",
          expiresInSeconds: -10, // Expires immediately in past
        });

        await assert.rejects(
          async () =>
            patchService.applyApprovedPatch(
              tx,
              {
                taskId: taskAlphaId,
                projectId: projAlphaId,
                patchArtifactId: artifact.id,
                expectedHash: contentHash,
              },
              userAdminId,
              orgAlphaId
            ),
          (err: any) => err instanceof ConflictError && err.message.includes("expired")
        );
      });
    });

    it("3.10 should reject patch creation targeting non-empty file as a new file", async () => {
      await withAuthenticatedContext(runtimePool, userAdminId, async (tx) => {
        testWorkspaceRunner.setFile(projAlphaId, "src/existing.ts", "export const existing = true;\n");

        const newFileDiff = [
          "--- /dev/null",
          "+++ b/src/existing.ts",
          "@@ -0,0 +1 @@",
          "+export const overwriting = true;",
          "",
        ].join("\n");
        const contentHash = crypto.createHash("sha256").update(newFileDiff).digest("hex");

        const artifact = await artifactsService.createArtifact(tx, userAdminId, orgAlphaId, {
          projectId: projAlphaId,
          taskId: taskAlphaId,
          artifactType: "patch_proposal",
          title: "Overwrite Conflict Patch",
          content: newFileDiff,
        });

        const approval = await approvalsService.createApprovalRequest(tx, orgAlphaId, {
          taskId: taskAlphaId,
          artifactId: artifact.id,
          action: "apply_patch",
          targetContentHash: contentHash,
          requiredRole: "admin",
          expiresInSeconds: 3600,
        });

        await approvalsService.decideApproval(tx, approval.id, userAdminId, orgAlphaId, {
          decision: "approved",
          reason: "approved",
        });

        await assert.rejects(
          async () =>
            patchService.applyApprovedPatch(
              tx,
              {
                taskId: taskAlphaId,
                projectId: projAlphaId,
                patchArtifactId: artifact.id,
                expectedHash: contentHash,
              },
              userAdminId,
              orgAlphaId
            ),
          (err: any) => err instanceof ConflictError && err.message.includes("already exists in workspace and is non-empty")
        );
      });
    });

    it("3.11 should prevent concurrent approval consumption race condition (only one succeeds)", async () => {
      let artifactId = "";
      let approvalId = "";
      let contentHash = "";

      const patchFile = "export const concurrentBase = 'initial';\n";
      testWorkspaceRunner.setFile(projAlphaId, "src/concurrent.ts", patchFile);

      const validPatch = [
        "--- a/src/concurrent.ts",
        "+++ b/src/concurrent.ts",
        "@@ -1 +1,2 @@",
        " export const concurrentBase = 'initial';",
        "+export const concurrentAdded = true;",
        "",
      ].join("\n");
      contentHash = crypto.createHash("sha256").update(validPatch).digest("hex");

      await withAuthenticatedContext(runtimePool, userAdminId, async (setupTx) => {
        const artifact = await artifactsService.createArtifact(setupTx, userAdminId, orgAlphaId, {
          projectId: projAlphaId,
          taskId: taskAlphaId,
          artifactType: "patch_proposal",
          title: "Concurrent Race Test Patch",
          content: validPatch,
        });
        artifactId = artifact.id;

        const approval = await approvalsService.createApprovalRequest(setupTx, orgAlphaId, {
          taskId: taskAlphaId,
          artifactId: artifact.id,
          action: "apply_patch",
          targetContentHash: contentHash,
          requiredRole: "admin",
          expiresInSeconds: 3600,
        });
        approvalId = approval.id;

        await approvalsService.decideApproval(setupTx, approval.id, userAdminId, orgAlphaId, {
          decision: "approved",
          reason: "approved",
        });
      });

      const results = await Promise.allSettled([
        withAuthenticatedContext(runtimePool, userAdminId, async (tx1) => {
          return patchService.applyApprovedPatch(
            tx1,
            {
              taskId: taskAlphaId,
              projectId: projAlphaId,
              patchArtifactId: artifactId,
              expectedHash: contentHash,
            },
            userAdminId,
            orgAlphaId
          );
        }),
        withAuthenticatedContext(runtimePool, userAdminId, async (tx2) => {
          return patchService.applyApprovedPatch(
            tx2,
            {
              taskId: taskAlphaId,
              projectId: projAlphaId,
              patchArtifactId: artifactId,
              expectedHash: contentHash,
            },
            userAdminId,
            orgAlphaId
          );
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      assert.equal(fulfilled.length, 1, "Exactly one concurrent patch application must succeed");
      assert.equal(rejected.length, 1, "The competing concurrent application must be rejected");
      assert.ok(
        (rejected[0] as PromiseRejectedResult).reason instanceof ConflictError,
        "Rejected attempt must fail with ConflictError"
      );
    });
  });

  // ===========================================================================
  // Suite 4: Truthful Reporting & Labeling
  // ===========================================================================
  describe("4. Truthful Reporting & Labeling", () => {
    it("4.1 should explicitly label mock runner outputs as simulated", async () => {
      const mockRunner = new MockWorkspaceRunner();
      const result = await mockRunner.runAllowlistedCommand("default", "test");

      assert.equal(result.isSimulated, true);
      assert.equal(result.runnerType, "mock");
      assert.equal(result.isolationLevel, "none");
    });

    it("4.2 should explicitly label docker runner outputs as non-simulated and unprivileged", async (t) => {
      const dockerRunner = new DockerWorkspaceRunner({ requireMicroVM: false });
      const preflight = await dockerRunner.preflightCheck();
      if (!preflight.ok) {
        t.skip("Docker daemon unavailable or not configured");
        return;
      }

      const result = await dockerRunner.runAllowlistedCommand("default", "test");
      assert.equal(result.isSimulated, false);
      assert.equal(result.runnerType, "isolated_container");
      assert.equal(result.isolationLevel, "unprivileged_container");
    });
  });
});
