import { ValidationError } from "../../errors/app-errors.js";
import type { PlanStepDefinition } from "./types.js";

export interface TaskPlannerPlan {
  taskType: string;
  summary: string;
  steps: PlanStepDefinition[];
}

export class DeterministicTaskPlanner {
  private static readonly SUPPORTED_TASK_TYPES = [
    "project_summary",
    "repository_review_plan",
    "implementation_plan",
    "ai_text_generation",
  ] as const;

  /**
   * Returns list of supported task types.
   */
  static getSupportedTypes(): readonly string[] {
    return this.SUPPORTED_TASK_TYPES;
  }

  /**
   * Plans a task into ordered, typed workflow steps deterministically without LLM calls.
   */
  static plan(
    taskType: string,
    title: string,
    inputData: Record<string, unknown> = {}
  ): TaskPlannerPlan {
    const normalizedType = taskType.trim().toLowerCase();

    switch (normalizedType) {
      case "project_summary":
        return {
          taskType: "project_summary",
          summary: `Deterministic planning for project summary: ${title}`,
          steps: [
            {
              stepKey: "fetch_project_metadata",
              stepType: "inspect_project_meta",
              position: 1,
              inputData: { ...inputData, focus: "metadata" },
              maxAttempts: 3,
            },
            {
              stepKey: "analyze_architecture",
              stepType: "generate_architecture_summary",
              position: 2,
              inputData: { ...inputData, focus: "architecture" },
              maxAttempts: 3,
            },
            {
              stepKey: "compile_summary_report",
              stepType: "compile_report",
              position: 3,
              inputData: { ...inputData, focus: "summary" },
              maxAttempts: 3,
            },
          ],
        };

      case "repository_review_plan":
        return {
          taskType: "repository_review_plan",
          summary: `Deterministic planning for repository review: ${title}`,
          steps: [
            {
              stepKey: "inventory_manifest",
              stepType: "inspect_manifest",
              position: 1,
              inputData: { ...inputData, scope: "dependencies" },
              maxAttempts: 3,
            },
            {
              stepKey: "security_surface_scan",
              stepType: "scan_security_surface",
              position: 2,
              inputData: { ...inputData, scope: "security" },
              maxAttempts: 3,
            },
            {
              stepKey: "generate_review_checklist",
              stepType: "compile_report",
              position: 3,
              inputData: { ...inputData, scope: "checklist" },
              maxAttempts: 3,
            },
          ],
        };

      case "implementation_plan":
        return {
          taskType: "implementation_plan",
          summary: `Deterministic planning for implementation plan: ${title}`,
          steps: [
            {
              stepKey: "requirements_breakdown",
              stepType: "parse_requirements",
              position: 1,
              inputData: { ...inputData, phase: "breakdown" },
              maxAttempts: 3,
            },
            {
              stepKey: "dependency_graph_check",
              stepType: "evaluate_dependencies",
              position: 2,
              inputData: { ...inputData, phase: "dependencies" },
              maxAttempts: 3,
            },
            {
              stepKey: "task_sequencing",
              stepType: "compile_report",
              position: 3,
              inputData: { ...inputData, phase: "sequencing" },
              maxAttempts: 3,
            },
          ],
        };

      case "ai_text_generation":
        return {
          taskType: "ai_text_generation",
          summary: `Deterministic planning for AI generation: ${title}`,
          steps: [
            {
              stepKey: "generate_ai_response",
              stepType: "ai_chat_completion",
              position: 1,
              inputData: { ...inputData },
              maxAttempts: 3,
            },
            {
              stepKey: "compile_ai_report",
              stepType: "compile_report",
              position: 2,
              inputData: { ...inputData, focus: "ai_generation" },
              maxAttempts: 3,
            },
          ],
        };

      default:
        throw new ValidationError(
          `Unsupported task type '${taskType}'. Supported types are: ${this.SUPPORTED_TASK_TYPES.join(", ")}.`
        );
    }
  }
}
