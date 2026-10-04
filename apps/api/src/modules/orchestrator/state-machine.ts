import { ConflictError } from "../../errors/app-errors.js";
import type { TaskStatus, StepStatus } from "./types.js";

/**
 * Allowed task state transitions.
 */
const ALLOWED_TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  queued: ["planning", "running", "cancelled"],
  planning: ["running", "failed", "cancelled"],
  running: ["waiting_for_approval", "succeeded", "failed", "cancelled"],
  waiting_for_approval: ["running", "cancelled"],
  failed: ["running"], // Recoverable via retry only if attempts remain
  succeeded: [], // Terminal
  cancelled: [], // Terminal
};

/**
 * Allowed step state transitions.
 */
const ALLOWED_STEP_TRANSITIONS: Record<StepStatus, StepStatus[]> = {
  pending: ["ready", "skipped", "cancelled"],
  ready: ["running", "cancelled"],
  running: ["succeeded", "failed", "cancelled"],
  failed: ["ready"], // Retry resets to ready
  succeeded: [], // Terminal
  skipped: [], // Terminal
  cancelled: [], // Terminal
};

export class OrchestratorStateMachine {
  /**
   * Asserts whether a task transition from current to target is legally permitted.
   * Throws ConflictError (409) if the transition violates the state machine.
   */
  static assertValidTaskTransition(current: TaskStatus, target: TaskStatus): void {
    if (current === target) {
      return; // Idempotent same-state check
    }

    const legal = ALLOWED_TASK_TRANSITIONS[current] ?? [];
    if (!legal.includes(target)) {
      throw new ConflictError(
        `Invalid task state transition from '${current}' to '${target}'.`
      );
    }
  }

  /**
   * Asserts whether a step transition from current to target is legally permitted.
   * Throws ConflictError (409) if the transition violates the state machine.
   */
  static assertValidStepTransition(current: StepStatus, target: StepStatus): void {
    if (current === target) {
      return;
    }

    const legal = ALLOWED_STEP_TRANSITIONS[current] ?? [];
    if (!legal.includes(target)) {
      throw new ConflictError(
        `Invalid step state transition from '${current}' to '${target}'.`
      );
    }
  }

  /**
   * Returns true if task is in a terminal state that cannot transition.
   */
  static isTaskTerminal(status: TaskStatus): boolean {
    return status === "succeeded" || status === "cancelled";
  }

  /**
   * Returns true if step is in a terminal state.
   */
  static isStepTerminal(status: StepStatus): boolean {
    return status === "succeeded" || status === "skipped" || status === "cancelled";
  }
}
