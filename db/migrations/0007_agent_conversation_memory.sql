-- Migration 0007: Agent Conversation & Memory Foundation
-- Tables, constraints, forced RLS, and grants for conversations, conversation_messages, and agent_memories
BEGIN;

-- 1. Create conversations table
CREATE TABLE public.conversations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    project_id uuid,
    created_by uuid NOT NULL REFERENCES public.app_users(id) ON DELETE RESTRICT,
    title text NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
    status text NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_conversations_org_project
        FOREIGN KEY (organization_id, project_id)
        REFERENCES public.projects(organization_id, id)
        ON DELETE CASCADE,
    CONSTRAINT uq_conversations_org_id UNIQUE (organization_id, id)
);

-- 2. Create conversation_messages table (ordered, immutable conversation history)
CREATE TABLE public.conversation_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    sequence_number integer NOT NULL CHECK(sequence_number >= 1),
    sender_type text NOT NULL CHECK(sender_type IN ('user', 'assistant', 'system', 'tool')),
    sender_user_id uuid REFERENCES public.app_users(id) ON DELETE SET NULL,
    agent_id text CHECK(agent_id IS NULL OR length(trim(agent_id)) BETWEEN 1 AND 80),
    content text NOT NULL CHECK(length(content) BETWEEN 1 AND 32000),
    tool_call_id text CHECK(tool_call_id IS NULL OR length(trim(tool_call_id)) BETWEEN 1 AND 80),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    token_count integer NOT NULL DEFAULT 0 CHECK(token_count >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_conv_messages_conv
        FOREIGN KEY (organization_id, conversation_id)
        REFERENCES public.conversations(organization_id, id)
        ON DELETE CASCADE,
    CONSTRAINT uq_conv_messages_seq UNIQUE (conversation_id, sequence_number),
    CONSTRAINT uq_conv_messages_org_id UNIQUE (organization_id, id),
    CONSTRAINT chk_conv_messages_sender CHECK (
        (sender_type = 'user' AND sender_user_id IS NOT NULL) OR
        (sender_type != 'user')
    )
);

-- 3. Create agent_memories table (scoped memory store: user, organization, project, task)
CREATE TABLE public.agent_memories (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    scope text NOT NULL CHECK(scope IN ('user', 'organization', 'project', 'task')),
    user_id uuid REFERENCES public.app_users(id) ON DELETE CASCADE,
    project_id uuid,
    task_id uuid,
    agent_id text CHECK(agent_id IS NULL OR length(trim(agent_id)) BETWEEN 1 AND 80),
    key text NOT NULL CHECK(length(trim(key)) BETWEEN 1 AND 120),
    content text NOT NULL CHECK(length(trim(content)) BETWEEN 1 AND 10000),
    category text NOT NULL DEFAULT 'general' CHECK(category IN ('fact', 'preference', 'instruction', 'context', 'summary', 'general')),
    source text NOT NULL DEFAULT 'manual' CHECK(source IN ('manual', 'conversation', 'task_execution', 'system')),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    expires_at timestamptz,
    created_by uuid NOT NULL REFERENCES public.app_users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_agent_memories_org_project
        FOREIGN KEY (organization_id, project_id)
        REFERENCES public.projects(organization_id, id)
        ON DELETE CASCADE,
    CONSTRAINT fk_agent_memories_org_task
        FOREIGN KEY (organization_id, task_id)
        REFERENCES public.agent_tasks(organization_id, id)
        ON DELETE CASCADE,
    CONSTRAINT uq_agent_memories_org_id UNIQUE (organization_id, id),
    CONSTRAINT chk_agent_memories_scope_consistency CHECK (
        (scope = 'user' AND user_id IS NOT NULL) OR
        (scope = 'organization' AND user_id IS NULL AND project_id IS NULL AND task_id IS NULL) OR
        (scope = 'project' AND project_id IS NOT NULL AND task_id IS NULL) OR
        (scope = 'task' AND task_id IS NOT NULL)
    )
);

-- 4. Indexes for query and tenant lookup performance
CREATE INDEX idx_conversations_org ON public.conversations(organization_id, project_id, created_at DESC);
CREATE INDEX idx_conv_messages_conv_seq ON public.conversation_messages(conversation_id, sequence_number ASC);
CREATE INDEX idx_conv_messages_org ON public.conversation_messages(organization_id, created_at DESC);
CREATE INDEX idx_agent_memories_org_scope ON public.agent_memories(organization_id, scope, created_at DESC);
CREATE INDEX idx_agent_memories_user ON public.agent_memories(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_agent_memories_project ON public.agent_memories(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_agent_memories_task ON public.agent_memories(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX idx_agent_memories_expires ON public.agent_memories(expires_at) WHERE expires_at IS NOT NULL;

-- Unique index for upsert / deduplication on (org, scope, entities, key)
CREATE UNIQUE INDEX uq_agent_memories_scope_key ON public.agent_memories (
    organization_id,
    scope,
    coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(task_id, '00000000-0000-0000-0000-000000000000'::uuid),
    key
);

-- 5. Updated_at triggers
CREATE TRIGGER conversations_set_updated_at
BEFORE UPDATE ON public.conversations
FOR EACH ROW EXECUTE FUNCTION public.moducraft_set_updated_at();

CREATE TRIGGER agent_memories_set_updated_at
BEFORE UPDATE ON public.agent_memories
FOR EACH ROW EXECUTE FUNCTION public.moducraft_set_updated_at();

-- 6. Enable and FORCE Row-Level Security
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations FORCE ROW LEVEL SECURITY;

ALTER TABLE public.conversation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_messages FORCE ROW LEVEL SECURITY;

ALTER TABLE public.agent_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memories FORCE ROW LEVEL SECURITY;

-- 7. RLS Policies on conversations
DROP POLICY IF EXISTS conversations_select_org_member ON public.conversations;
CREATE POLICY conversations_select_org_member ON public.conversations FOR SELECT
    USING (moducraft_is_org_member(organization_id));

DROP POLICY IF EXISTS conversations_insert_authorized ON public.conversations;
CREATE POLICY conversations_insert_authorized ON public.conversations FOR INSERT
    TO moducraft_runtime
    WITH CHECK (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text, 'member'::text])
        AND created_by = moducraft_current_user_id()
    );

DROP POLICY IF EXISTS conversations_update_authorized ON public.conversations;
CREATE POLICY conversations_update_authorized ON public.conversations FOR UPDATE
    TO moducraft_runtime
    USING (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text, 'member'::text])
    )
    WITH CHECK (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text, 'member'::text])
    );

DROP POLICY IF EXISTS conversations_delete_authorized ON public.conversations;
CREATE POLICY conversations_delete_authorized ON public.conversations FOR DELETE
    TO moducraft_runtime
    USING (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text])
    );

-- 8. RLS Policies on conversation_messages
DROP POLICY IF EXISTS conv_messages_select_org_member ON public.conversation_messages;
CREATE POLICY conv_messages_select_org_member ON public.conversation_messages FOR SELECT
    USING (moducraft_is_org_member(organization_id));

DROP POLICY IF EXISTS conv_messages_insert_authorized ON public.conversation_messages;
CREATE POLICY conv_messages_insert_authorized ON public.conversation_messages FOR INSERT
    TO moducraft_runtime
    WITH CHECK (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text, 'member'::text])
    );

DROP POLICY IF EXISTS conv_messages_delete_authorized ON public.conversation_messages;
CREATE POLICY conv_messages_delete_authorized ON public.conversation_messages FOR DELETE
    TO moducraft_runtime
    USING (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text])
    );

-- 9. RLS Policies on agent_memories (Strict User Scope Isolation)
DROP POLICY IF EXISTS agent_memories_select_authorized ON public.agent_memories;
CREATE POLICY agent_memories_select_authorized ON public.agent_memories FOR SELECT
    USING (
        moducraft_is_org_member(organization_id)
        AND (scope != 'user' OR user_id = moducraft_current_user_id())
    );

DROP POLICY IF EXISTS agent_memories_insert_authorized ON public.agent_memories;
CREATE POLICY agent_memories_insert_authorized ON public.agent_memories FOR INSERT
    TO moducraft_runtime
    WITH CHECK (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text, 'member'::text])
        AND created_by = moducraft_current_user_id()
        AND (scope != 'user' OR user_id = moducraft_current_user_id())
    );

DROP POLICY IF EXISTS agent_memories_update_authorized ON public.agent_memories;
CREATE POLICY agent_memories_update_authorized ON public.agent_memories FOR UPDATE
    TO moducraft_runtime
    USING (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text, 'member'::text])
        AND (scope != 'user' OR user_id = moducraft_current_user_id())
    )
    WITH CHECK (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text, 'member'::text])
        AND (scope != 'user' OR user_id = moducraft_current_user_id())
    );

DROP POLICY IF EXISTS agent_memories_delete_authorized ON public.agent_memories;
CREATE POLICY agent_memories_delete_authorized ON public.agent_memories FOR DELETE
    TO moducraft_runtime
    USING (
        (scope = 'user' AND user_id = moducraft_current_user_id())
        OR (scope != 'user' AND moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text]))
    );

-- 10. Table & column grants for moducraft_runtime
GRANT SELECT, DELETE ON public.conversations TO moducraft_runtime;
GRANT INSERT (
    organization_id, project_id, title, status, metadata, created_by
) ON public.conversations TO moducraft_runtime;
GRANT UPDATE (
    title, status, metadata, updated_at
) ON public.conversations TO moducraft_runtime;

-- Messages are append-only; UPDATE is intentionally NOT granted
GRANT SELECT, DELETE ON public.conversation_messages TO moducraft_runtime;
GRANT INSERT (
    organization_id, conversation_id, sequence_number, sender_type,
    sender_user_id, agent_id, content, tool_call_id, metadata, token_count
) ON public.conversation_messages TO moducraft_runtime;

-- Memory grants
GRANT SELECT, DELETE ON public.agent_memories TO moducraft_runtime;
GRANT INSERT (
    organization_id, scope, user_id, project_id, task_id, agent_id,
    key, content, category, source, metadata, expires_at, created_by
) ON public.agent_memories TO moducraft_runtime;
GRANT UPDATE (
    content, category, source, metadata, expires_at, updated_at
) ON public.agent_memories TO moducraft_runtime;

COMMIT;
