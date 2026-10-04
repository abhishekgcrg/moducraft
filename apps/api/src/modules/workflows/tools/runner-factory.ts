import { MockWorkspaceRunner } from "./sandbox.js";
import { DockerWorkspaceRunner, FailClosedWorkspaceRunner } from "./docker-runner.js";
import type {
  IsolatedWorkspaceRunner,
  WorkspaceRunnerConfig,
} from "../types.js";

/**
 * Resolves workspace runner configuration from environment variables and explicit overrides.
 */
export function resolveRunnerConfig(
  override?: Partial<WorkspaceRunnerConfig>
): WorkspaceRunnerConfig {
  const envMode = process.env.MODUCRAFT_WORKSPACE_RUNNER as
    | "mock"
    | "docker"
    | "fail_closed"
    | undefined;

  let mode: "mock" | "docker" | "fail_closed" = override?.mode || envMode || "mock";

  // In production, default mode can NEVER be "mock"
  if (process.env.NODE_ENV === "production" && mode === "mock" && !override?.mode) {
    mode = "fail_closed";
  }

  return {
    mode,
    dockerImage: override?.dockerImage || process.env.MODUCRAFT_DOCKER_IMAGE || "alpine:latest",
    requireMicroVM:
      override?.requireMicroVM ?? (process.env.MODUCRAFT_REQUIRE_MICROVM === "true"),
    maxMemoryMb: override?.maxMemoryMb ?? 512,
    maxCpu: override?.maxCpu ?? 1.0,
    timeoutMs: override?.timeoutMs ?? 15000,
    maxOutputBytes: override?.maxOutputBytes ?? 262144,
    networkDisabled: override?.networkDisabled ?? true,
    containerUid: override?.containerUid ?? 1000,
    containerGid: override?.containerGid ?? 1000,
  };
}

/**
 * Factory function creating the appropriate workspace runner according to environment and config.
 * Guaranteed never to silently fall back to mock runner in production.
 */
export function createWorkspaceRunner(
  override?: Partial<WorkspaceRunnerConfig>
): IsolatedWorkspaceRunner {
  const config = resolveRunnerConfig(override);
  const isProduction = process.env.NODE_ENV === "production";

  if (isProduction) {
    if (config.mode === "mock") {
      return new FailClosedWorkspaceRunner(
        "Production misconfiguration: MockWorkspaceRunner is strictly prohibited in production. " +
        "Configure MODUCRAFT_WORKSPACE_RUNNER='docker' or another isolated container backend."
      );
    }

    if (config.mode === "fail_closed") {
      return new FailClosedWorkspaceRunner(
        "Production runner is configured to fail closed. No isolated backend is operational."
      );
    }

    if (config.mode === "docker") {
      return new DockerWorkspaceRunner(config);
    }

    return new FailClosedWorkspaceRunner(
      `Unsupported runner mode '${config.mode}' in production environment.`
    );
  }

  // Development and test environments
  if (config.mode === "docker") {
    return new DockerWorkspaceRunner(config);
  }

  if (config.mode === "fail_closed") {
    return new FailClosedWorkspaceRunner(
      "Runner is explicitly configured to fail closed."
    );
  }

  return new MockWorkspaceRunner();
}
