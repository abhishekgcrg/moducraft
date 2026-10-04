import { AppError } from "../../errors/app-errors.js";

export type ProviderType = "openai" | "anthropic" | "custom" | "mock";

export interface ProviderConfigDto {
  id: string;
  organizationId: string;
  providerType: ProviderType;
  name: string;
  baseUrl: string;
  modelId: string;
  keyPrefix: string;
  keySuffix: string;
  isEnabled: boolean;
  tokenBudgetMonthly: number;
  tokensUsedMonth: number;
  version: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DecryptedProviderConfig extends ProviderConfigDto {
  apiKey: string;
}

export interface CreateProviderConfigInput {
  organizationId: string;
  providerType: ProviderType;
  name: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
  isEnabled?: boolean;
  tokenBudgetMonthly?: number;
}

export interface UpdateProviderConfigInput {
  name?: string;
  baseUrl?: string;
  modelId?: string;
  apiKey?: string; // Optional key rotation
  isEnabled?: boolean;
  tokenBudgetMonthly?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatCompletionResponse {
  content: string;
  model: string;
  usage: TokenUsage;
  finishReason?: string;
}

// Normalized Error Hierarchy

export class ProviderError extends AppError {
  public readonly providerType?: string;
  public readonly isRetryable: boolean;

  constructor(
    code: string,
    message: string,
    statusCode: number,
    isRetryable: boolean = false,
    providerType?: string,
    details?: unknown
  ) {
    super(message, code, statusCode, details);
    this.name = "ProviderError";
    this.isRetryable = isRetryable;
    this.providerType = providerType;
  }
}

export class ProviderAuthenticationError extends ProviderError {
  constructor(message = "Provider authentication failed. Verify API key or credentials.", providerType?: string) {
    super("PROVIDER_AUTHENTICATION_ERROR", message, 401, false, providerType);
    this.name = "ProviderAuthenticationError";
  }
}

export class ProviderRateLimitError extends ProviderError {
  public readonly retryAfterSeconds?: number;

  constructor(
    message = "Provider rate limit exceeded. Please retry later.",
    retryAfterSeconds?: number,
    providerType?: string
  ) {
    super("PROVIDER_RATE_LIMIT_ERROR", message, 429, true, providerType, { retryAfterSeconds });
    this.name = "ProviderRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ProviderTimeoutError extends ProviderError {
  constructor(message = "Provider request timed out.", providerType?: string) {
    super("PROVIDER_TIMEOUT_ERROR", message, 504, true, providerType);
    this.name = "ProviderTimeoutError";
  }
}

export class ProviderValidationError extends ProviderError {
  constructor(message = "Invalid request sent to AI provider.", providerType?: string, details?: unknown) {
    super("PROVIDER_VALIDATION_ERROR", message, 400, false, providerType, details);
    this.name = "ProviderValidationError";
  }
}

export class ProviderUnavailableError extends ProviderError {
  constructor(message = "AI provider is currently unavailable or returned a server error.", providerType?: string) {
    super("PROVIDER_UNAVAILABLE_ERROR", message, 503, true, providerType);
    this.name = "ProviderUnavailableError";
  }
}

export class ProviderBudgetExceededError extends ProviderError {
  constructor(
    organizationId: string,
    currentUsage: number,
    budgetLimit: number,
    providerType?: string
  ) {
    super(
      "PROVIDER_BUDGET_EXCEEDED",
      `Monthly token budget of ${budgetLimit} tokens exceeded (Current usage: ${currentUsage}).`,
      429,
      false,
      providerType,
      { organizationId, currentUsage, budgetLimit }
    );
    this.name = "ProviderBudgetExceededError";
  }
}
