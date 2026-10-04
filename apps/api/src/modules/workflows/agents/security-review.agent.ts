import type {
  AgentContract,
  AgentExecutionContext,
  AgentExecutionResult,
  ReviewInput,
  ReviewOutput,
  ToolCapability,
} from "../types.js";

const SECRET_DETECTION_REGEX = /(?:password|secret|api_?key|token|jwt|auth)\s*[:=]\s*['"][a-zA-Z0-9_\-\.]{8,}['"]/i;
const COMMAND_INJECTION_REGEX = /\b(?:exec|execSync|spawn|spawnSync|fork)\s*\(/i;
const PATH_TRAVERSAL_REGEX = /\.\.\/|\.\.\\/;

export class SecurityReviewAgent implements AgentContract<ReviewInput, ReviewOutput> {
  readonly role = "security_review" as const;
  readonly description = "Conducts adversarial security review of proposed patches for secrets, injection, and authorization risks.";
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
          code: "INVALID_SECURITY_INPUT",
          message: "Security review agent requires patch content to review.",
          isActionable: true,
        },
      };
    }

    const findings: ReviewOutput["findings"] = [];
    let score = 100;

    // Check for hardcoded credentials
    if (SECRET_DETECTION_REGEX.test(input.patchContent)) {
      findings.push({
        severity: "critical",
        description: "Hardcoded credentials or sensitive token pattern detected in proposed diff.",
        recommendation: "Remove secret and load from validated environment variables or secrets manager.",
      });
      score -= 50;
    }

    // Check for unsafe shell/command execution
    if (COMMAND_INJECTION_REGEX.test(input.patchContent)) {
      findings.push({
        severity: "high",
        description: "Unsafe process execution function detected in proposed diff.",
        recommendation: "Avoid arbitrary shell command execution. Use bounded, typed APIs.",
      });
      score -= 30;
    }

    // Check for path traversal patterns
    if (PATH_TRAVERSAL_REGEX.test(input.patchContent)) {
      findings.push({
        severity: "high",
        description: "Relative directory traversal sequence (../) detected in file path manipulations.",
        recommendation: "Enforce strict workspace path normalization and containment validation.",
      });
      score -= 20;
    }

    const approved = score >= 80 && !findings.some((f) => f.severity === "critical");

    const reviewOutput: ReviewOutput = {
      reviewType: "security_review",
      score: Math.max(score, 0),
      approved,
      findings,
      recommendation: approved ? "approve" : "reject",
    };

    const reportMarkdown = [
      `# Automated Security Audit Review`,
      `- **Score:** ${reviewOutput.score}/100`,
      `- **Security Approved:** ${reviewOutput.approved ? "YES" : "NO"}`,
      `- **Recommendation:** ${reviewOutput.recommendation.toUpperCase()}`,
      `- **Vulnerabilities Found:** ${reviewOutput.findings.length}`,
      ``,
      `## Vulnerability Scan Results`,
      reviewOutput.findings.length === 0
        ? "No security defects, credential exposures, or injection vectors detected."
        : reviewOutput.findings
            .map(
              (f, i) =>
                `${i + 1}. **[${f.severity.toUpperCase()}]** ${f.description}\n   *Mitigation:* ${f.recommendation}`
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
          artifactType: "security_review",
          title: `Security Review Report (${reviewOutput.score}/100)`,
          content: reportMarkdown,
          metadata: {
            score: reviewOutput.score,
            approved: reviewOutput.approved,
            patchArtifactId: input.patchArtifactId,
            findingsCount: reviewOutput.findings.length,
          },
        },
      ],
      tokensUsed: 510,
    };
  }
}
