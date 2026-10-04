import path from "node:path";
import { ValidationError, ForbiddenError, NotFoundError } from "../../../errors/app-errors.js";
import type {
  IsolatedWorkspaceRunner,
  WorkspaceFile,
  AllowlistedCommand,
  WorkspaceExecutionResult,
} from "../types.js";

// Sensitive files and directories that must never be accessed by workspace tools
const FORBIDDEN_WORKSPACE_PATTERNS = [
  /^\.env(\..+)?$/i,
  /^\.git(\/|$)/i,
  /^\.ssh(\/|$)/i,
  /^\.aws(\/|$)/i,
  /(^|\/)id_rsa(\.pub)?$/i,
  /\.(pem|key|p12|pfx|pkcs12)$/i,
  /^\.npmrc$/i,
  /^\.dockercfg$/i,
  /^\.docker\/config\.json$/i,
];

/**
 * Validates that a requested file path does not escape the workspace root
 * and does not access sensitive environment, credentials, or private key files.
 * Neutralizes directory traversal (../), absolute paths, percent-encoding, and null-byte injection.
 */
export function validateWorkspaceRelativePath(rawPath: string): string {
  if (!rawPath || typeof rawPath !== "string") {
    throw new ValidationError("Path must be a non-empty string.");
  }

  // Reject null-byte injection
  if (rawPath.includes("\0")) {
    throw new ValidationError("Path contains invalid null byte.");
  }

  const trimmed = rawPath.trim();

  // Validate percent encoding and reject double-encoding or encoded traversal
  let decoded = trimmed;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    throw new ValidationError("Path contains invalid percent encoding.");
  }

  if (decoded.includes("\0")) {
    throw new ValidationError("Path contains decoded null byte.");
  }

  // Reject drive letters or UNC paths on Windows (e.g. C:, \\server)
  if (
    /^[a-zA-Z]:/.test(trimmed) ||
    /^[a-zA-Z]:/.test(decoded) ||
    trimmed.startsWith("\\\\") ||
    trimmed.startsWith("//") ||
    decoded.startsWith("\\\\") ||
    decoded.startsWith("//")
  ) {
    throw new ForbiddenError("Absolute drive paths and UNC network paths are forbidden in workspace sandbox.");
  }

  // Normalize separators to posix style
  const normalized = path.posix.normalize(trimmed.replace(/\\/g, "/"));
  const normalizedDecoded = path.posix.normalize(decoded.replace(/\\/g, "/"));

  // Check for traversal
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalizedDecoded === ".." ||
    normalizedDecoded.startsWith("../") ||
    normalizedDecoded.includes("/../")
  ) {
    throw new ForbiddenError("Path traversal outside workspace sandbox is forbidden.");
  }

  // Reject absolute paths
  if (normalized.startsWith("/") || normalizedDecoded.startsWith("/")) {
    throw new ForbiddenError("Absolute paths are forbidden in workspace sandbox.");
  }

  if (!normalized || normalized === ".") {
    throw new ValidationError("Path cannot reference workspace root directory directly.");
  }

  // Block access to sensitive secrets, credentials, environment files, and private keys
  for (const pattern of FORBIDDEN_WORKSPACE_PATTERNS) {
    if (pattern.test(normalized) || pattern.test(normalizedDecoded)) {
      throw new ForbiddenError(
        `Access to sensitive credential, environment, or key file '${normalized}' is strictly forbidden.`
      );
    }
  }

  return normalized;
}

/**
 * Mock Isolated Workspace Runner
 *
 * Provides a bounded, in-memory repository workspace for testing and simulation.
 * In production, this interface is backed by ephemeral gVisor/Firecracker microVM
 * or Docker sandboxes with isolated network namespaces, cgroups, and read-only host mounts.
 */
export class MockWorkspaceRunner implements IsolatedWorkspaceRunner {
  readonly runnerType = "mock" as const;
  readonly isProductionSandbox = false as const;
  readonly isolationLevel = "none" as const;
  private readonly workspaceFiles = new Map<string, Map<string, WorkspaceFile>>();

  constructor() {
    // Seed default mock projects
    this.seedDefaultWorkspace("default");
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

    this.workspaceFiles.set(projectId, files);
  }

  private getProjectFiles(projectId: string): Map<string, WorkspaceFile> {
    let files = this.workspaceFiles.get(projectId);
    if (!files) {
      this.seedDefaultWorkspace(projectId);
      files = this.workspaceFiles.get(projectId)!;
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

  async runAllowlistedCommand(
    projectId: string,
    command: AllowlistedCommand,
    timeoutMs = 10000,
    signal?: AbortSignal
  ): Promise<WorkspaceExecutionResult> {
    // Fail-closed in production: MockWorkspaceRunner is strictly for test/dev simulation.
    if (process.env.NODE_ENV === "production") {
      throw new ForbiddenError(
        "Production command execution is blocked: MockWorkspaceRunner is strictly disallowed in production. " +
        "An isolated container/microVM runner with network isolation, unprivileged UID, dropped capabilities, and read-only rootfs must be configured."
      );
    }

    const ALLOWED_COMMANDS = new Set(["test", "test:unit", "test:coverage", "typecheck", "lint"]);

    if (!ALLOWED_COMMANDS.has(command)) {
      throw new ForbiddenError(
        `Command '${command}' is not in the allowlisted sandbox commands. Allowed: ${Array.from(ALLOWED_COMMANDS).join(", ")}.`
      );
    }

    // Simulate bounded execution duration
    const startTime = Date.now();

    // Verify project exists
    this.getProjectFiles(projectId);

    // Mock deterministic execution result (annotated as simulated)
    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    switch (command) {
      case "test":
      case "test:unit":
        stdout = "[SIMULATED_MOCK_RUNNER] PASS src/index.test.ts (4 tests passed, 0 failed)\nDone in 0.84s.";
        break;
      case "test:coverage":
        stdout = "[SIMULATED_MOCK_RUNNER] Statements: 100%, Branches: 100%, Functions: 100%, Lines: 100%\nAll tests passed.";
        break;
      case "typecheck":
        stdout = "[SIMULATED_MOCK_RUNNER] Found 0 errors. Watching for file changes.";
        break;
      case "lint":
        stdout = "[SIMULATED_MOCK_RUNNER] 0 problems (0 errors, 0 warnings)";
        break;
    }

    const durationMs = Math.min(Date.now() - startTime + 50, timeoutMs);

    return {
      exitCode,
      stdout,
      stderr,
      durationMs,
      isSimulated: true,
      runnerType: "mock",
      isolationLevel: "none",
    };
  }

  /**
   * Helper for testing: inject or modify a file in the workspace
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
}
