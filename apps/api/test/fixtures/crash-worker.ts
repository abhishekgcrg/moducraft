import "../helpers/test-bootstrap.js";
import { createDatabasePool } from "../../src/db/pool.js";
import { ApprovedPatchService } from "../../src/modules/workflows/patch.service.js";
import { ApprovalsService } from "../../src/modules/workflows/approvals.service.js";
import { ArtifactsService } from "../../src/modules/workflows/artifacts.service.js";
import { createWorkspaceRunner } from "../../src/modules/workflows/tools/runner-factory.js";
import type { CrashInjectionStage } from "../../src/modules/workflows/patch.service.js";

/**
 * Standalone worker process for crash consistency testing.
 * Simulates abrupt process death (SIGKILL / exit) at specified execution boundaries.
 */
async function run() {
  const [
    ,
    ,
    targetStage,
    taskId,
    projectId,
    artifactId,
    contentHash,
    userId,
    orgId,
    customFileContent,
  ] = process.argv;

  if (!targetStage || !taskId || !projectId || !artifactId || !contentHash || !userId || !orgId) {
    // If invoked directly by test runner glob discovery without arguments, exit cleanly
    process.exit(0);
  }

  if (!process.env.DATABASE_URL) {
    console.error("Worker error: Missing DATABASE_URL environment variable.");
    process.exit(1);
  }

  const pool = createDatabasePool(process.env.DATABASE_URL);

  const runner = createWorkspaceRunner();
  if (customFileContent) {
    // Optionally pre-populate workspace files if needed
    try {
      const parsed = JSON.parse(customFileContent);
      for (const [path, content] of Object.entries(parsed)) {
        if (runner.setFile) {
          await runner.setFile(projectId, path, content as string);
        }
      }
    } catch {}
  }

  const patchService = new ApprovedPatchService(
    new ApprovalsService(),
    new ArtifactsService(),
    runner
  );

  try {
    await patchService.applyApprovedPatchDurable(
      pool,
      {
        taskId,
        projectId,
        patchArtifactId: artifactId,
        expectedHash: contentHash,
      },
      userId,
      orgId,
      runner,
      async (stage: CrashInjectionStage) => {
        if (stage === targetStage) {
          // Abrupt termination at the exact requested stage
          // Flushing console output so parent knows breakpoint was reached
          process.stdout.write(`CRASH_BREAKPOINT_REACHED:${stage}\n`);
          // Abruptly exit with distinct crash exit code (or signal)
          process.exit(99);
        }
      }
    );

    // If no crash occurred, exit normally
    process.exit(0);
  } catch (err: any) {
    console.error("Worker error:", err.message);
    process.exit(2);
  } finally {
    await pool.end();
  }
}

run();
