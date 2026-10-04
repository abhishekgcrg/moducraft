import type { ScopedTransaction } from "../../db/transaction.js";
import {
  NotFoundError,
  ForbiddenError,
  ValidationError,
  ConflictError,
} from "../../errors/app-errors.js";
import type {
  ConversationRow,
  ConversationMessageRow,
  AgentMemoryRow,
  ConversationDto,
  ConversationMessageDto,
  AgentMemoryDto,
  CreateConversationInput,
  UpdateConversationInput,
  AppendUserMessageInput,
  AppendInternalMessageInput,
  CreateMemoryInput,
  UpdateMemoryInput,
  ListConversationsQuery,
  ListMessagesQuery,
  ListMemoriesQuery,
  AssembleContextOptions,
  AssembledContextDto,
  MemoryScope,
} from "./types.js";
import { assembleContext, estimateTokens } from "./context-assembler.js";

interface OrgRoleRow {
  role: "owner" | "admin" | "member" | "viewer";
}

export class MemoryService {
  private mapConversation(row: ConversationRow): ConversationDto {
    return {
      id: row.id,
      organizationId: row.organization_id,
      projectId: row.project_id,
      createdBy: row.created_by,
      title: row.title,
      status: row.status as any,
      metadata: row.metadata ?? {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapMessage(row: ConversationMessageRow): ConversationMessageDto {
    return {
      id: row.id,
      organizationId: row.organization_id,
      conversationId: row.conversation_id,
      sequenceNumber: row.sequence_number,
      senderType: row.sender_type as any,
      senderUserId: row.sender_user_id,
      agentId: row.agent_id,
      content: row.content,
      toolCallId: row.tool_call_id,
      metadata: row.metadata ?? {},
      tokenCount: row.token_count,
      createdAt: row.created_at,
    };
  }

  private mapMemory(row: AgentMemoryRow): AgentMemoryDto {
    return {
      id: row.id,
      organizationId: row.organization_id,
      scope: row.scope as any,
      userId: row.user_id,
      projectId: row.project_id,
      taskId: row.task_id,
      agentId: row.agent_id,
      key: row.key,
      content: row.content,
      category: row.category as any,
      source: row.source as any,
      metadata: row.metadata ?? {},
      expiresAt: row.expires_at,
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

  // =========================================================================
  // CONVERSATIONS
  // =========================================================================

  async createConversation(
    tx: ScopedTransaction,
    userId: string,
    input: CreateConversationInput
  ): Promise<ConversationDto> {
    await this.assertOrgRole(tx, input.organizationId, userId, ["owner", "admin", "member"]);

    if (input.projectId) {
      const projResult = await tx.query<{ id: string }>(
        `SELECT id FROM projects WHERE id = $1 AND organization_id = $2;`,
        [input.projectId, input.organizationId]
      );
      if (projResult.rows.length === 0) {
        throw new NotFoundError("Project");
      }
    }

    const result = await tx.query<ConversationRow>(
      `INSERT INTO conversations (organization_id, project_id, created_by, title, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING *;`,
      [
        input.organizationId,
        input.projectId ?? null,
        userId,
        input.title.trim(),
        JSON.stringify(input.metadata ?? {}),
      ]
    );

    const conv = this.mapConversation(result.rows[0]);

    await tx.query(
      `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
      [
        conv.organizationId,
        "conversation.created",
        "conversation",
        conv.id,
        "success",
        JSON.stringify({ title: conv.title, projectId: conv.projectId }),
      ]
    );

    return conv;
  }

  async getConversation(
    tx: ScopedTransaction,
    conversationId: string,
    userId: string
  ): Promise<ConversationDto> {
    const result = await tx.query<ConversationRow>(
      `SELECT * FROM conversations WHERE id = $1;`,
      [conversationId]
    );
    const row = result.rows[0];
    if (!row) {
      throw new NotFoundError("Conversation");
    }

    await this.assertOrgRole(tx, row.organization_id, userId, [
      "owner",
      "admin",
      "member",
      "viewer",
    ]);

    return this.mapConversation(row);
  }

  async listConversations(
    tx: ScopedTransaction,
    orgId: string,
    userId: string,
    query: ListConversationsQuery
  ): Promise<ConversationDto[]> {
    await this.assertOrgRole(tx, orgId, userId, ["owner", "admin", "member", "viewer"]);

    const conditions: string[] = ["organization_id = $1"];
    const params: any[] = [orgId];

    if (query.projectId) {
      params.push(query.projectId);
      conditions.push(`project_id = $${params.length}`);
    }

    if (query.status) {
      params.push(query.status);
      conditions.push(`status = $${params.length}`);
    }

    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;
    params.push(limit, offset);

    const sql = `SELECT * FROM conversations
                 WHERE ${conditions.join(" AND ")}
                 ORDER BY created_at DESC
                 LIMIT $${params.length - 1} OFFSET $${params.length};`;

    const result = await tx.query<ConversationRow>(sql, params);
    return result.rows.map((r) => this.mapConversation(r));
  }

  async updateConversation(
    tx: ScopedTransaction,
    conversationId: string,
    userId: string,
    input: UpdateConversationInput
  ): Promise<ConversationDto> {
    const lockRes = await tx.query<ConversationRow>(
      `SELECT * FROM conversations WHERE id = $1 FOR UPDATE;`,
      [conversationId]
    );
    const existing = lockRes.rows[0];
    if (!existing) {
      throw new NotFoundError("Conversation");
    }

    await this.assertOrgRole(tx, existing.organization_id, userId, ["owner", "admin", "member"]);

    const newTitle = input.title !== undefined ? input.title.trim() : existing.title;
    const newStatus = input.status !== undefined ? input.status : existing.status;
    const newMeta =
      input.metadata !== undefined
        ? JSON.stringify({ ...existing.metadata, ...input.metadata })
        : JSON.stringify(existing.metadata);

    const updateRes = await tx.query<ConversationRow>(
      `UPDATE conversations
       SET title = $1, status = $2, metadata = $3::jsonb
       WHERE id = $4
       RETURNING *;`,
      [newTitle, newStatus, newMeta, conversationId]
    );

    const conv = this.mapConversation(updateRes.rows[0]);

    await tx.query(
      `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
      [
        conv.organizationId,
        "conversation.updated",
        "conversation",
        conv.id,
        "success",
        JSON.stringify({ title: conv.title, status: conv.status }),
      ]
    );

    return conv;
  }

  async deleteConversation(
    tx: ScopedTransaction,
    conversationId: string,
    userId: string
  ): Promise<{ success: boolean }> {
    const lockRes = await tx.query<ConversationRow>(
      `SELECT * FROM conversations WHERE id = $1 FOR UPDATE;`,
      [conversationId]
    );
    const existing = lockRes.rows[0];
    if (!existing) {
      throw new NotFoundError("Conversation");
    }

    await this.assertOrgRole(tx, existing.organization_id, userId, ["owner", "admin"]);

    await tx.query(`DELETE FROM conversations WHERE id = $1;`, [conversationId]);

    await tx.query(
      `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
      [
        existing.organization_id,
        "conversation.deleted",
        "conversation",
        conversationId,
        "success",
        JSON.stringify({ title: existing.title }),
      ]
    );

    return { success: true };
  }

  // =========================================================================
  // MESSAGES
  // =========================================================================

  /**
   * Appends an authentic user message to a conversation thread.
   * Client-facing: sender_type is strictly 'user' and sender_user_id is the authenticated user.
   * Concurrency-safe: locks the conversation row to sequence messages sequentially.
   */
  async appendUserMessage(
    tx: ScopedTransaction,
    conversationId: string,
    userId: string,
    input: AppendUserMessageInput
  ): Promise<ConversationMessageDto> {
    const convRes = await tx.query<ConversationRow>(
      `SELECT * FROM conversations WHERE id = $1 FOR UPDATE;`,
      [conversationId]
    );
    const conv = convRes.rows[0];
    if (!conv) {
      throw new NotFoundError("Conversation");
    }

    if (conv.status === "archived") {
      throw new ConflictError("Cannot append message to an archived conversation.");
    }

    await this.assertOrgRole(tx, conv.organization_id, userId, ["owner", "admin", "member"]);

    // Calculate strictly sequential sequence number under row lock
    const seqRes = await tx.query<{ next_seq: string }>(
      `SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_seq
       FROM conversation_messages
       WHERE conversation_id = $1;`,
      [conversationId]
    );
    const sequenceNumber = parseInt(seqRes.rows[0].next_seq, 10);
    const tokenCount = estimateTokens(input.content);

    const msgRes = await tx.query<ConversationMessageRow>(
      `INSERT INTO conversation_messages (
         organization_id, conversation_id, sequence_number, sender_type,
         sender_user_id, content, metadata, token_count
       ) VALUES ($1, $2, $3, 'user', $4, $5, $6::jsonb, $7)
       RETURNING *;`,
      [
        conv.organization_id,
        conversationId,
        sequenceNumber,
        userId,
        input.content,
        JSON.stringify(input.metadata ?? {}),
        tokenCount,
      ]
    );

    // Bump conversation updated_at
    await tx.query(
      `UPDATE conversations SET updated_at = now() WHERE id = $1;`,
      [conversationId]
    );

    return this.mapMessage(msgRes.rows[0]);
  }

  /**
   * Internal message appending for system, assistant, or tool results.
   * Not exposed directly to public HTTP client routes without trusted execution context.
   */
  async appendInternalMessage(
    tx: ScopedTransaction,
    conversationId: string,
    input: AppendInternalMessageInput
  ): Promise<ConversationMessageDto> {
    const convRes = await tx.query<ConversationRow>(
      `SELECT * FROM conversations WHERE id = $1 FOR UPDATE;`,
      [conversationId]
    );
    const conv = convRes.rows[0];
    if (!conv) {
      throw new NotFoundError("Conversation");
    }

    const seqRes = await tx.query<{ next_seq: string }>(
      `SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_seq
       FROM conversation_messages
       WHERE conversation_id = $1;`,
      [conversationId]
    );
    const sequenceNumber = parseInt(seqRes.rows[0].next_seq, 10);
    const tokenCount = estimateTokens(input.content);

    const msgRes = await tx.query<ConversationMessageRow>(
      `INSERT INTO conversation_messages (
         organization_id, conversation_id, sequence_number, sender_type,
         sender_user_id, agent_id, content, tool_call_id, metadata, token_count
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       RETURNING *;`,
      [
        conv.organization_id,
        conversationId,
        sequenceNumber,
        input.senderType,
        input.senderUserId ?? null,
        input.agentId ?? null,
        input.content,
        input.toolCallId ?? null,
        JSON.stringify(input.metadata ?? {}),
        tokenCount,
      ]
    );

    await tx.query(
      `UPDATE conversations SET updated_at = now() WHERE id = $1;`,
      [conversationId]
    );

    return this.mapMessage(msgRes.rows[0]);
  }

  async listMessages(
    tx: ScopedTransaction,
    conversationId: string,
    userId: string,
    query: ListMessagesQuery = {}
  ): Promise<ConversationMessageDto[]> {
    const convRes = await tx.query<ConversationRow>(
      `SELECT * FROM conversations WHERE id = $1;`,
      [conversationId]
    );
    const conv = convRes.rows[0];
    if (!conv) {
      throw new NotFoundError("Conversation");
    }

    await this.assertOrgRole(tx, conv.organization_id, userId, [
      "owner",
      "admin",
      "member",
      "viewer",
    ]);

    const conditions: string[] = ["conversation_id = $1"];
    const params: any[] = [conversationId];

    if (query.beforeSequence !== undefined) {
      params.push(query.beforeSequence);
      conditions.push(`sequence_number < $${params.length}`);
    }

    if (query.afterSequence !== undefined) {
      params.push(query.afterSequence);
      conditions.push(`sequence_number > $${params.length}`);
    }

    const order = query.order === "desc" ? "DESC" : "ASC";
    const limit = query.limit ?? 50;
    params.push(limit);

    const sql = `SELECT * FROM conversation_messages
                 WHERE ${conditions.join(" AND ")}
                 ORDER BY sequence_number ${order}
                 LIMIT $${params.length};`;

    const result = await tx.query<ConversationMessageRow>(sql, params);
    return result.rows.map((r) => this.mapMessage(r));
  }

  // =========================================================================
  // SCOPED AGENT MEMORY
  // =========================================================================

  async createMemory(
    tx: ScopedTransaction,
    userId: string,
    input: CreateMemoryInput
  ): Promise<AgentMemoryDto> {
    await this.assertOrgRole(tx, input.organizationId, userId, ["owner", "admin", "member"]);

    // Enforce scope consistency
    let scopedUserId: string | null = null;
    let scopedProjectId: string | null = null;
    let scopedTaskId: string | null = null;

    if (input.scope === "user") {
      if (input.userId && input.userId !== userId) {
        throw new ValidationError("Cannot create memory on behalf of another user.");
      }
      scopedUserId = userId;
    } else {
      if (input.userId) {
        throw new ValidationError("userId is only permitted for user-scoped memories.");
      }
    }
    
    if (input.scope === "organization") {
      // Org scope has no entity bounds
    } else if (input.scope === "project") {
      if (!input.projectId) {
        throw new ValidationError("Project-scoped memory requires a valid projectId.");
      }
      const proj = await tx.query<{ id: string }>(
        `SELECT id FROM projects WHERE id = $1 AND organization_id = $2;`,
        [input.projectId, input.organizationId]
      );
      if (proj.rows.length === 0) {
        throw new NotFoundError("Project");
      }
      scopedProjectId = input.projectId;
    } else if (input.scope === "task") {
      if (!input.taskId) {
        throw new ValidationError("Task-scoped memory requires a valid taskId.");
      }
      const task = await tx.query<{ id: string; project_id: string | null }>(
        `SELECT id, project_id FROM agent_tasks WHERE id = $1 AND organization_id = $2;`,
        [input.taskId, input.organizationId]
      );
      if (task.rows.length === 0) {
        throw new NotFoundError("Agent task");
      }
      scopedTaskId = input.taskId;
      scopedProjectId = task.rows[0].project_id;
    }

    const key = input.key.trim();
    const content = input.content.trim();
    const category = input.category ?? "general";
    const source = input.source ?? "manual";
    const metadata = JSON.stringify(input.metadata ?? {});
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;

    // Concurrency-safe UPSERT based on unique index
    const result = await tx.query<AgentMemoryRow>(
      `INSERT INTO agent_memories (
         organization_id, scope, user_id, project_id, task_id, agent_id,
         key, content, category, source, metadata, expires_at, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
       ON CONFLICT (
         organization_id, scope,
         COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
         COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid),
         COALESCE(task_id, '00000000-0000-0000-0000-000000000000'::uuid),
         key
       ) DO UPDATE SET
         content = EXCLUDED.content,
         category = EXCLUDED.category,
         source = EXCLUDED.source,
         metadata = EXCLUDED.metadata,
         expires_at = EXCLUDED.expires_at,
         updated_at = now()
       RETURNING *;`,
      [
        input.organizationId,
        input.scope,
        scopedUserId,
        scopedProjectId,
        scopedTaskId,
        input.agentId ?? null,
        key,
        content,
        category,
        source,
        metadata,
        expiresAt,
        userId,
      ]
    );

    const memory = this.mapMemory(result.rows[0]);

    await tx.query(
      `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
      [
        memory.organizationId,
        "agent_memory.upserted",
        "agent_memory",
        memory.id,
        "success",
        JSON.stringify({ key: memory.key, scope: memory.scope, category: memory.category }),
      ]
    );

    return memory;
  }

  async getMemory(
    tx: ScopedTransaction,
    memoryId: string,
    userId: string
  ): Promise<AgentMemoryDto> {
    const result = await tx.query<AgentMemoryRow>(
      `SELECT * FROM agent_memories WHERE id = $1;`,
      [memoryId]
    );
    const row = result.rows[0];
    if (!row) {
      throw new NotFoundError("Memory");
    }

    await this.assertOrgRole(tx, row.organization_id, userId, [
      "owner",
      "admin",
      "member",
      "viewer",
    ]);

    // Privacy boundary: User-scoped memory is only visible to the user who owns it
    if (row.scope === "user" && row.user_id !== userId) {
      throw new NotFoundError("Memory");
    }

    return this.mapMemory(row);
  }

  async listMemories(
    tx: ScopedTransaction,
    orgId: string,
    userId: string,
    query: ListMemoriesQuery
  ): Promise<AgentMemoryDto[]> {
    await this.assertOrgRole(tx, orgId, userId, ["owner", "admin", "member", "viewer"]);

    // Strict boundary: Only include user-scoped memories belonging to the calling user
    const conditions: string[] = [
      "organization_id = $1",
      "(scope != 'user' OR user_id = $2)",
    ];
    const params: any[] = [orgId, userId];

    if (query.scope) {
      params.push(query.scope);
      conditions.push(`scope = $${params.length}`);
    }

    if (query.projectId) {
      params.push(query.projectId);
      conditions.push(`project_id = $${params.length}`);
    }

    if (query.taskId) {
      params.push(query.taskId);
      conditions.push(`task_id = $${params.length}`);
    }

    if (query.category) {
      params.push(query.category);
      conditions.push(`category = $${params.length}`);
    }

    if (!query.includeExpired) {
      conditions.push(`(expires_at IS NULL OR expires_at > now())`);
    }

    if (query.search && query.search.trim().length > 0) {
      params.push(`%${query.search.trim()}%`);
      conditions.push(`(key ILIKE $${params.length} OR content ILIKE $${params.length})`);
    }

    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;
    params.push(limit, offset);

    const sql = `SELECT * FROM agent_memories
                 WHERE ${conditions.join(" AND ")}
                 ORDER BY created_at DESC
                 LIMIT $${params.length - 1} OFFSET $${params.length};`;

    const result = await tx.query<AgentMemoryRow>(sql, params);
    return result.rows.map((r) => this.mapMemory(r));
  }

  async updateMemory(
    tx: ScopedTransaction,
    memoryId: string,
    userId: string,
    input: UpdateMemoryInput
  ): Promise<AgentMemoryDto> {
    const lockRes = await tx.query<AgentMemoryRow>(
      `SELECT * FROM agent_memories WHERE id = $1 FOR UPDATE;`,
      [memoryId]
    );
    const existing = lockRes.rows[0];
    if (!existing) {
      throw new NotFoundError("Memory");
    }

    await this.assertOrgRole(tx, existing.organization_id, userId, ["owner", "admin", "member"]);

    // Privacy boundary: User-scoped memory can only be updated by its owner
    if (existing.scope === "user" && existing.user_id !== userId) {
      throw new NotFoundError("Memory");
    }

    const newContent = input.content !== undefined ? input.content.trim() : existing.content;
    const newCategory = input.category !== undefined ? input.category : existing.category;
    const newMeta =
      input.metadata !== undefined
        ? JSON.stringify({ ...existing.metadata, ...input.metadata })
        : JSON.stringify(existing.metadata);
    const newExpiresAt =
      input.expiresAt !== undefined
        ? input.expiresAt
          ? new Date(input.expiresAt)
          : null
        : existing.expires_at;

    const updateRes = await tx.query<AgentMemoryRow>(
      `UPDATE agent_memories
       SET content = $1, category = $2, metadata = $3::jsonb, expires_at = $4, updated_at = now()
       WHERE id = $5
       RETURNING *;`,
      [newContent, newCategory, newMeta, newExpiresAt, memoryId]
    );

    const memory = this.mapMemory(updateRes.rows[0]);

    await tx.query(
      `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
      [
        memory.organizationId,
        "agent_memory.updated",
        "agent_memory",
        memory.id,
        "success",
        JSON.stringify({ key: memory.key, scope: memory.scope }),
      ]
    );

    return memory;
  }

  async deleteMemory(
    tx: ScopedTransaction,
    memoryId: string,
    userId: string
  ): Promise<{ success: boolean }> {
    const lockRes = await tx.query<AgentMemoryRow>(
      `SELECT * FROM agent_memories WHERE id = $1 FOR UPDATE;`,
      [memoryId]
    );
    const existing = lockRes.rows[0];
    if (!existing) {
      throw new NotFoundError("Memory");
    }

    // Authorization rule:
    // If scope is 'user', the user themselves can delete it.
    // If scope is not 'user', only org owner or admin can delete it.
    if (existing.scope === "user") {
      if (existing.user_id !== userId) {
        throw new NotFoundError("Memory");
      }
    } else {
      await this.assertOrgRole(tx, existing.organization_id, userId, ["owner", "admin"]);
    }

    await tx.query(`DELETE FROM agent_memories WHERE id = $1;`, [memoryId]);

    await tx.query(
      `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
      [
        existing.organization_id,
        "agent_memory.deleted",
        "agent_memory",
        memoryId,
        "success",
        JSON.stringify({ key: existing.key, scope: existing.scope }),
      ]
    );

    return { success: true };
  }

  // =========================================================================
  // CONTEXT ASSEMBLY
  // =========================================================================

  /**
   * Assembles a bounded, deterministic, injection-defended context combining
   * relevant memories and conversation history for AI provider invocation.
   */
  async assemblePromptContext(
    tx: ScopedTransaction,
    conversationId: string,
    userId: string,
    options: AssembleContextOptions = {}
  ): Promise<AssembledContextDto> {
    const conv = await this.getConversation(tx, conversationId, userId);

    // 1. Fetch relevant memories (unexpired, scoped to this tenant and user)
    const scopes: MemoryScope[] = options.includeMemoryScopes ?? [
      "organization",
      "project",
      "user",
      "task",
    ];

    const conditions: string[] = [
      "organization_id = $1",
      "(expires_at IS NULL OR expires_at > now())",
      "scope = ANY($2::text[])",
    ];
    const params: any[] = [conv.organizationId, scopes];

    // Build scope conditions
    const scopeClauses: string[] = [
      "scope = 'organization'",
      "(scope = 'user' AND user_id = $3)",
    ];
    params.push(userId);

    const effectiveProjectId = options.projectId ?? conv.projectId;
    if (options.projectId) {
      const proj = await tx.query<{ id: string }>(
        `SELECT id FROM projects WHERE id = $1 AND organization_id = $2;`,
        [options.projectId, conv.organizationId]
      );
      if (proj.rows.length === 0) {
        throw new NotFoundError("Project");
      }
    }
    if (effectiveProjectId) {
      params.push(effectiveProjectId);
      scopeClauses.push(`(scope = 'project' AND project_id = $${params.length})`);
    }

    if (options.taskId) {
      const task = await tx.query<{ id: string }>(
        `SELECT id FROM agent_tasks WHERE id = $1 AND organization_id = $2;`,
        [options.taskId, conv.organizationId]
      );
      if (task.rows.length === 0) {
        throw new NotFoundError("Agent task");
      }
      params.push(options.taskId);
      scopeClauses.push(`(scope = 'task' AND task_id = $${params.length})`);
    }

    conditions.push(`(${scopeClauses.join(" OR ")})`);

    if (options.memoryCategories && options.memoryCategories.length > 0) {
      params.push(options.memoryCategories);
      conditions.push(`category = ANY($${params.length}::text[])`);
    }

    const memSql = `SELECT * FROM agent_memories
                    WHERE ${conditions.join(" AND ")}
                    ORDER BY scope ASC, key ASC;`;

    const memRes = await tx.query<AgentMemoryRow>(memSql, params);
    const memories = memRes.rows.map((r) => this.mapMemory(r));

    // 2. Fetch conversation messages
    const messages = await this.listMessages(tx, conversationId, userId, {
      limit: 100,
      order: "asc",
    });

    // 3. Assemble and return context payload
    const systemPrompt =
      options.systemPrompt ??
      "You are ModuCraft AI Agent, an autonomous coding and architecture pair assistant.";

    return assembleContext(systemPrompt, memories, messages, options);
  }
}
