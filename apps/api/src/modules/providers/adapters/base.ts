import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  DecryptedProviderConfig,
} from "../types.js";

export interface ConnectionTestResult {
  success: boolean;
  latencyMs: number;
  model: string;
  message?: string;
}

export interface AIProviderAdapter {
  readonly providerType: string;

  generateChatCompletion(
    request: ChatCompletionRequest,
    config: DecryptedProviderConfig
  ): Promise<ChatCompletionResponse>;

  testConnection(
    config: DecryptedProviderConfig
  ): Promise<ConnectionTestResult>;
}
