import { z } from "zod";

export const CreateAgentTaskSchema = z
  .object({
    organizationId: z.string().uuid({ message: "organizationId must be a valid UUID." }),
    projectId: z.string().uuid({ message: "projectId must be a valid UUID." }).nullable().optional(),
    providerConfigId: z.string().uuid({ message: "providerConfigId must be a valid UUID." }).nullable().optional(),
    taskType: z
      .string()
      .trim()
      .min(1, { message: "taskType cannot be empty." })
      .max(80, { message: "taskType must not exceed 80 characters." }),
    title: z
      .string()
      .trim()
      .min(1, { message: "title cannot be empty." })
      .max(200, { message: "title must not exceed 200 characters." }),
    inputData: z.record(z.string(), z.unknown()).optional().default({}),
  })
  .strict();

export const ListAgentTasksQuerySchema = z.object({
  organizationId: z.string().uuid({ message: "organizationId must be a valid UUID." }).optional(),
  projectId: z.string().uuid({ message: "projectId must be a valid UUID." }).optional(),
  status: z
    .enum(["queued", "planning", "running", "waiting_for_approval", "succeeded", "failed", "cancelled"])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const RecoverTasksSchema = z
  .object({
    organizationId: z.string().uuid({ message: "organizationId must be a valid UUID." }),
    limit: z.coerce.number().int().min(1).max(100).default(50).optional(),
  })
  .strict();
