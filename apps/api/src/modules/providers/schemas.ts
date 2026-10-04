import { z } from "zod";

export const CreateProviderConfigSchema = z
  .object({
    organizationId: z.string().uuid({ message: "organizationId must be a valid UUID." }),
    providerType: z.enum(["openai", "anthropic", "custom", "mock"], {
      message: "providerType must be one of: 'openai', 'anthropic', 'custom', 'mock'.",
    }),
    name: z
      .string()
      .trim()
      .min(1, { message: "name cannot be empty." })
      .max(100, { message: "name must not exceed 100 characters." }),
    baseUrl: z
      .string()
      .trim()
      .min(1, { message: "baseUrl cannot be empty." })
      .max(500, { message: "baseUrl must not exceed 500 characters." }),
    modelId: z
      .string()
      .trim()
      .min(1, { message: "modelId cannot be empty." })
      .max(100, { message: "modelId must not exceed 100 characters." }),
    apiKey: z
      .string()
      .trim()
      .min(1, { message: "apiKey cannot be empty." })
      .max(500, { message: "apiKey must not exceed 500 characters." }),
    isEnabled: z.boolean().optional().default(true),
    tokenBudgetMonthly: z.coerce.number().int().min(0).max(10_000_000_000).optional().default(1_000_000),
  })
  .strict();

export const UpdateProviderConfigSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, { message: "name cannot be empty." })
      .max(100, { message: "name must not exceed 100 characters." })
      .optional(),
    baseUrl: z
      .string()
      .trim()
      .min(1, { message: "baseUrl cannot be empty." })
      .max(500, { message: "baseUrl must not exceed 500 characters." })
      .optional(),
    modelId: z
      .string()
      .trim()
      .min(1, { message: "modelId cannot be empty." })
      .max(100, { message: "modelId must not exceed 100 characters." })
      .optional(),
    apiKey: z
      .string()
      .trim()
      .min(1, { message: "apiKey cannot be empty." })
      .max(500, { message: "apiKey must not exceed 500 characters." })
      .optional(),
    isEnabled: z.boolean().optional(),
    tokenBudgetMonthly: z.coerce.number().int().min(0).max(10_000_000_000).optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided for update.",
  });

export const ListProviderConfigsQuerySchema = z
  .object({
    organizationId: z.string().uuid({ message: "organizationId must be a valid UUID." }),
  })
  .strict();
