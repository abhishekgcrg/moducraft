-- Migration 0005: AI Agent Orchestrator Foundation
-- Implements tables, forced RLS, foreign keys, triggers, and fine-grained grants
-- for agent_tasks, agent_task_steps, and agent_task_events.
BEGIN;

-- 1. Create agent_tasks table
CREATE TABLE public.agent_tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
    created_by uuid NOT NULL REFERENCES public.app_users(id) ON DELETE RESTRICT,
    task_type text NOT NULL CHECK(length(trim(task_type)) BETWEEN 1 AND 80),
    title text NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
    input_summary text,
    input_data jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL CHECK(status IN ('queued', 'planning', 'running', 'waiting_for_approval', 'succeeded', 'failed', 'cancelled')),
    current_step_key text,
    version integer NOT NULL DEFAULT 1 CHECK(version >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    completed_at timestamptz,
    cancelled_at timestamptz,
    CONSTRAINT fk_agent_tasks_org_project FOREIGN KEY (organization_id, project_id) REFERENCES public.projects(organization_id, id) ON DELETE CASCADE,
    CONSTRAINT uq_agent_tasks_org_id UNIQUE (organization_id, id)
);

-- 2. Create agent_task_steps table
CREATE TABLE public.agent_task_steps (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    step_key text NOT NULL CHECK(length(trim(step_key)) BETWEEN 1 AND 80),
    step_type text NOT NULL CHECK(length(trim(step_type)) BETWEEN 1 AND 80),
    position integer NOT NULL CHECK(position >= 1),
    status text NOT NULL CHECK(status IN ('pending', 'ready', 'running', 'succeeded', 'failed', 'skipped', 'cancelled')),
    input_data jsonb NOT NULL DEFAULT '{}'::jsonb,
    result_data jsonb NOT NULL DEFAULT '{}'::jsonb,
    error_code text,
    error_message text,
    attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    max_attempts integer NOT NULL DEFAULT 3 CHECK(max_attempts >= 1 AND max_attempts <= 10),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    completed_at timestamptz,
    CONSTRAINT fk_agent_task_steps_task FOREIGN KEY (organization_id, task_id) REFERENCES public.agent_tasks(organization_id, id) ON DELETE CASCADE,
    CONSTRAINT uq_agent_task_steps_task_key UNIQUE (task_id, step_key),
    CONSTRAINT uq_agent_task_steps_task_pos UNIQUE (task_id, position),
    CONSTRAINT uq_agent_task_steps_org_id UNIQUE (organization_id, id)
);

-- 3. Create agent_task_events table (Append-only journal)
CREATE TABLE public.agent_task_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    task_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    step_id uuid,
    event_type text NOT NULL CHECK(length(trim(event_type)) BETWEEN 1 AND 80),
    actor_user_id uuid REFERENCES public.app_users(id) ON DELETE SET NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_agent_task_events_task FOREIGN KEY (organization_id, task_id) REFERENCES public.agent_tasks(organization_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_agent_task_events_step FOREIGN KEY (organization_id, step_id) REFERENCES public.agent_task_steps(organization_id, id) ON DELETE SET NULL
);

-- 4. Indexes for tenant and query performance
CREATE INDEX idx_agent_tasks_org_proj ON public.agent_tasks(organization_id, project_id, created_at DESC);
CREATE INDEX idx_agent_tasks_status ON public.agent_tasks(organization_id, status);
CREATE INDEX idx_agent_task_steps_task ON public.agent_task_steps(task_id, position);
CREATE INDEX idx_agent_task_events_task ON public.agent_task_events(task_id, created_at DESC);

-- 5. Updated_at triggers
CREATE TRIGGER agent_tasks_set_updated_at
BEFORE UPDATE ON public.agent_tasks
FOR EACH ROW EXECUTE FUNCTION public.moducraft_set_updated_at();

CREATE TRIGGER agent_task_steps_set_updated_at
BEFORE UPDATE ON public.agent_task_steps
FOR EACH ROW EXECUTE FUNCTION public.moducraft_set_updated_at();

-- 6. Enable and FORCE Row-Level Security
ALTER TABLE public.agent_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_tasks FORCE ROW LEVEL SECURITY;

ALTER TABLE public.agent_task_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_task_steps FORCE ROW LEVEL SECURITY;

ALTER TABLE public.agent_task_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_task_events FORCE ROW LEVEL SECURITY;

-- 7. RLS Policies on agent_tasks
DROP POLICY IF EXISTS agent_tasks_select_org_member ON public.agent_tasks;
CREATE POLICY agent_tasks_select_org_member ON public.agent_tasks FOR SELECT
    USING (moducraft_is_org_member(organization_id));

DROP POLICY IF EXISTS agent_tasks_insert_authorized ON public.agent_tasks;
CREATE POLICY agent_tasks_insert_authorized ON public.agent_tasks FOR INSERT
    TO moducraft_runtime
    WITH CHECK (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text, 'member'::text])
        AND created_by = moducraft_current_user_id()
    );

DROP POLICY IF EXISTS agent_tasks_update_authorized ON public.agent_tasks;
CREATE POLICY agent_tasks_update_authorized ON public.agent_tasks FOR UPDATE
    TO moducraft_runtime
    USING (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text, 'member'::text])
    )
    WITH CHECK (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text, 'member'::text])
    );

DROP POLICY IF EXISTS agent_tasks_delete_authorized ON public.agent_tasks;
CREATE POLICY agent_tasks_delete_authorized ON public.agent_tasks FOR DELETE
    TO moducraft_runtime
    USING (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text])
    );

-- 8. RLS Policies on agent_task_steps
DROP POLICY IF EXISTS agent_task_steps_select_org_member ON public.agent_task_steps;
CREATE POLICY agent_task_steps_select_org_member ON public.agent_task_steps FOR SELECT
    USING (moducraft_is_org_member(organization_id));

DROP POLICY IF EXISTS agent_task_steps_insert_authorized ON public.agent_task_steps;
CREATE POLICY agent_task_steps_insert_authorized ON public.agent_task_steps FOR INSERT
    TO moducraft_runtime
    WITH CHECK (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text, 'member'::text])
    );

DROP POLICY IF EXISTS agent_task_steps_update_authorized ON public.agent_task_steps;
CREATE POLICY agent_task_steps_update_authorized ON public.agent_task_steps FOR UPDATE
    TO moducraft_runtime
    USING (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text, 'member'::text])
    )
    WITH CHECK (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text, 'member'::text])
    );

DROP POLICY IF EXISTS agent_task_steps_delete_authorized ON public.agent_task_steps;
CREATE POLICY agent_task_steps_delete_authorized ON public.agent_task_steps FOR DELETE
    TO moducraft_runtime
    USING (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text])
    );

-- 9. RLS Policies on agent_task_events
DROP POLICY IF EXISTS agent_task_events_select_org_member ON public.agent_task_events;
CREATE POLICY agent_task_events_select_org_member ON public.agent_task_events FOR SELECT
    USING (moducraft_is_org_member(organization_id));

DROP POLICY IF EXISTS agent_task_events_insert_authorized ON public.agent_task_events;
CREATE POLICY agent_task_events_insert_authorized ON public.agent_task_events FOR INSERT
    TO moducraft_runtime
    WITH CHECK (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text, 'member'::text])
        AND (actor_user_id IS NULL OR actor_user_id = moducraft_current_user_id())
    );

-- 10. Table & fine-grained column level grants for moducraft_runtime
-- agent_tasks grants
GRANT SELECT, DELETE ON public.agent_tasks TO moducraft_runtime;
GRANT INSERT (organization_id, project_id, created_by, task_type, title, input_summary, input_data, status, current_step_key, version, started_at, completed_at, cancelled_at) ON public.agent_tasks TO moducraft_runtime;
GRANT UPDATE (status, current_step_key, version, started_at, completed_at, cancelled_at) ON public.agent_tasks TO moducraft_runtime;

-- agent_task_steps grants
GRANT SELECT, DELETE ON public.agent_task_steps TO moducraft_runtime;
GRANT INSERT (task_id, organization_id, step_key, step_type, position, status, input_data, result_data, error_code, error_message, attempt_count, max_attempts, started_at, completed_at) ON public.agent_task_steps TO moducraft_runtime;
GRANT UPDATE (status, result_data, error_code, error_message, attempt_count, started_at, completed_at) ON public.agent_task_steps TO moducraft_runtime;

-- agent_task_events grants (append-only: no UPDATE or DELETE)
GRANT SELECT ON public.agent_task_events TO moducraft_runtime;
GRANT INSERT (task_id, organization_id, step_id, event_type, actor_user_id, metadata) ON public.agent_task_events TO moducraft_runtime;

COMMIT;
