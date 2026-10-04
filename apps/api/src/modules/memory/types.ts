export type SenderType = "user" | "assistant" | "system" | "tool";
export type MemoryScope = "user" | "organization" | "project" | "task";
export type MemoryCategory =
  | "fact"
  | "preference"
  | "instruction"
  | "context"
  | "summary"
  | "general";
export type MemorySource = "manual" | "conversation" | "task_execution" | "system";
export type ConversationStatus = "active" | "archived";

export interface ConversationRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  created_by: string;
  title: string;
  status: string;
  metadata: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}

export interface ConversationMessageRow {
  id: string;
  organization_id: string;
  conversation_id: string;
  sequence_number: number;
  sender_type: string;
  sender_user_id: string | null;
  agent_id: string | null;
  content: string;
  tool_call_id: string | null;
  metadata: Record<string, any>;
  token_count: number;
  created_at: Date;
}

export interface AgentMemoryRow {
  id: string;
  organization_id: string;
  scope: string;
  user_id: string | null;
  project_id: string | null;
  task_id: string | null;
  agent_id: string | null;
  key: string;
  content: string;
  category: string;
  source: string;
  metadata: Record<string, any>;
  expires_at: Date | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface ConversationDto {
  id: string;
  organizationId: string;
  projectId: string | null;
  createdBy: string;
  title: string;
  status: ConversationStatus;
  metadata: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationMessageDto {
  id: string;
  organizationId: string;
  conversationId: string;
  sequenceNumber: number;
  senderType: SenderType;
  senderUserId: string | null;
  agentId: string | null;
  content: string;
  toolCallId: string | null;
  metadata: Record<string, any>;
  tokenCount: number;
  createdAt: Date;
}

export interface AgentMemoryDto {
  id: string;
  organizationId: string;
  scope: MemoryScope;
  userId: string | null;
  projectId: string | null;
  taskId: string | null;
  agentId: string | null;
  key: string;
  content: string;
  category: MemoryCategory;
  source: MemorySource;
  metadata: Record<string, any>;
  expiresAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateConversationInput {
  organizationId: string;
  projectId?: string | null;
  title: string;
  metadata?: Record<string, any>;
}

export interface UpdateConversationInput {
  title?: string;
  status?: ConversationStatus;
  metadata?: Record<string, any>;
}

export interface AppendUserMessageInput {
  content: string;
  metadata?: Record<string, any>;
}

export interface AppendInternalMessageInput {
  senderType: SenderType;
  senderUserId?: string | null;
  agentId?: string | null;
  content: string;
  toolCallId?: string | null;
  metadata?: Record<string, any>;
}

export interface CreateMemoryInput {
  organizationId: string;
  scope: MemoryScope;
  userId?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  agentId?: string | null;
  key: string;
  content: string;
  category?: MemoryCategory;
  source?: MemorySource;
  metadata?: Record<string, any>;
  expiresAt?: string | null;
}

export interface UpdateMemoryInput {
  content?: string;
  category?: MemoryCategory;
  metadata?: Record<string, any>;
  expiresAt?: string | null;
}

export interface ListConversationsQuery {
  organizationId: string;
  projectId?: string;
  status?: ConversationStatus;
  limit?: number;
  offset?: number;
}

export interface ListMessagesQuery {
  limit?: number;
  beforeSequence?: number;
  afterSequence?: number;
  order?: "asc" | "desc";
}

export interface ListMemoriesQuery {
  organizationId: string;
  scope?: MemoryScope;
  projectId?: string;
  taskId?: string;
  category?: MemoryCategory;
  search?: string;
  includeExpired?: boolean;
  limit?: number;
  offset?: number;
}

export interface AssembleContextOptions {
  systemPrompt?: string;
  maxTokens?: number;
  includeMemoryScopes?: MemoryScope[];
  memoryCategories?: MemoryCategory[];
  projectId?: string | null;
  taskId?: string | null;
  agentId?: string | null;
  redactSecrets?: boolean;
}

export interface AssembledContextDto {
  systemPrompt: string;
  untrustedMemoryBlock: string;
  messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    toolCallId?: string;
  }>;
  totalEstimatedTokens: number;
  memoryCount: number;
  messageCount: number;
  redactionsApplied: number;
}

/**
 * Optional vector embedding interface for future semantic memory backends.
 * Implementation remains decoupled from core relational storage.
 */
export interface VectorEmbeddingService {
  generateEmbedding(text: string): Promise<number[]>;
}
