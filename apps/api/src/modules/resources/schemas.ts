import { z } from "zod";

export const ProjectIdParamSchema = z.object({
  projectId: z.string().uuid("Invalid project ID format"),
});

export const ResourceParamsSchema = z.object({
  projectId: z.string().uuid("Invalid project ID format"),
  id: z.string().uuid("Invalid resource ID format"),
});

export const CreateResourceBodySchema = z.object({
  providerId: z.string().min(1).max(64),
  resourceType: z.enum(["database", "object_storage"]),
  name: z.string().min(1).max(120),
  configuration: z.record(z.string(), z.unknown()).optional(),
  endpoint: z.record(z.string(), z.unknown()).optional(),
  initialPassword: z.string().min(1).optional(),
  username: z.string().min(1).max(120).optional(),
  connectionStringTemplate: z.string().optional(),
});

export type CreateResourceBody = z.infer<typeof CreateResourceBodySchema>;

export const ListResourcesQuerySchema = z.object({
  status: z.enum(["active", "provisioning", "failed", "deprovisioned"]).optional(),
  resourceType: z.enum(["database", "object_storage"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50).optional(),
  offset: z.coerce.number().int().min(0).default(0).optional(),
});

export type ListResourcesQuery = z.infer<typeof ListResourcesQuerySchema>;

export const RotateCredentialBodySchema = z.object({
  newPassword: z.string().min(1),
  username: z.string().min(1).max(120).optional(),
  connectionStringTemplate: z.string().optional(),
});

export type RotateCredentialBody = z.infer<typeof RotateCredentialBodySchema>;
