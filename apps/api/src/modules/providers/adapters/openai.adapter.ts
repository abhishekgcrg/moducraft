import type { AIProviderAdapter, ConnectionTestResult } from "./base.js";
import {
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type DecryptedProviderConfig,
  ProviderAuthenticationError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  ProviderValidationError,
  ProviderUnavailableError,
  ProviderError,
} from "../types.js";
import { validateProviderBaseUrl } from "../ssrf.js";

export interface OpenAIAdapterOptions {
  timeoutMs?: number;
  maxRetries?: number;
}

export class OpenAICompatibleAdapter implements AIProviderAdapter {
  readonly providerType: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(providerType: string = "openai", options: OpenAIAdapterOptions = {}) {
    this.providerType = providerType;
    this.timeoutMs = Math.min(Math.max(options.timeoutMs ?? 15000, 2000), 30000);
    this.maxRetries = Math.min(Math.max(options.maxRetries ?? 2, 0), 3);
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private parseRetryAfter(headerValue: string | null): number | undefined {
    if (!headerValue) return undefined;
    const seconds = parseInt(headerValue, 10);
    if (!isNaN(seconds) && seconds > 0 && seconds <= 15) {
      return seconds;
    }
    return undefined;
  }

  async generateChatCompletion(
    request: ChatCompletionRequest,
    config: DecryptedProviderConfig
  ): Promise<ChatCompletionResponse> {
    const validatedBaseUrl = await validateProviderBaseUrl(config.baseUrl);
    const endpoint = `${validatedBaseUrl.replace(/\/+$/, "")}/v1/chat/completions`;

    const payload = {
      model: request.model ?? config.modelId,
      messages: request.messages,
      temperature: request.temperature ?? 0.7,
      max_tokens: request.maxTokens ?? 1024,
    };

    let attempt = 0;
    while (attempt <= this.maxRetries) {
      attempt++;
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: "error", // Prevent automatic redirects to prevent SSRF redirect bypass
        });

        if (response.ok) {
          const data: any = await response.json();
          const choice = data.choices?.[0];
          const content = choice?.message?.content ?? "";
          const usage = data.usage ?? {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          };

          return {
            content,
            model: data.model ?? config.modelId,
            usage: {
              promptTokens: Number(usage.prompt_tokens) || 0,
              completionTokens: Number(usage.completion_tokens) || 0,
              totalTokens: Number(usage.total_tokens) || 0,
            },
            finishReason: choice?.finish_reason,
          };
        }

        // Handle error responses safely without leaking raw bodies or credentials
        const status = response.status;
        let errorMessage = `Provider returned HTTP ${status}.`;
        try {
          const errorJson: any = await response.json();
          if (errorJson?.error?.message) {
            errorMessage = String(errorJson.error.message).slice(0, 200);
          }
        } catch {
          // If non-JSON, keep generic error message
        }

        if (status === 401 || status === 403) {
          throw new ProviderAuthenticationError(errorMessage, this.providerType);
        }

        if (status === 400 || status === 422) {
          throw new ProviderValidationError(errorMessage, this.providerType);
        }

        if (status === 429) {
          const retryAfter = this.parseRetryAfter(response.headers.get("retry-after"));
          if (attempt <= this.maxRetries) {
            const delayMs = retryAfter ? retryAfter * 1000 : 500 * Math.pow(2, attempt) + Math.random() * 200;
            await this.sleep(delayMs);
            continue;
          }
          throw new ProviderRateLimitError(errorMessage, retryAfter, this.providerType);
        }

        if (status >= 500 && status < 600) {
          if (attempt <= this.maxRetries) {
            const delayMs = 500 * Math.pow(2, attempt) + Math.random() * 200;
            await this.sleep(delayMs);
            continue;
          }
          throw new ProviderUnavailableError(errorMessage, this.providerType);
        }

        throw new ProviderError("PROVIDER_REQUEST_FAILED", errorMessage, status, false, this.providerType);
      } catch (err: any) {
        if (err instanceof ProviderError) throw err;

        if (err.name === "TimeoutError" || err.name === "AbortError") {
          if (attempt <= this.maxRetries) {
            await this.sleep(500 * attempt);
            continue;
          }
          throw new ProviderTimeoutError("Provider request timed out after maximum attempts.", this.providerType);
        }

        // Network or DNS failure
        if (attempt <= this.maxRetries) {
          await this.sleep(500 * attempt);
          continue;
        }
        throw new ProviderUnavailableError(
          `Unable to connect to AI provider: ${err.message || "Network error"}`,
          this.providerType
        );
      }
    }

    throw new ProviderUnavailableError("Provider request exhausted retry limits.", this.providerType);
  }

  async testConnection(config: DecryptedProviderConfig): Promise<ConnectionTestResult> {
    const startTime = Date.now();
    try {
      const result = await this.generateChatCompletion(
        {
          messages: [{ role: "user", content: "ping" }],
          maxTokens: 5,
        },
        config
      );

      const latencyMs = Date.now() - startTime;
      return {
        success: true,
        latencyMs,
        model: result.model,
        message: "Connection verified successfully.",
      };
    } catch (err: any) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderUnavailableError(err.message || "Connection test failed.", this.providerType);
    }
  }
}
