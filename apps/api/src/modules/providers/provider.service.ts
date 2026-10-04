import type { ScopedTransaction } from "../../db/transaction.js";
import {
  NotFoundError,
  ForbiddenError,
  ValidationError,
  ConflictError,
} from "../../errors/app-errors.js";
import {
  type ProviderConfigDto,
  type DecryptedProviderConfig,
  type CreateProviderConfigInput,
  type UpdateProviderConfigInput,
  type TokenUsage,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  ProviderBudgetExceededError,
} from "./types.js";
import { encryptSecret, decryptSecret, maskApiKey } from "./crypto.js";
import { validateProviderBaseUrl } from "./ssrf.js";
import { MockAIProviderAdapter } from "./adapters/mock.adapter.js";
import { OpenAICompatibleAdapter } from "./adapters/openai.adapter.js";
import type { AIProviderAdapter, ConnectionTestResult } from "./adapters/base.js";

interface ProviderConfigRow {
  id: string;
  organization_id: string;
  provider_type: string;
  name: string;
  base_url: string;
  model_id: string;
  encrypted_api_key: string;
  key_prefix: string;
  key_suffix: string;
  is_enabled: boolean;
  token_budget_monthly: string | number;
  tokens_used_month: string | number;
  version: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

interface OrgRoleRow {
  role: "owner" | "admin" | "member" | "viewer";
}

export class AIProviderService {
  private getAdapter(providerType: string): AIProviderAdapter {
    switch (providerType) {
      case "mock":
        return new MockAIProviderAdapter();
      case "openai":
      case "custom":
      default:
        return new OpenAICompatibleAdapter(providerType);
    }
  }

  private mapDto(row: ProviderConfigRow): ProviderConfigDto {
    return {
      id: row.id,
      organizationId: row.organization_id,
      providerType: row.provider_type as any,
      name: row.name,
      baseUrl: row.base_url,
      modelId: row.model_id,
      keyPrefix: row.key_prefix,
      keySuffix: row.key_suffix,
      isEnabled: row.is_enabled,
      tokenBudgetMonthly: Number(row.token_budget_monthly),
      tokensUsedMonth: Number(row.tokens_used_month),
      version: row.version,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private async assertOrgRole(
    tx: ScopedTransaction,
    orgId: string,
    userId: string,
    allowedRoles: string[]
  ): Promise<OrgRoleRow["role"]> {
    const roleResult = await tx.query<OrgRoleRow>(
      `SELECT role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2;`,
      [orgId, userId]
    );

    const membership = roleResult.rows[0];
    if (!membership) {
      throw new NotFoundError("Organization");
    }

    if (!allowedRoles.includes(membership.role)) {
      throw new ForbiddenError(
        `Action requires one of the following roles: ${allowedRoles.join(", ")}. Current role: '${membership.role}'.`
      );
    }

    return membership.role;
  }

  /**
   * Create a new AI provider configuration for an organization with encrypted secret.
   */
  async createProviderConfig(
    tx: ScopedTransaction,
    userId: string,
    input: CreateProviderConfigInput
  ): Promise<ProviderConfigDto> {
    // Only owner and admin can configure external AI providers and secrets
    await this.assertOrgRole(tx, input.organizationId, userId, ["owner", "admin"]);

    // Validate URL against SSRF
    const validatedBaseUrl = await validateProviderBaseUrl(input.baseUrl, {
      allowLocalMock: input.providerType === "mock",
    });

    // Encrypt secret bound to tenant AAD
    const encryptedKey = encryptSecret(input.apiKey, input.organizationId);
    const { prefix, suffix } = maskApiKey(input.apiKey);

    const budget = input.tokenBudgetMonthly ?? 1000000;
    if (budget < 0) {
      throw new ValidationError("Token budget must be greater than or equal to 0.");
    }

    // Check duplicate name within tenant
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM provider_configs WHERE organization_id = $1 AND name = $2;`,
      [input.organizationId, input.name.trim()]
    );
    if (existing.rows.length > 0) {
      throw new ConflictError(`A provider configuration named '${input.name.trim()}' already exists.`);
    }

    const insertResult = await tx.query<ProviderConfigRow>(
      `INSERT INTO provider_configs (
         organization_id, provider_type, name, base_url, model_id,
         encrypted_api_key, key_prefix, key_suffix, is_enabled,
         token_budget_monthly, tokens_used_month, version, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, 1, $11)
       RETURNING *;`,
      [
        input.organizationId,
        input.providerType,
        input.name.trim(),
        validatedBaseUrl,
        input.modelId.trim(),
        encryptedKey,
        prefix,
        suffix,
        input.isEnabled ?? true,
        budget,
        userId,
      ]
    );

    const row = insertResult.rows[0];

    // Atomically record audit event without leaking secret
    await tx.query(
      `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
      [
        input.organizationId,
        "provider_config.created",
        "provider_config",
        row.id,
        "success",
        JSON.stringify({
          providerType: row.provider_type,
          name: row.name,
          modelId: row.model_id,
          keyPrefix: row.key_prefix,
        }),
      ]
    );

    return this.mapDto(row);
  }

  /**
   * List provider configurations for caller's organization under forced RLS.
   */
  async listProviderConfigs(
    tx: ScopedTransaction,
    organizationId: string,
    userId: string
  ): Promise<ProviderConfigDto[]> {
    await this.assertOrgRole(tx, organizationId, userId, ["owner", "admin", "member", "viewer"]);

    const result = await tx.query<ProviderConfigRow>(
      `SELECT * FROM provider_configs
       WHERE organization_id = $1
       ORDER BY created_at DESC;`,
      [organizationId]
    );

    return result.rows.map((row) => this.mapDto(row));
  }

  /**
   * Retrieve a single provider configuration under forced RLS.
   */
  async getProviderConfig(
    tx: ScopedTransaction,
    configId: string,
    userId: string
  ): Promise<ProviderConfigDto> {
    const result = await tx.query<ProviderConfigRow>(
      `SELECT * FROM provider_configs WHERE id = $1;`,
      [configId]
    );
    const row = result.rows[0];
    if (!row) {
      throw new NotFoundError("Provider configuration");
    }

    await this.assertOrgRole(tx, row.organization_id, userId, ["owner", "admin", "member", "viewer"]);

    return this.mapDto(row);
  }

  /**
   * Update a provider configuration with optional key rotation.
   */
  async updateProviderConfig(
    tx: ScopedTransaction,
    configId: string,
    userId: string,
    input: UpdateProviderConfigInput
  ): Promise<ProviderConfigDto> {
    const lockResult = await tx.query<ProviderConfigRow>(
      `SELECT * FROM provider_configs WHERE id = $1 FOR UPDATE;`,
      [configId]
    );
    const existing = lockResult.rows[0];
    if (!existing) {
      throw new NotFoundError("Provider configuration");
    }

    await this.assertOrgRole(tx, existing.organization_id, userId, ["owner", "admin"]);

    let baseUrl = existing.base_url;
    if (input.baseUrl !== undefined) {
      baseUrl = await validateProviderBaseUrl(input.baseUrl, {
        allowLocalMock: existing.provider_type === "mock",
      });
    }

    let encryptedKey = existing.encrypted_api_key;
    let keyPrefix = existing.key_prefix;
    let keySuffix = existing.key_suffix;
    let keyRotated = false;

    if (input.apiKey !== undefined && input.apiKey.trim().length > 0) {
      encryptedKey = encryptSecret(input.apiKey, existing.organization_id);
      const masked = maskApiKey(input.apiKey);
      keyPrefix = masked.prefix;
      keySuffix = masked.suffix;
      keyRotated = true;
    }

    const name = input.name !== undefined ? input.name.trim() : existing.name;
    const modelId = input.modelId !== undefined ? input.modelId.trim() : existing.model_id;
    const isEnabled = input.isEnabled !== undefined ? input.isEnabled : existing.is_enabled;
    const budget = input.tokenBudgetMonthly !== undefined ? input.tokenBudgetMonthly : Number(existing.token_budget_monthly);

    if (budget < 0) {
      throw new ValidationError("Token budget must be greater than or equal to 0.");
    }

    const updateResult = await tx.query<ProviderConfigRow>(
      `UPDATE provider_configs
       SET name = $2, base_url = $3, model_id = $4, encrypted_api_key = $5,
           key_prefix = $6, key_suffix = $7, is_enabled = $8,
           token_budget_monthly = $9, version = version + 1
       WHERE id = $1
       RETURNING *;`,
      [configId, name, baseUrl, modelId, encryptedKey, keyPrefix, keySuffix, isEnabled, budget]
    );

    const updatedRow = updateResult.rows[0];

    await tx.query(
      `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
      [
        existing.organization_id,
        "provider_config.updated",
        "provider_config",
        configId,
        "success",
        JSON.stringify({
          keyRotated,
          name: updatedRow.name,
          modelId: updatedRow.model_id,
          isEnabled: updatedRow.is_enabled,
        }),
      ]
    );

    return this.mapDto(updatedRow);
  }

  /**
   * Delete / Revoke a provider configuration.
   */
  async deleteProviderConfig(
    tx: ScopedTransaction,
    configId: string,
    userId: string
  ): Promise<{ success: boolean }> {
    const lockResult = await tx.query<ProviderConfigRow>(
      `SELECT * FROM provider_configs WHERE id = $1 FOR UPDATE;`,
      [configId]
    );
    const existing = lockResult.rows[0];
    if (!existing) {
      throw new NotFoundError("Provider configuration");
    }

    await this.assertOrgRole(tx, existing.organization_id, userId, ["owner", "admin"]);

    await tx.query(`DELETE FROM provider_configs WHERE id = $1;`, [configId]);

    await tx.query(
      `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
      [
        existing.organization_id,
        "provider_config.revoked",
        "provider_config",
        configId,
        "success",
        JSON.stringify({ name: existing.name, providerType: existing.provider_type }),
      ]
    );

    return { success: true };
  }

  /**
   * Internal secure retrieval: decrypts API key with tenant AAD context.
   */
  async getDecryptedConfig(
    tx: ScopedTransaction,
    configId: string
  ): Promise<DecryptedProviderConfig> {
    const result = await tx.query<ProviderConfigRow>(
      `SELECT * FROM provider_configs WHERE id = $1;`,
      [configId]
    );
    const row = result.rows[0];
    if (!row) {
      throw new NotFoundError("Provider configuration");
    }

    if (!row.is_enabled) {
      throw new ValidationError(`Provider configuration '${row.name}' is currently disabled.`);
    }

    const decryptedApiKey = decryptSecret(row.encrypted_api_key, row.organization_id);

    return {
      ...this.mapDto(row),
      apiKey: decryptedApiKey,
    };
  }

  /**
   * Test connection to provider without leaking secrets.
   */
  async testConnection(
    tx: ScopedTransaction,
    configId: string,
    userId: string
  ): Promise<ConnectionTestResult> {
    const config = await this.getDecryptedConfig(tx, configId);
    await this.assertOrgRole(tx, config.organizationId, userId, ["owner", "admin"]);

    const adapter = this.getAdapter(config.providerType);
    const testResult = await adapter.testConnection(config);

    await tx.query(
      `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
      [
        config.organizationId,
        "provider_config.tested",
        "provider_config",
        configId,
        testResult.success ? "success" : "failure",
        JSON.stringify({ latencyMs: testResult.latencyMs, model: testResult.model }),
      ]
    );

    return testResult;
  }

  /**
   * Concurrency-safe budget enforcement and usage recording.
   */
  async recordUsage(
    tx: ScopedTransaction,
    configId: string,
    organizationId: string,
    modelId: string,
    usage: TokenUsage,
    taskId?: string | null,
    stepId?: string | null
  ): Promise<void> {
    // 1. Lock config row to check and increment budget atomically
    const configRes = await tx.query<ProviderConfigRow>(
      `SELECT * FROM provider_configs WHERE id = $1 AND organization_id = $2 FOR UPDATE;`,
      [configId, organizationId]
    );
    const config = configRes.rows[0];
    if (!config) {
      throw new NotFoundError("Provider configuration");
    }

    const currentUsed = Number(config.tokens_used_month);
    const budgetLimit = Number(config.token_budget_monthly);
    const newTotal = currentUsed + usage.totalTokens;

    if (newTotal > budgetLimit) {
      throw new ProviderBudgetExceededError(organizationId, newTotal, budgetLimit, config.provider_type);
    }

    // 2. Increment usage counter
    await tx.query(
      `UPDATE provider_configs
       SET tokens_used_month = tokens_used_month + $2, version = version + 1
       WHERE id = $1;`,
      [configId, usage.totalTokens]
    );

    // 3. Insert append-only usage record
    await tx.query(
      `INSERT INTO provider_usage_records (
         organization_id, provider_config_id, task_id, step_id,
         model_id, prompt_tokens, completion_tokens, total_tokens
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
      [
        organizationId,
        configId,
        taskId ?? null,
        stepId ?? null,
        modelId,
        usage.promptTokens,
        usage.completionTokens,
        usage.totalTokens,
      ]
    );
  }

  /**
   * Execute an AI chat completion request through an authorized, enabled provider configuration.
   * Performs pre-flight budget checks, calls the provider adapter, records usage, and returns normalized response.
   */
  async executeChatCompletion(
    tx: ScopedTransaction,
    configId: string,
    request: ChatCompletionRequest,
    taskId?: string | null,
    stepId?: string | null
  ): Promise<ChatCompletionResponse> {
    const config = await this.getDecryptedConfig(tx, configId);

    // Pre-flight check: ensure budget is not already exhausted
    if (config.tokenBudgetMonthly > 0 && config.tokensUsedMonth >= config.tokenBudgetMonthly) {
      throw new ProviderBudgetExceededError(
        config.organizationId,
        config.tokensUsedMonth,
        config.tokenBudgetMonthly,
        config.providerType
      );
    }

    const adapter = this.getAdapter(config.providerType);
    const response = await adapter.generateChatCompletion(request, config);

    await this.recordUsage(
      tx,
      configId,
      config.organizationId,
      response.model,
      response.usage,
      taskId,
      stepId
    );

    return response;
  }
}
