export type TaskStatus =
  | "queued"
  | "planning"
  | "running"
  | "waiting_for_approval"
  | "succeeded"
  | "failed"
  | "cancelled";

export type StepStatus =
  | "pending"
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export type AgentEventType =
  | "task.created"
  | "task.planned"
  | "task.started"
  | "step.started"
  | "step.succeeded"
  | "step.failed"
  | "step.retried"
  | "task.succeeded"
  | "task.failed"
  | "task.cancelled"
  | "task.recovered";

export interface AgentTaskDto {
  id: string;
  organizationId: string;
  projectId: string | null;
  providerConfigId: string | null;
  createdBy: string;
  taskType: string;
  title: string;
  inputSummary: string | null;
  inputData: Record<string, unknown>;
  status: TaskStatus;
  currentStepKey: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  steps?: AgentTaskStepDto[];
  events?: AgentTaskEventDto[];
}

export interface AgentTaskStepDto {
  id: string;
  taskId: string;
  organizationId: string;
  stepKey: string;
  stepType: string;
  position: number;
  status: StepStatus;
  inputData: Record<string, unknown>;
  resultData: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
  attemptCount: number;
  maxAttempts: number;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface AgentTaskEventDto {
  id: string;
  taskId: string;
  organizationId: string;
  stepId: string | null;
  eventType: AgentEventType;
  actorUserId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface CreateAgentTaskInput {
  organizationId: string;
  projectId?: string | null;
  providerConfigId?: string | null;
  taskType: string;
  title: string;
  inputData?: Record<string, unknown>;
}

export interface PlanStepDefinition {
  stepKey: string;
  stepType: string;
  position: number;
  inputData: Record<string, unknown>;
  maxAttempts?: number;
}
