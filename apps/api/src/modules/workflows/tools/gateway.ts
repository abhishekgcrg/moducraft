import crypto from "node:crypto";
import type { ScopedTransaction } from "../../../db/transaction.js";
import {
  ValidationError,
  ForbiddenError,
  NotFoundError,
} from "../../../errors/app-errors.js";
import type {
  ToolCapability,
  ToolDefinition,
  ToolExecutionRequest,
  ToolExecutionResponse,
  IsolatedWorkspaceRunner,
} from "../types.js";
import { MockWorkspaceRunner, validateWorkspaceRelativePath } from "./sandbox.js";
import { createWorkspaceRunner } from "./runner-factory.js";
import { ArtifactsService } from "../artifacts.service.js";
import { redactSensitiveData } from "../../memory/redactor.js";

const MAX_TOOL_OUTPUT_BYTES = 524288; // 512 KB
const DEFAULT_TOOL_TIMEOUT_MS = 15000; // 15 seconds

export class ToolGateway {
  private readonly toolRegistry = new Map<ToolCapability, ToolDefinition>();

  constructor(
    private readonly workspaceRunner: IsolatedWorkspaceRunner = createWorkspaceRunner(),
    private readonly artifactsService: ArtifactsService = new ArtifactsService()
  ) {
    this.registerTools();
  }

  private registerTools(): void {
    this.toolRegistry.set("read_workflow_status", {
      name: "read_workflow_status",
      description: "Inspect current task lifecycle status, current step, and step execution counts.",
      requiredRole: "member",
      parametersSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      timeoutMs: 5000,
      maxOutputBytes: 65536,
    });

    this.toolRegistry.set("read_project_manifest", {
      name: "read_project_manifest",
      description: "Read authorized project manifest (package.json) from workspace sandbox.",
      requiredRole: "member",
      parametersSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      timeoutMs: 5000,
      maxOutputBytes: 131072,
    });

    this.toolRegistry.set("inspect_file", {
      name: "inspect_file",
      description: "Read an explicitly scoped source file from the authorized project workspace.",
      requiredRole: "member",
      parametersSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1, maxLength: 500 },
        },
        required: ["path"],
        additionalProperties: false,
      },
      timeoutMs: 5000,
      maxOutputBytes: 262144,
    });

    this.toolRegistry.set("create_patch_proposal", {
      name: "create_patch_proposal",
      description: "Generate and stage an immutable patch proposal artifact without applying it.",
      requiredRole: "member",
      parametersSchema: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 200 },
          patchContent: { type: "string", minLength: 1, maxLength: 524288 },
          targetFiles: { type: "array", items: { type: "string" } },
        },
        required: ["title", "patchContent"],
        additionalProperties: false,
      },
      timeoutMs: 10000,
      maxOutputBytes: 65536,
    });

    this.toolRegistry.set("run_test_command", {
      name: "run_test_command",
      description: "Execute an allowlisted test command in the isolated disposable workspace sandbox.",
      requiredRole: "member",
      parametersSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            enum: ["test", "test:unit", "test:coverage", "typecheck", "lint"],
          },
          timeoutMs: { type: "number", minimum: 1000, maximum: 30000 },
        },
        required: ["command"],
        additionalProperties: false,
      },
      timeoutMs: 30000,
      maxOutputBytes: 262144,
    });

    this.toolRegistry.set("produce_review_report", {
      name: "produce_review_report",
      description: "Generate and stage a structured code or security review report artifact.",
      requiredRole: "member",
      parametersSchema: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 200 },
          reportType: { type: "string", enum: ["code_review", "security_review"] },
          score: { type: "number", minimum: 0, maximum: 100 },
          content: { type: "string", minLength: 1, maxLength: 524288 },
          findings: { type: "array" },
        },
        required: ["title", "reportType", "score", "content"],
        additionalProperties: false,
      },
      timeoutMs: 10000,
      maxOutputBytes: 65536,
    });
  }

  getToolDefinition(name: ToolCapability): ToolDefinition | undefined {
    return this.toolRegistry.get(name);
  }

  listTools(): ToolDefinition[] {
    return Array.from(this.toolRegistry.values());
  }

  /**
   * Executes a requested tool through the secure gateway under tenant and workspace bounds.
   */
  async executeTool(
    tx: ScopedTransaction,
    request: ToolExecutionRequest
  ): Promise<ToolExecutionResponse> {
    const startTime = Date.now();
    const toolDef = this.toolRegistry.get(request.toolName);

    if (!toolDef) {
      return {
        success: false,
        output: {},
        error: {
          code: "UNKNOWN_TOOL",
          message: `Tool '${request.toolName}' is not registered in the controlled tool gateway.`,
        },
        durationMs: Date.now() - startTime,
        outputSizeBytes: 0,
      };
    }

    // 1. Verify project ownership by tenant under forced RLS
    const projectRes = await tx.query<{ id: string }>(
      `SELECT id FROM projects WHERE id = $1 AND organization_id = $2;`,
      [request.projectId, request.organizationId]
    );
    if (projectRes.rowCount === 0) {
      throw new NotFoundError("Project not found in authorized organization context");
    }

    // 2. Verify task ownership by tenant
    const taskRes = await tx.query<{ id: string; status: string }>(
      `SELECT id, status FROM agent_tasks WHERE id = $1 AND organization_id = $2;`,
      [request.taskId, request.organizationId]
    );
    if (taskRes.rowCount === 0) {
      throw new NotFoundError("Agent task not found in authorized organization context");
    }

    // 2b. Enforce tool-level role authorization
    if (toolDef.requiredRole !== "member") {
      const roleRes = await tx.query<{ role: string }>(
        `SELECT role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2;`,
        [request.organizationId, request.userId]
      );
      const userRole = roleRes.rows[0]?.role;
      const meetsRole =
        toolDef.requiredRole === "admin"
          ? userRole === "owner" || userRole === "admin"
          : userRole === "owner";

      if (!meetsRole) {
        return {
          success: false,
          output: {},
          error: {
            code: "FORBIDDEN",
            message: `User role '${userRole ?? "none"}' does not meet required role '${toolDef.requiredRole}' for tool '${request.toolName}'.`,
          },
          durationMs: Date.now() - startTime,
          outputSizeBytes: 0,
        };
      }
    }

    // 3. Execute tool within bounded timeout
    const timeoutMs = toolDef.timeoutMs || DEFAULT_TOOL_TIMEOUT_MS;

    try {
      const output = await Promise.race([
        this.dispatchToolExecution(tx, request),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Tool execution timed out after ${timeoutMs}ms.`)), timeoutMs)
        ),
      ]);

      const rawOutputString = JSON.stringify(output);
      // Redact any credentials, tokens, or private keys that might appear in tool outputs
      const { text: sanitizedOutputString } = redactSensitiveData(rawOutputString);
      const sanitizedOutput = JSON.parse(sanitizedOutputString);
      const outputSizeBytes = Buffer.byteLength(sanitizedOutputString, "utf-8");

      if (outputSizeBytes > (toolDef.maxOutputBytes || MAX_TOOL_OUTPUT_BYTES)) {
        return {
          success: false,
          output: {},
          error: {
            code: "OUTPUT_SIZE_LIMIT_EXCEEDED",
            message: `Tool output size (${outputSizeBytes} bytes) exceeded maximum allowable limit (${toolDef.maxOutputBytes} bytes).`,
          },
          durationMs: Date.now() - startTime,
          outputSizeBytes,
        };
      }

      // Record event in agent_task_events
      await tx.query(
        `INSERT INTO agent_task_events (
          organization_id, task_id, step_id, event_type, actor_user_id, metadata
        ) VALUES ($1, $2, $3, 'tool.executed', $4, $5::jsonb);`,
        [
          request.organizationId,
          request.taskId,
          request.stepId ?? null,
          request.userId,
          JSON.stringify({
            toolName: request.toolName,
            durationMs: Date.now() - startTime,
            outputSizeBytes,
          }),
        ]
      );

      return {
        success: true,
        output: sanitizedOutput,
        durationMs: Date.now() - startTime,
        outputSizeBytes,
      };
    } catch (err: any) {
      return {
        success: false,
        output: {},
        error: {
          code: err.code || "TOOL_EXECUTION_ERROR",
          message: err.message || "An error occurred during tool execution.",
        },
        durationMs: Date.now() - startTime,
        outputSizeBytes: 0,
      };
    }
  }

  private async dispatchToolExecution(
    tx: ScopedTransaction,
    request: ToolExecutionRequest
  ): Promise<Record<string, unknown>> {
    switch (request.toolName) {
      case "read_workflow_status": {
        const taskRes = await tx.query<{
          id: string;
          status: string;
          current_step_key: string | null;
          version: number;
        }>(
          `SELECT id, status, current_step_key, version FROM agent_tasks WHERE id = $1;`,
          [request.taskId]
        );
        const stepsRes = await tx.query<{
          step_key: string;
          status: string;
          attempt_count: number;
        }>(
          `SELECT step_key, status, attempt_count FROM agent_task_steps WHERE task_id = $1 ORDER BY position ASC;`,
          [request.taskId]
        );

        return {
          task: taskRes.rows[0],
          steps: stepsRes.rows,
        };
      }

      case "read_project_manifest": {
        const manifest = await this.workspaceRunner.readManifest(request.projectId);
        return { manifest };
      }

      case "inspect_file": {
        const rawPath = request.parameters.path;
        if (typeof rawPath !== "string") {
          throw new ValidationError("Parameter 'path' must be a string.");
        }
        const safePath = validateWorkspaceRelativePath(rawPath);
        const content = await this.workspaceRunner.readFile(request.projectId, safePath);
        return {
          path: safePath,
          content,
          sizeBytes: Buffer.byteLength(content, "utf-8"),
        };
      }

      case "create_patch_proposal": {
        const title = request.parameters.title;
        const patchContent = request.parameters.patchContent;
        if (typeof title !== "string" || typeof patchContent !== "string") {
          throw new ValidationError("Parameters 'title' and 'patchContent' are required strings.");
        }

        const artifact = await this.artifactsService.createArtifact(
          tx,
          request.userId,
          request.organizationId,
          {
            projectId: request.projectId,
            taskId: request.taskId,
            stepId: request.stepId,
            artifactType: "patch_proposal",
            title,
            content: patchContent,
            metadata: {
              targetFiles: request.parameters.targetFiles ?? [],
            },
          }
        );

        return {
          artifactId: artifact.id,
          title: artifact.title,
          contentHash: artifact.contentHash,
          sizeBytes: artifact.sizeBytes,
          reviewStatus: artifact.reviewStatus,
        };
      }

      case "run_test_command": {
        const command = request.parameters.command as any;
        const timeoutMs = typeof request.parameters.timeoutMs === "number" ? request.parameters.timeoutMs : undefined;

        const result = await this.workspaceRunner.runAllowlistedCommand(
          request.projectId,
          command,
          timeoutMs
        );

        return {
          command,
          exitCode: result.exitCode,
          passed: result.exitCode === 0,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
          isSimulated: result.isSimulated ?? true,
          runnerType: result.runnerType ?? "mock",
          isolationLevel: result.isolationLevel ?? "none",
        };
      }

      case "produce_review_report": {
        const title = request.parameters.title;
        const reportType = request.parameters.reportType as "code_review" | "security_review";
        const score = request.parameters.score;
        const content = request.parameters.content;

        if (typeof title !== "string" || typeof content !== "string" || typeof score !== "number") {
          throw new ValidationError("Title, content, and numeric score are required.");
        }

        const artifact = await this.artifactsService.createArtifact(
          tx,
          request.userId,
          request.organizationId,
          {
            projectId: request.projectId,
            taskId: request.taskId,
            stepId: request.stepId,
            artifactType: reportType,
            title,
            content,
            metadata: {
              score,
              findings: request.parameters.findings ?? [],
            },
          }
        );

        return {
          artifactId: artifact.id,
          reportType,
          score,
          contentHash: artifact.contentHash,
        };
      }

      default:
        throw new ValidationError(`Unsupported tool name '${request.toolName}'.`);
    }
  }
}
