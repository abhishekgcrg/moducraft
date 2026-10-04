import type {
  AgentContract,
  AgentExecutionContext,
  AgentExecutionResult,
  PlannerInput,
  PlannerOutput,
  ToolCapability,
} from "../types.js";
import { AIProviderService } from "../../providers/provider.service.js";

export class PlannerAgent implements AgentContract<PlannerInput, PlannerOutput> {
  readonly role = "planner" as const;
  readonly description = "Analyzes requirements and breaks them down into ordered, typed workflow steps.";
  readonly allowedCapabilities: readonly ToolCapability[] = [
    "read_workflow_status",
    "read_project_manifest",
    "inspect_file",
  ];
  readonly maxContextTokens = 16000;

  constructor(private readonly providerService = new AIProviderService()) {}

  async execute(
    input: PlannerInput,
    context: AgentExecutionContext
  ): Promise<AgentExecutionResult<PlannerOutput>> {
    if (!input.title || !input.requirements || input.requirements.length === 0) {
      return {
        success: false,
        error: {
          code: "INVALID_PLANNER_INPUT",
          message: "Planner requires a title and at least one requirement.",
          isActionable: true,
        },
      };
    }

    // Deterministic planning logic: plans pipeline steps for coding, testing, review, and documentation
    const plannedSteps = [
      {
        stepKey: "generate_code_changes",
        agentRole: "coding" as const,
        description: `Implement code changes for: ${input.title}`,
        targetFiles: ["src/index.ts"],
        requiresApproval: false,
      },
      {
        stepKey: "run_automated_tests",
        agentRole: "testing" as const,
        description: "Run automated test suite and typechecks on proposed changes",
        targetFiles: ["src/index.test.ts"],
        requiresApproval: false,
      },
      {
        stepKey: "peer_code_review",
        agentRole: "code_review" as const,
        description: "Perform static code quality review on proposed diff",
        targetFiles: [],
        requiresApproval: false,
      },
      {
        stepKey: "security_vulnerability_scan",
        agentRole: "security_review" as const,
        description: "Scan proposed diff for secrets, traversal, and security flaws",
        targetFiles: [],
        requiresApproval: false,
      },
      {
        stepKey: "apply_patch_approval_gate",
        agentRole: "coding" as const,
        description: "Human approval gate before applying patch to project workspace",
        targetFiles: [],
        requiresApproval: true, // Approval gate!
      },
      {
        stepKey: "generate_documentation",
        agentRole: "documentation" as const,
        description: "Generate documentation update and release notes",
        targetFiles: ["README.md"],
        requiresApproval: false,
      },
    ];

    const planOutput: PlannerOutput = {
      planTitle: `Implementation Plan: ${input.title}`,
      architectureSummary: `Modular execution plan covering requirements: ${input.requirements.join("; ")}`,
      plannedSteps,
      totalEstimatedSteps: plannedSteps.length,
    };

    return {
      success: true,
      data: planOutput,
      artifactsGenerated: [
        {
          taskId: context.taskId,
          stepId: context.stepId,
          projectId: context.projectId,
          artifactType: "plan",
          title: `Plan: ${input.title}`,
          content: JSON.stringify(planOutput, null, 2),
        },
      ],
      tokensUsed: 450,
    };
  }
}
