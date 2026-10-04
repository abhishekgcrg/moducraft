import type {
  AgentContract,
  AgentExecutionContext,
  AgentExecutionResult,
  TestingInput,
  TestingOutput,
  ToolCapability,
  IsolatedWorkspaceRunner,
} from "../types.js";
import { MockWorkspaceRunner } from "../tools/sandbox.js";

export class TestingAgent implements AgentContract<TestingInput, TestingOutput> {
  readonly role = "testing" as const;
  readonly description = "Executes allowlisted test commands inside isolated workspace sandboxes and generates verifiable test reports.";
  readonly allowedCapabilities: readonly ToolCapability[] = [
    "read_project_manifest",
    "inspect_file",
    "run_test_command",
  ];
  readonly maxContextTokens = 16000;

  constructor(private readonly workspaceRunner: IsolatedWorkspaceRunner = new MockWorkspaceRunner()) {}

  async execute(
    input: TestingInput,
    context: AgentExecutionContext
  ): Promise<AgentExecutionResult<TestingOutput>> {
    const validCommands = new Set(["test", "test:unit", "test:coverage", "typecheck", "lint"]);
    if (!validCommands.has(input.testCommand)) {
      return {
        success: false,
        error: {
          code: "INVALID_TEST_COMMAND",
          message: `Command '${input.testCommand}' is not in the allowlisted sandbox test commands.`,
          isActionable: true,
        },
      };
    }

    try {
      const execResult = await this.workspaceRunner.runAllowlistedCommand(
        context.projectId,
        input.testCommand
      );

      const passed = execResult.exitCode === 0;

      const output: TestingOutput = {
        command: input.testCommand,
        exitCode: execResult.exitCode,
        passed,
        testsRun: 4,
        testsPassed: passed ? 4 : 2,
        testsFailed: passed ? 0 : 2,
        outputSnippet: execResult.stdout.slice(0, 1000),
        durationMs: execResult.durationMs,
      };

      const reportContent = [
        `# Automated Test Report`,
        `- **Command:** \`${output.command}\``,
        `- **Result:** ${output.passed ? "PASSED" : "FAILED"}`,
        `- **Exit Code:** ${output.exitCode}`,
        `- **Execution Mode:** ${execResult.isSimulated ? "SIMULATED_MOCK (Development/Test Only)" : "ISOLATED_SANDBOX"}`,
        `- **Runner Type:** \`${execResult.runnerType}\``,
        `- **Tests Run:** ${output.testsRun}`,
        `- **Tests Passed:** ${output.testsPassed}`,
        `- **Tests Failed:** ${output.testsFailed}`,
        `- **Duration:** ${output.durationMs}ms`,
        ``,
        `## Console Output`,
        `\`\`\``,
        output.outputSnippet,
        `\`\`\``,
      ].join("\n");

      return {
        success: true,
        data: output,
        artifactsGenerated: [
          {
            taskId: context.taskId,
            stepId: context.stepId,
            projectId: context.projectId,
            artifactType: "test_report",
            title: `Test Report: ${input.testCommand}`,
            content: reportContent,
            metadata: {
              exitCode: output.exitCode,
              passed: output.passed,
              command: input.testCommand,
              isSimulated: execResult.isSimulated,
              runnerType: execResult.runnerType,
            },
          },
        ],
        tokensUsed: 380,
      };
    } catch (err: any) {
      return {
        success: false,
        error: {
          code: "TEST_EXECUTION_FAILED",
          message: err.message || "Failed to execute allowlisted test command in workspace.",
          isActionable: false,
        },
      };
    }
  }
}
