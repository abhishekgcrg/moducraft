export interface StepExecutionResult {
  success: boolean;
  resultData?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
}

export class SafePlaceholderExecutor {
  /**
   * Executes a step deterministically using safe internal mock handlers.
   * Completely local: No shell commands, no filesystem writes, no external HTTP calls.
   */
  static async executeStep(
    stepType: string,
    stepKey: string,
    inputData: Record<string, unknown>
  ): Promise<StepExecutionResult> {
    // Explicit simulated failure trigger for testing bounded retries & error handling
    if (inputData.simulateFailure === true || inputData.shouldFail === true) {
      return {
        success: false,
        errorCode: "SIMULATED_STEP_FAILURE",
        errorMessage: `Simulated failure for step '${stepKey}' of type '${stepType}'.`,
      };
    }

    switch (stepType) {
      case "inspect_project_meta":
        return {
          success: true,
          resultData: {
            scannedFilesCount: 42,
            projectType: "modular-monolith",
            frameworks: ["Fastify", "Next.js", "PostgreSQL"],
            timestamp: new Date().toISOString(),
          },
        };

      case "generate_architecture_summary":
        return {
          success: true,
          resultData: {
            modulesIdentified: 6,
            boundariesEnforced: true,
            architecturePattern: "clean-modular-monolith",
            status: "healthy",
          },
        };

      case "compile_report":
        return {
          success: true,
          resultData: {
            reportGenerated: true,
            summaryScore: "A",
            itemsReviewed: 15,
            conclusion: "Planning completed safely within deterministic bounds.",
          },
        };

      case "inspect_manifest":
        return {
          success: true,
          resultData: {
            packagesFound: 2,
            totalDependencies: 18,
            lockedVersions: true,
          },
        };

      case "scan_security_surface":
        return {
          success: true,
          resultData: {
            endpointsProtected: true,
            rlsForced: true,
            vulnerabilitiesFound: 0,
          },
        };

      case "parse_requirements":
        return {
          success: true,
          resultData: {
            requirementsParsed: 8,
            functionalItems: 6,
            nonFunctionalItems: 2,
          },
        };

      case "evaluate_dependencies":
        return {
          success: true,
          resultData: {
            circularDependencies: 0,
            internalLinksValid: true,
          },
        };

      default:
        return {
          success: false,
          errorCode: "UNKNOWN_STEP_TYPE",
          errorMessage: `Unknown step type '${stepType}' cannot be executed by safe placeholder executor.`,
        };
    }
  }
}
