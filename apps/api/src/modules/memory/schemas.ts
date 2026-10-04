import { z } from "zod";

export const CreateConversationSchema = z.object({
  organizationId: z.string().uuid("Invalid organizationId format"),
  projectId: z.string().uuid("Invalid projectId format").optional().nullable(),
  title: z.string().min(1, "Title is required").max(200, "Title cannot exceed 200 characters"),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const UpdateConversationSchema = z.object({
  title: z.string().min(1, "Title must not be empty").max(200, "Title cannot exceed 200 characters").optional(),
  status: z.enum(["active", "archived"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const AppendUserMessageSchema = z.object({
  content: z.string().min(1, "Message content cannot be empty").max(32000, "Message content cannot exceed 32000 characters"),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const ListConversationsQuerySchema = z.object({
  organizationId: z.string().uuid("Invalid organizationId"),
  projectId: z.string().uuid("Invalid projectId").optional(),
  status: z.enum(["active", "archived"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const ListMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  beforeSequence: z.coerce.number().int().min(1).optional(),
  afterSequence: z.coerce.number().int().min(1).optional(),
  order: z.enum(["asc", "desc"]).default("asc"),
});

export const CreateMemorySchema = z.object({
  organizationId: z.string().uuid("Invalid organizationId format"),
  scope: z.enum(["user", "organization", "project", "task"]),
  userId: z.string().uuid("Invalid userId format").optional().nullable(),
  projectId: z.string().uuid("Invalid projectId format").optional().nullable(),
  taskId: z.string().uuid("Invalid taskId format").optional().nullable(),
  agentId: z.string().min(1).max(80).optional().nullable(),
  key: z.string().min(1, "Memory key is required").max(120, "Memory key cannot exceed 120 characters"),
  content: z.string().min(1, "Memory content cannot be empty").max(10000, "Memory content cannot exceed 10000 characters"),
  category: z.enum(["fact", "preference", "instruction", "context", "summary", "general"]).default("general"),
  source: z.enum(["manual", "conversation", "task_execution", "system"]).default("manual"),
  metadata: z.record(z.string(), z.unknown()).optional(),
  expiresAt: z.string().datetime().optional().nullable(),
});

export const UpdateMemorySchema = z.object({
  content: z.string().min(1, "Memory content cannot be empty").max(10000, "Memory content cannot exceed 10000 characters").optional(),
  category: z.enum(["fact", "preference", "instruction", "context", "summary", "general"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  expiresAt: z.string().datetime().optional().nullable(),
});

export const ListMemoriesQuerySchema = z.object({
  organizationId: z.string().uuid("Invalid organizationId"),
  scope: z.enum(["user", "organization", "project", "task"]).optional(),
  projectId: z.string().uuid("Invalid projectId").optional(),
  taskId: z.string().uuid("Invalid taskId").optional(),
  category: z.enum(["fact", "preference", "instruction", "context", "summary", "general"]).optional(),
  search: z.string().max(200).optional(),
  includeExpired: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const AssembleContextSchema = z.object({
  systemPrompt: z.string().max(10000).optional(),
  maxTokens: z.number().int().min(100).max(128000).optional(),
  includeMemoryScopes: z.array(z.enum(["user", "organization", "project", "task"])).optional(),
  memoryCategories: z.array(z.enum(["fact", "preference", "instruction", "context", "summary", "general"])).optional(),
  projectId: z.string().uuid().optional().nullable(),
  taskId: z.string().uuid().optional().nullable(),
  agentId: z.string().max(80).optional().nullable(),
  redactSecrets: z.boolean().optional(),
});
