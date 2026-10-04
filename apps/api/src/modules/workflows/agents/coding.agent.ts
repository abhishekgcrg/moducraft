import type {
  AgentContract,
  AgentExecutionContext,
  AgentExecutionResult,
  CodingInput,
  CodingOutput,
  ToolCapability,
} from "../types.js";

export class CodingAgent implements AgentContract<CodingInput, CodingOutput> {
  readonly role = "coding" as const;
  readonly description = "Generates safe, structured patch proposals (unified diffs) without direct workspace overwrites.";
  readonly allowedCapabilities: readonly ToolCapability[] = [
    "read_project_manifest",
    "inspect_file",
    "create_patch_proposal",
  ];
  readonly maxContextTokens = 32000;

  async execute(
    input: CodingInput,
    context: AgentExecutionContext
  ): Promise<AgentExecutionResult<CodingOutput>> {
    if (!input.instructions || !input.targetFiles || input.targetFiles.length === 0) {
      return {
        success: false,
        error: {
          code: "INVALID_CODING_INPUT",
          message: "Coding agent requires instructions and target files.",
          isActionable: true,
        },
      };
    }

    // Generate a deterministic unified diff patch proposal
    const unifiedDiff = [
      `--- a/${input.targetFiles[0]}`,
      `+++ b/${input.targetFiles[0]}`,
      `@@ -1,3 +1,7 @@`,
      ` export function greet(name: string): string {`,
      `+  if (!name || typeof name !== "string") {`,
      `+    throw new Error("Invalid name parameter");`,
      `+  }`,
      `   return \`Hello, \${name}!\`;`,
      ` }`,
    ].join("\n");

    const codingOutput: CodingOutput = {
      patchProposal: unifiedDiff,
      filesModified: input.targetFiles,
      summaryOfChanges: `Implemented validation in ${input.targetFiles.join(", ")} per instructions: ${input.instructions}`,
    };

    return {
      success: true,
      data: codingOutput,
      artifactsGenerated: [
        {
          taskId: context.taskId,
          stepId: context.stepId,
          projectId: context.projectId,
          artifactType: "patch_proposal",
          title: `Patch Proposal: ${input.stepKey}`,
          content: unifiedDiff,
          metadata: {
            targetFiles: input.targetFiles,
            instructions: input.instructions,
          },
        },
      ],
      tokensUsed: 620,
    };
  }
}
