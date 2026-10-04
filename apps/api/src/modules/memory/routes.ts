import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { AuthVerifier } from "../../auth/types.js";
import { createAuthHook } from "../../auth/middleware.js";
import { withAuthenticatedContext } from "../../db/transaction.js";
import { validate, IdParamSchema } from "../../validation/schemas.js";
import { MemoryService } from "./memory.service.js";
import {
  CreateConversationSchema,
  UpdateConversationSchema,
  AppendUserMessageSchema,
  ListConversationsQuerySchema,
  ListMessagesQuerySchema,
  CreateMemorySchema,
  UpdateMemorySchema,
  ListMemoriesQuerySchema,
  AssembleContextSchema,
} from "./schemas.js";

export function registerMemoryRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  authVerifier: AuthVerifier,
  memoryService: MemoryService = new MemoryService()
) {
  const authenticate = createAuthHook(authVerifier, pool);

  // =========================================================================
  // CONVERSATIONS
  // =========================================================================

  /**
   * POST /api/v1/conversations
   * Create a new conversation thread.
   */
  app.post(
    "/api/v1/conversations",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const input = validate(CreateConversationSchema, req.body);

      const conv = await withAuthenticatedContext(pool, user.id, async (tx) => {
        return memoryService.createConversation(tx, user.id, input);
      });

      return reply.status(201).send({
        data: {
          conversation: conv,
        },
      });
    }
  );

  /**
   * GET /api/v1/conversations
   * List conversations for an organization under forced RLS.
   */
  app.get(
    "/api/v1/conversations",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const query = validate(ListConversationsQuerySchema, req.query);

      const convs = await withAuthenticatedContext(pool, user.id, async (tx) => {
        return memoryService.listConversations(tx, query.organizationId, user.id, query);
      });

      return {
        data: {
          conversations: convs,
        },
      };
    }
  );

  /**
   * GET /api/v1/conversations/:id
   * Get a single conversation thread.
   */
  app.get(
    "/api/v1/conversations/:id",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { id } = validate(IdParamSchema, req.params);

      const conv = await withAuthenticatedContext(pool, user.id, async (tx) => {
        return memoryService.getConversation(tx, id, user.id);
      });

      return {
        data: {
          conversation: conv,
        },
      };
    }
  );

  /**
   * PATCH /api/v1/conversations/:id
   * Update conversation metadata or title.
   */
  app.patch(
    "/api/v1/conversations/:id",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { id } = validate(IdParamSchema, req.params);
      const input = validate(UpdateConversationSchema, req.body);

      const conv = await withAuthenticatedContext(pool, user.id, async (tx) => {
        return memoryService.updateConversation(tx, id, user.id, input);
      });

      return {
        data: {
          conversation: conv,
        },
      };
    }
  );

  /**
   * DELETE /api/v1/conversations/:id
   * Delete or archive a conversation thread.
   */
  app.delete(
    "/api/v1/conversations/:id",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { id } = validate(IdParamSchema, req.params);

      const result = await withAuthenticatedContext(pool, user.id, async (tx) => {
        return memoryService.deleteConversation(tx, id, user.id);
      });

      return {
        data: result,
      };
    }
  );

  // =========================================================================
  // MESSAGES
  // =========================================================================

  /**
   * GET /api/v1/conversations/:id/messages
   * Paginated list of messages in a conversation thread.
   */
  app.get(
    "/api/v1/conversations/:id/messages",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { id } = validate(IdParamSchema, req.params);
      const query = validate(ListMessagesQuerySchema, req.query);

      const messages = await withAuthenticatedContext(pool, user.id, async (tx) => {
        return memoryService.listMessages(tx, id, user.id, query);
      });

      return {
        data: {
          messages,
        },
      };
    }
  );

  /**
   * POST /api/v1/conversations/:id/messages
   * Append an authentic user message to a conversation thread.
   */
  app.post(
    "/api/v1/conversations/:id/messages",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { id } = validate(IdParamSchema, req.params);
      const input = validate(AppendUserMessageSchema, req.body);

      const message = await withAuthenticatedContext(pool, user.id, async (tx) => {
        return memoryService.appendUserMessage(tx, id, user.id, input);
      });

      return reply.status(201).send({
        data: {
          message,
        },
      });
    }
  );

  /**
   * POST /api/v1/conversations/:id/assemble-context
   * Assemble context payload combining relevant memories and recent messages.
   */
  app.post(
    "/api/v1/conversations/:id/assemble-context",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { id } = validate(IdParamSchema, req.params);
      const options = validate(AssembleContextSchema, req.body ?? {});

      const assembledContext = await withAuthenticatedContext(pool, user.id, async (tx) => {
        return memoryService.assemblePromptContext(tx, id, user.id, options);
      });

      return {
        data: {
          assembledContext,
        },
      };
    }
  );

  // =========================================================================
  // MEMORIES
  // =========================================================================

  /**
   * POST /api/v1/memories
   * Create or update a scoped agent memory.
   */
  app.post(
    "/api/v1/memories",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const input = validate(CreateMemorySchema, req.body);

      const memory = await withAuthenticatedContext(pool, user.id, async (tx) => {
        return memoryService.createMemory(tx, user.id, input);
      });

      return reply.status(201).send({
        data: {
          memory,
        },
      });
    }
  );

  /**
   * GET /api/v1/memories
   * Search and list memories with scope and keyword filtering.
   */
  app.get(
    "/api/v1/memories",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const query = validate(ListMemoriesQuerySchema, req.query);

      const memories = await withAuthenticatedContext(pool, user.id, async (tx) => {
        return memoryService.listMemories(tx, query.organizationId, user.id, query);
      });

      return {
        data: {
          memories,
        },
      };
    }
  );

  /**
   * GET /api/v1/memories/:id
   * Get a single memory record.
   */
  app.get(
    "/api/v1/memories/:id",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { id } = validate(IdParamSchema, req.params);

      const memory = await withAuthenticatedContext(pool, user.id, async (tx) => {
        return memoryService.getMemory(tx, id, user.id);
      });

      return {
        data: {
          memory,
        },
      };
    }
  );

  /**
   * PATCH /api/v1/memories/:id
   * Update a memory record content or metadata.
   */
  app.patch(
    "/api/v1/memories/:id",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { id } = validate(IdParamSchema, req.params);
      const input = validate(UpdateMemorySchema, req.body);

      const memory = await withAuthenticatedContext(pool, user.id, async (tx) => {
        return memoryService.updateMemory(tx, id, user.id, input);
      });

      return {
        data: {
          memory,
        },
      };
    }
  );

  /**
   * DELETE /api/v1/memories/:id
   * Delete a memory record.
   */
  app.delete(
    "/api/v1/memories/:id",
    { preHandler: [authenticate] },
    async (req, reply) => {
      const user = req.user!;
      const { id } = validate(IdParamSchema, req.params);

      const result = await withAuthenticatedContext(pool, user.id, async (tx) => {
        return memoryService.deleteMemory(tx, id, user.id);
      });

      return {
        data: result,
      };
    }
  );
}
