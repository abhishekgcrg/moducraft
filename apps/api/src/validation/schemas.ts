import { z } from "zod";
import { ValidationError } from "../errors/app-errors.js";

const SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const IdParamSchema = z.object({
  id: z.string().uuid({ message: "Invalid ID parameter. Must be a valid UUID." }),
});

export const CreateProjectSchema = z
  .object({
    organizationId: z.string().uuid({ message: "organizationId must be a valid UUID." }),
    name: z
      .string()
      .trim()
      .min(1, { message: "name cannot be empty." })
      .max(120, { message: "name must not exceed 120 characters." }),
    slug: z
      .string()
      .trim()
      .min(1, { message: "slug cannot be empty." })
      .max(120, { message: "slug must not exceed 120 characters." })
      .regex(SLUG_REGEX, {
        message:
          "slug must consist of lowercase alphanumeric characters and single hyphens (e.g. 'my-cool-project').",
      }),
    description: z
      .string()
      .trim()
      .max(2000, { message: "description must not exceed 2000 characters." })
      .nullable()
      .optional(),
  })
  .strict();

export const UpdateProjectSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, { message: "name cannot be empty." })
      .max(120, { message: "name must not exceed 120 characters." })
      .optional(),
    slug: z
      .string()
      .trim()
      .min(1, { message: "slug cannot be empty." })
      .max(120, { message: "slug must not exceed 120 characters." })
      .regex(SLUG_REGEX, {
        message:
          "slug must consist of lowercase alphanumeric characters and single hyphens.",
      })
      .optional(),
    description: z
      .string()
      .trim()
      .max(2000, { message: "description must not exceed 2000 characters." })
      .nullable()
      .optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field (name, slug, or description) must be provided for update.",
  });

export const ListProjectsQuerySchema = z.object({
  organizationId: z.string().uuid({ message: "organizationId must be a valid UUID." }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Validate input with Zod and format friendly ValidationError if invalid.
 */
export function validate<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const message = issue ? `${issue.path.join(".")}: ${issue.message}` : "Validation failed.";
    throw new ValidationError(message, result.error.format());
  }
  return result.data;
}
