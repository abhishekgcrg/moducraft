import type { AIProviderAdapter, ConnectionTestResult } from "./base.js";
import {
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type DecryptedProviderConfig,
  ProviderAuthenticationError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from "../types.js";

export class MockAIProviderAdapter implements AIProviderAdapter {
  readonly providerType = "mock";

  async generateChatCompletion(
    request: ChatCompletionRequest,
    config: DecryptedProviderConfig
  ): Promise<ChatCompletionResponse> {
    const promptText = request.messages.map((m) => m.content).join(" ");

    // Simulated error triggers for integration testing
    if (promptText.includes("simulate_auth_error")) {
      throw new ProviderAuthenticationError("Mock provider authentication failed.", this.providerType);
    }
    if (promptText.includes("simulate_rate_limit")) {
      throw new ProviderRateLimitError("Mock provider rate limit exceeded.", 2, this.providerType);
    }
    if (promptText.includes("simulate_timeout")) {
      throw new ProviderTimeoutError("Mock provider request timed out.", this.providerType);
    }
    if (promptText.includes("simulate_unavailable")) {
      throw new ProviderUnavailableError("Mock provider service temporarily unavailable.", this.providerType);
    }

    // Deterministic mock token calculation
    const promptTokens = Math.max(10, Math.ceil(promptText.length / 4));
    const mockOutput = `[Mock AI Response for ${config.modelId}] Completed task analysis deterministically.`;
    const completionTokens = Math.max(15, Math.ceil(mockOutput.length / 4));

    return {
      content: mockOutput,
      model: config.modelId,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      finishReason: "stop",
    };
  }

  async testConnection(config: DecryptedProviderConfig): Promise<ConnectionTestResult> {
    if (config.apiKey === "invalid_test_key") {
      throw new ProviderAuthenticationError("Invalid API key provided for connection test.", this.providerType);
    }

    return {
      success: true,
      latencyMs: 15,
      model: config.modelId,
      message: "Mock provider connection healthy.",
    };
  }
}
