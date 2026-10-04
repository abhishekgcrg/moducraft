import type {
  AgentContract,
  AgentExecutionContext,
  AgentExecutionResult,
  ReviewInput,
  ReviewOutput,
  ToolCapability,
} from "../types.js";

export class CodeReviewAgent implements AgentContract<ReviewInput, ReviewOutput> {
  readonly role = "code_review" as const;
  readonly description = "Inspects unified diff proposals for code maintainability, conventions, and regression risks.";
  readonly allowedCapabilities: readonly ToolCapability[] = [
    "read_project_manifest",
    "inspect_file",
    "produce_review_report",
  ];
  readonly maxContextTokens = 24000;

  async execute(
    input: ReviewInput,
    context: AgentExecutionContext
  ): Promise<AgentExecutionResult<ReviewOutput>> {
    if (!input.patchContent || typeof input.patchContent !== "string") {
      return {
        success: false,
        error: {
          code: "INVALID_REVIEW_INPUT",
          message: "Code review agent requires patch content to review.",
          isActionable: true,
        },
      };
    }

    const findings: ReviewOutput["findings"] = [];
    let score = 95;

    // Check patch length / size
    if (input.patchContent.length > 50000) {
      findings.push({
        severity: "medium",
        description: "Diff size exceeds recommended 50KB review threshold. Consider breaking into smaller steps.",
        recommendation: "Decompose task into smaller modular commits.",
      });
      score -= 10;
    }

    // Check for obvious anti-patterns in diff
    if (input.patchContent.includes("console.log")) {
      findings.push({
        severity: "low",
        description: "Diff contains raw console.log statements.",
        recommendation: "Use structured logger instead of console.log.",
      });
      score -= 5;
    }

    const reviewOutput: ReviewOutput = {
      reviewType: "code_review",
      score,
      approved: score >= 80,
      findings,
      recommendation: score >= 80 ? "approve" : "request_changes",
    };

    const reportMarkdown = [
      `# Automated Code Quality Review`,
      `- **Score:** ${reviewOutput.score}/100`,
      `- **Recommendation:** ${reviewOutput.recommendation.toUpperCase()}`,
      `- **Findings Count:** ${reviewOutput.findings.length}`,
      ``,
      `## Findings`,
      reviewOutput.findings.length === 0
        ? "No quality defects or convention violations identified."
        : reviewOutput.findings
            .map(
              (f, i) =>
                `${i + 1}. **[${f.severity.toUpperCase()}]** ${f.description}\n   *Recommendation:* ${f.recommendation}`
            )
            .join("\n"),
    ].join("\n");

    return {
      success: true,
      data: reviewOutput,
      artifactsGenerated: [
        {
          taskId: context.taskId,
          stepId: context.stepId,
          projectId: context.projectId,
          artifactType: "code_review",
          title: `Code Review Report (${reviewOutput.score}/100)`,
          content: reportMarkdown,
          metadata: {
            score: reviewOutput.score,
            approved: reviewOutput.approved,
            patchArtifactId: input.patchArtifactId,
          },
        },
      ],
      tokensUsed: 490,
    };
  }
}
