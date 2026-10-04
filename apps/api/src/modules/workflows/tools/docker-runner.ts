import { spawn, execSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import {
  ValidationError,
  ForbiddenError,
  NotFoundError,
} from "../../../errors/app-errors.js";
import { redactSensitiveData } from "../../memory/redactor.js";
import { validateWorkspaceRelativePath } from "./sandbox.js";
import type {
  IsolatedWorkspaceRunner,
  WorkspaceFile,
  AllowlistedCommand,
  WorkspaceExecutionResult,
  WorkspaceRunnerConfig,
  RunnerType,
  IsolationLevel,
} from "../types.js";

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 30000;
const DEFAULT_MAX_OUTPUT_BYTES = 262144; // 256 KB

/**
 * DockerWorkspaceRunner
 *
 * Implements ephemeral, unprivileged container-based workspace execution.
 * Enforces strict isolation controls:
 * - Read-only root filesystem
 * - Drops all Linux capabilities
 * - Sets no-new-privileges flag
 * - Runs as unprivileged non-root user (UID:GID 1000:1000)
 * - Restricts memory (512MB), CPU quota (1.0), and PID limits (64)
 * - Disables outbound networking by default (--network none)
 * - Mounts disposable in-memory tmpfs (/tmp, /workspace) with no host filesystem mounts
 * - Never interpolates model-generated text into shell commands
 * - Strict allowlist of fixed project commands
 * - Process tree termination on timeout or cancellation
 * - Secrets redacted from stdout/stderr outputs
 */
export class DockerWorkspaceRunner implements IsolatedWorkspaceRunner {
  readonly runnerType: RunnerType = "isolated_container";
  readonly isProductionSandbox: boolean = true;
  readonly isolationLevel: IsolationLevel = "unprivileged_container";

  private readonly dockerImage: string;
  private readonly maxMemoryMb: number;
  private readonly maxCpu: number;
  private readonly defaultTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly networkDisabled: boolean;
  private readonly containerUid: number;
  private readonly containerGid: number;
  private readonly requireMicroVM: boolean;

  // In-memory workspace file cache per project (acts as base snapshot)
  private readonly projectWorkspaces = new Map<string, Map<string, WorkspaceFile>>();

  constructor(config?: Partial<WorkspaceRunnerConfig>) {
    this.dockerImage = config?.dockerImage || process.env.MODUCRAFT_DOCKER_IMAGE || "alpine:latest";
    this.maxMemoryMb = config?.maxMemoryMb || 512;
    this.maxCpu = config?.maxCpu || 1.0;
    this.defaultTimeoutMs = config?.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = config?.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES;
    this.networkDisabled = config?.networkDisabled ?? true;
    this.containerUid = config?.containerUid ?? 1000;
    this.containerGid = config?.containerGid ?? 1000;
    this.requireMicroVM = config?.requireMicroVM ?? (process.env.MODUCRAFT_REQUIRE_MICROVM === "true");

    this.seedDefaultWorkspace("default");
  }

  /**
   * Performs preflight checks to verify Docker availability and isolation runtime capabilities.
   */
  async preflightCheck(): Promise<{ ok: boolean; runtime: string; error?: string }> {
    try {
      const dockerVersionOut = execSync("docker --version", {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf-8",
        timeout: 15000,
      });

      if (!dockerVersionOut.toLowerCase().includes("docker version")) {
        return { ok: false, runtime: "none", error: "Docker CLI returned unexpected output." };
      }

      // Query Docker daemon info for runtime and security options
      const infoOut = execSync("docker info --format '{{.DefaultRuntime}}'", {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf-8",
        timeout: 15000,
      }).trim();

      const runtime = infoOut.replace(/^'|'$/g, "").trim() || "runc";

      // If hard microVM isolation is required, verify runtime is gVisor (runsc) or Firecracker/Kata
      if (this.requireMicroVM) {
        const isMicroVM = runtime.includes("runsc") || runtime.includes("kata") || runtime.includes("firecracker");
        if (!isMicroVM) {
          return {
            ok: false,
            runtime,
            error: `MicroVM isolation is required, but Docker default runtime is '${runtime}'. Please configure runsc/kata.`,
          };
        }
      }

      return { ok: true, runtime };
    } catch (err: any) {
      return {
        ok: false,
        runtime: "unknown",
        error: `Docker preflight check failed: ${err.message}`,
      };
    }
  }

  private seedDefaultWorkspace(projectId: string): void {
    const files = new Map<string, WorkspaceFile>();

    const packageJsonContent = JSON.stringify(
      {
        name: "moducraft-sample-service",
        version: "1.0.0",
        type: "module",
        scripts: {
          test: "node --test",
          "test:unit": "node --test test/unit",
          "test:coverage": "node --test --experimental-test-coverage",
          typecheck: "tsc --noEmit",
          lint: "eslint .",
        },
        dependencies: {
          fastify: "^5.2.0",
        },
      },
      null,
      2
    );

    const tsConfigContent = JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
        },
      },
      null,
      2
    );

    const srcIndexContent = `export function greet(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n`;

    files.set("package.json", {
      path: "package.json",
      content: packageJsonContent,
      sizeBytes: Buffer.byteLength(packageJsonContent, "utf-8"),
      lastModified: new Date(),
    });

    files.set("tsconfig.json", {
      path: "tsconfig.json",
      content: tsConfigContent,
      sizeBytes: Buffer.byteLength(tsConfigContent, "utf-8"),
      lastModified: new Date(),
    });

    files.set("src/index.ts", {
      path: "src/index.ts",
      content: srcIndexContent,
      sizeBytes: Buffer.byteLength(srcIndexContent, "utf-8"),
      lastModified: new Date(),
    });

    this.projectWorkspaces.set(projectId, files);
  }

  getProjectFiles(projectId: string): Map<string, WorkspaceFile> {
    let files = this.projectWorkspaces.get(projectId);
    if (!files) {
      this.seedDefaultWorkspace(projectId);
      files = this.projectWorkspaces.get(projectId)!;
    }
    return files;
  }

  async readFile(projectId: string, relativePath: string): Promise<string> {
    const safePath = validateWorkspaceRelativePath(relativePath);
    const files = this.getProjectFiles(projectId);

    const file = files.get(safePath);
    if (!file) {
      throw new NotFoundError(`File '${safePath}' in project workspace`);
    }

    return file.content;
  }

  async readManifest(projectId: string): Promise<Record<string, unknown>> {
    const content = await this.readFile(projectId, "package.json");
    try {
      return JSON.parse(content);
    } catch {
      throw new ValidationError("Manifest file 'package.json' contains invalid JSON.");
    }
  }

  /**
   * Helper for testing/staging: set or update file in workspace
   */
  setFile(projectId: string, relativePath: string, content: string): void {
    const safePath = validateWorkspaceRelativePath(relativePath);
    const files = this.getProjectFiles(projectId);
    files.set(safePath, {
      path: safePath,
      content,
      sizeBytes: Buffer.byteLength(content, "utf-8"),
      lastModified: new Date(),
    });
  }

  deleteFile(projectId: string, relativePath: string): void {
    const safePath = validateWorkspaceRelativePath(relativePath);
    const files = this.getProjectFiles(projectId);
    files.delete(safePath);
  }

  async cleanupWorkspace(projectId: string): Promise<void> {
    this.projectWorkspaces.delete(projectId);
  }

  /**
   * Executes an allowlisted project command inside an ephemeral unprivileged Docker container.
   */
  async runAllowlistedCommand(
    projectId: string,
    command: AllowlistedCommand,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<WorkspaceExecutionResult> {
    const ALLOWED_COMMANDS = new Set<AllowlistedCommand>([
      "test",
      "test:unit",
      "test:coverage",
      "typecheck",
      "lint",
    ]);

    if (!ALLOWED_COMMANDS.has(command)) {
      throw new ForbiddenError(
        `Command '${command}' is not in the allowlisted sandbox commands. Allowed: ${Array.from(ALLOWED_COMMANDS).join(", ")}.`
      );
    }

    // Verify microVM requirement if configured
    if (this.requireMicroVM) {
      const preflight = await this.preflightCheck();
      if (!preflight.ok) {
        throw new ForbiddenError(
          `Production isolation blocked: ${preflight.error ?? "MicroVM isolation is required but unavailable."}`
        );
      }
    }

    const effectiveTimeoutMs = Math.min(
      Math.max(timeoutMs || this.defaultTimeoutMs, 1000),
      MAX_TIMEOUT_MS
    );

    const executionId = crypto.randomBytes(8).toString("hex");
    const containerName = `moducraft-sandbox-${executionId}`;
    const startTime = Date.now();

    // Prepare container arguments with comprehensive security constraints
    const dockerArgs = [
      "run",
      "--rm",
      "-i",
      "--name", containerName,
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--user", `${this.containerUid}:${this.containerGid}`,
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
      "--tmpfs", `/workspace:rw,nosuid,uid=${this.containerUid},gid=${this.containerGid},mode=0700,size=128m`,
      "--pids-limit", "64",
      "--memory", `${this.maxMemoryMb}m`,
      "--cpus", `${this.maxCpu}`,
      "-w", "/workspace",
      "--env", "NODE_ENV=test",
      "--env", "HOME=/tmp",
      "--env", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ];

    if (this.networkDisabled) {
      dockerArgs.push("--network", "none");
    }

    dockerArgs.push(this.dockerImage);

    // Build the container execution script.
    // Files are staged into /workspace using base64 decoding via stdin stream.
    // Statically mapped execution commands:
    const files = this.getProjectFiles(projectId);
    const stagingCommands: string[] = [];

    for (const [filePath, fileData] of files.entries()) {
      const b64 = Buffer.from(fileData.content, "utf-8").toString("base64");
      const dir = path.posix.dirname(filePath);
      if (dir && dir !== ".") {
        stagingCommands.push(`mkdir -p "${dir}"`);
      }
      stagingCommands.push(`echo "${b64}" | base64 -d > "${filePath}"`);
    }

    // Check if package.json has a script for the requested allowlisted command
    let scriptCmd = "";
    try {
      const pkgContent = files.get("package.json")?.content;
      if (pkgContent) {
        const pkg = JSON.parse(pkgContent);
        if (typeof pkg.scripts?.[command] === "string") {
          scriptCmd = pkg.scripts[command].trim();
        }
      }
    } catch {}

    const scriptCmdB64 = scriptCmd ? Buffer.from(scriptCmd, "utf-8").toString("base64") : "";

    // Determine the fixed command to run inside container based on allowlisted command
    let runCmd = "";
    switch (command) {
      case "test":
        runCmd = `if [ -f package.json ]; then
  if command -v npm >/dev/null 2>&1; then
    npm test
  elif command -v node >/dev/null 2>&1; then
    node --test
  elif [ -n "${scriptCmdB64}" ]; then
    sh -c "$(echo '${scriptCmdB64}' | base64 -d)"
  else
    echo 'Test runner (node/npm) not present in sandbox image' >&2
    exit 1
  fi
else
  echo 'No package.json in workspace' >&2
  exit 1
fi`;
        break;
      case "test:unit":
        runCmd = `if command -v npm >/dev/null 2>&1; then
  npm run test:unit
elif command -v node >/dev/null 2>&1; then
  node --test test/unit
elif [ -n "${scriptCmdB64}" ]; then
  sh -c "$(echo '${scriptCmdB64}' | base64 -d)"
else
  echo 'Unit test runner not present in sandbox image' >&2
  exit 1
fi`;
        break;
      case "test:coverage":
        runCmd = `if command -v npm >/dev/null 2>&1; then
  npm run test:coverage
elif command -v node >/dev/null 2>&1; then
  node --test --experimental-test-coverage
elif [ -n "${scriptCmdB64}" ]; then
  sh -c "$(echo '${scriptCmdB64}' | base64 -d)"
else
  echo 'Coverage runner not present in sandbox image' >&2
  exit 1
fi`;
        break;
      case "typecheck":
        runCmd = `if command -v npx >/dev/null 2>&1; then
  npx tsc --noEmit
elif [ -n "${scriptCmdB64}" ]; then
  sh -c "$(echo '${scriptCmdB64}' | base64 -d)"
else
  echo 'TypeScript compiler (tsc) not present in sandbox image' >&2
  exit 1
fi`;
        break;
      case "lint":
        runCmd = `if command -v npx >/dev/null 2>&1; then
  npx eslint .
elif [ -n "${scriptCmdB64}" ]; then
  sh -c "$(echo '${scriptCmdB64}' | base64 -d)"
else
  echo 'Linter (eslint) not present in sandbox image' >&2
  exit 1
fi`;
        break;
    }

    // Pass sh -c "staging; runCmd"
    dockerArgs.push("sh", "-c", "set -e\n" + stagingCommands.join("\n") + "\n" + runCmd);

    return new Promise<WorkspaceExecutionResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let stdoutExceeded = false;
      let stderrExceeded = false;
      let isTimedOut = false;
      let isCancelled = false;
      let childExited = false;

      const child = spawn("docker", dockerArgs, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Handle abort signal
      const onAbort = () => {
        isCancelled = true;
        cleanupAndKill();
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      // Hard timeout timer
      const timer = setTimeout(() => {
        isTimedOut = true;
        cleanupAndKill();
      }, effectiveTimeoutMs);

      const cleanupAndKill = () => {
        try {
          child.kill("SIGKILL");
        } catch {}
        // Also ensure docker container is terminated on host daemon
        try {
          execSync(`docker kill ${containerName}`, {
            stdio: "ignore",
            timeout: 3000,
          });
        } catch {}
      };

      child.stdout.on("data", (chunk: Buffer) => {
        if (stdoutExceeded) return;
        stdout += chunk.toString("utf-8");
        if (Buffer.byteLength(stdout, "utf-8") > this.maxOutputBytes) {
          stdoutExceeded = true;
          stdout = stdout.slice(0, this.maxOutputBytes) + "\n[OUTPUT TRUNCATED: Exceeded max allowed size]";
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        if (stderrExceeded) return;
        stderr += chunk.toString("utf-8");
        if (Buffer.byteLength(stderr, "utf-8") > this.maxOutputBytes) {
          stderrExceeded = true;
          stderr = stderr.slice(0, this.maxOutputBytes) + "\n[OUTPUT TRUNCATED: Exceeded max allowed size]";
        }
      });

      child.on("error", (err: Error) => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve({
          exitCode: 1,
          stdout: "",
          stderr: `Failed to spawn docker process: ${err.message}`,
          durationMs: Date.now() - startTime,
          isSimulated: false,
          runnerType: this.runnerType,
          isolationLevel: this.isolationLevel,
        });
      });

      child.on("close", (code: number | null) => {
        if (childExited) return;
        childExited = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);

        const durationMs = Date.now() - startTime;

        // Scrub sensitive secrets from outputs before returning
        const sanitizedStdout = redactSensitiveData(stdout).text;
        const sanitizedStderr = redactSensitiveData(stderr).text;

        if (isTimedOut) {
          return resolve({
            exitCode: 124,
            stdout: sanitizedStdout,
            stderr: (sanitizedStderr ? sanitizedStderr + "\n" : "") + `Execution timed out after ${effectiveTimeoutMs}ms. Process tree terminated.`,
            durationMs,
            isSimulated: false,
            runnerType: this.runnerType,
            isolationLevel: this.isolationLevel,
            timedOut: true,
          });
        }

        if (isCancelled) {
          return resolve({
            exitCode: 130,
            stdout: sanitizedStdout,
            stderr: (sanitizedStderr ? sanitizedStderr + "\n" : "") + "Execution cancelled by caller.",
            durationMs,
            isSimulated: false,
            runnerType: this.runnerType,
            isolationLevel: this.isolationLevel,
            cancelled: true,
          });
        }

        resolve({
          exitCode: code ?? 0,
          stdout: sanitizedStdout,
          stderr: sanitizedStderr,
          durationMs,
          isSimulated: false,
          runnerType: this.runnerType,
          isolationLevel: this.isolationLevel,
        });
      });

      // Close child stdin since we do not send interactive input
      child.stdin.end();
    });
  }
}

/**
 * FailClosedWorkspaceRunner
 *
 * Used when production isolation requirements cannot be fulfilled,
 * or when configuration is missing or invalid.
 * Strictly rejects command execution and file operations without fallback to mock.
 */
export class FailClosedWorkspaceRunner implements IsolatedWorkspaceRunner {
  readonly runnerType: RunnerType = "fail_closed";
  readonly isProductionSandbox: boolean = true;
  readonly isolationLevel: IsolationLevel = "none";

  constructor(private readonly failureReason: string) {}

  async readFile(): Promise<string> {
    throw new ForbiddenError(
      `Workspace access blocked by FailClosedWorkspaceRunner: ${this.failureReason}`
    );
  }

  async readManifest(): Promise<Record<string, unknown>> {
    throw new ForbiddenError(
      `Manifest inspection blocked by FailClosedWorkspaceRunner: ${this.failureReason}`
    );
  }

  async runAllowlistedCommand(): Promise<WorkspaceExecutionResult> {
    throw new ForbiddenError(
      `Command execution blocked by FailClosedWorkspaceRunner: ${this.failureReason}`
    );
  }

  setFile(): void {
    throw new ForbiddenError(
      `File modification blocked by FailClosedWorkspaceRunner: ${this.failureReason}`
    );
  }

  deleteFile(): void {
    throw new ForbiddenError(
      `File deletion blocked by FailClosedWorkspaceRunner: ${this.failureReason}`
    );
  }
}
