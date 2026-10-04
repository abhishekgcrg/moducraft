-- Migration 0008: Agent Workflows, Artifacts, and Hash-Bound Approvals
-- Phase 4D: Controlled, resumable, observable agent workflows with immutable artifacts and single-use approvals.
BEGIN;

-- 1. Create agent_artifacts table (immutable/versioned outputs such as patch proposals, test reports, reviews)
CREATE TABLE public.agent_artifacts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    project_id uuid,
    task_id uuid NOT NULL,
    step_id uuid,
    artifact_type text NOT NULL CHECK(artifact_type IN ('patch_proposal', 'test_report', 'code_review', 'security_review', 'documentation', 'plan')),
    title text NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
    content text NOT NULL CHECK(length(content) BETWEEN 1 AND 524288),
    content_hash text NOT NULL CHECK(length(content_hash) = 64),
    size_bytes integer NOT NULL CHECK(size_bytes >= 0 AND size_bytes <= 524288),
    review_status text NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending', 'approved', 'rejected')),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by uuid NOT NULL REFERENCES public.app_users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_agent_artifacts_org_task
        FOREIGN KEY (organization_id, task_id)
        REFERENCES public.agent_tasks(organization_id, id)
        ON DELETE CASCADE,
    CONSTRAINT fk_agent_artifacts_org_project
        FOREIGN KEY (organization_id, project_id)
        REFERENCES public.projects(organization_id, id)
        ON DELETE CASCADE,
    CONSTRAINT fk_agent_artifacts_org_step
        FOREIGN KEY (organization_id, step_id)
        REFERENCES public.agent_task_steps(organization_id, id)
        ON DELETE SET NULL,
    CONSTRAINT uq_agent_artifacts_org_id UNIQUE (organization_id, id)
);

-- 2. Create agent_approvals table (scoped, expiring, single-use hash-bound approvals)
CREATE TABLE public.agent_approvals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    task_id uuid NOT NULL,
    step_id uuid,
    artifact_id uuid REFERENCES public.agent_artifacts(id) ON DELETE CASCADE,
    action text NOT NULL CHECK(length(trim(action)) BETWEEN 1 AND 80),
    target_content_hash text NOT NULL CHECK(length(target_content_hash) = 64),
    status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'expired')),
    required_role text NOT NULL DEFAULT 'admin' CHECK(required_role IN ('owner', 'admin')),
    expires_at timestamptz NOT NULL,
    approved_by uuid REFERENCES public.app_users(id) ON DELETE SET NULL,
    decided_at timestamptz,
    decision_reason text CHECK(decision_reason IS NULL OR length(decision_reason) <= 1000),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_agent_approvals_org_task
        FOREIGN KEY (organization_id, task_id)
        REFERENCES public.agent_tasks(organization_id, id)
        ON DELETE CASCADE,
    CONSTRAINT fk_agent_approvals_org_step
        FOREIGN KEY (organization_id, step_id)
        REFERENCES public.agent_task_steps(organization_id, id)
        ON DELETE SET NULL,
    CONSTRAINT uq_agent_approvals_org_id UNIQUE (organization_id, id)
);

-- 3. Indexes for tenant and query performance
CREATE INDEX idx_agent_artifacts_task ON public.agent_artifacts(organization_id, task_id, created_at DESC);
CREATE INDEX idx_agent_artifacts_project ON public.agent_artifacts(organization_id, project_id, created_at DESC);
CREATE INDEX idx_agent_artifacts_type ON public.agent_artifacts(organization_id, artifact_type);
CREATE INDEX idx_agent_artifacts_hash ON public.agent_artifacts(organization_id, content_hash);

CREATE INDEX idx_agent_approvals_task ON public.agent_approvals(organization_id, task_id, status);
CREATE INDEX idx_agent_approvals_artifact ON public.agent_approvals(organization_id, artifact_id);
CREATE INDEX idx_agent_approvals_status ON public.agent_approvals(organization_id, status, expires_at);

-- 4. Automatic updated_at triggers
CREATE TRIGGER agent_artifacts_set_updated_at
BEFORE UPDATE ON public.agent_artifacts
FOR EACH ROW EXECUTE FUNCTION public.moducraft_set_updated_at();

CREATE TRIGGER agent_approvals_set_updated_at
BEFORE UPDATE ON public.agent_approvals
FOR EACH ROW EXECUTE FUNCTION public.moducraft_set_updated_at();

-- 5. Enable and FORCE Row-Level Security
ALTER TABLE public.agent_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_artifacts FORCE ROW LEVEL SECURITY;

ALTER TABLE public.agent_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_approvals FORCE ROW LEVEL SECURITY;

-- 6. RLS Policies on agent_artifacts
DROP POLICY IF EXISTS agent_artifacts_select_org_member ON public.agent_artifacts;
CREATE POLICY agent_artifacts_select_org_member ON public.agent_artifacts FOR SELECT
    USING (moducraft_is_org_member(organization_id));

DROP POLICY IF EXISTS agent_artifacts_insert_authorized ON public.agent_artifacts;
CREATE POLICY agent_artifacts_insert_authorized ON public.agent_artifacts FOR INSERT
    TO moducraft_runtime
    WITH CHECK (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text, 'member'::text])
        AND created_by = moducraft_current_user_id()
    );

DROP POLICY IF EXISTS agent_artifacts_update_authorized ON public.agent_artifacts;
CREATE POLICY agent_artifacts_update_authorized ON public.agent_artifacts FOR UPDATE
    TO moducraft_runtime
    USING (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text, 'member'::text])
    )
    WITH CHECK (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text, 'member'::text])
    );

DROP POLICY IF EXISTS agent_artifacts_delete_authorized ON public.agent_artifacts;
CREATE POLICY agent_artifacts_delete_authorized ON public.agent_artifacts FOR DELETE
    TO moducraft_runtime
    USING (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text])
    );

-- 7. RLS Policies on agent_approvals
DROP POLICY IF EXISTS agent_approvals_select_org_member ON public.agent_approvals;
CREATE POLICY agent_approvals_select_org_member ON public.agent_approvals FOR SELECT
    USING (moducraft_is_org_member(organization_id));

DROP POLICY IF EXISTS agent_approvals_insert_authorized ON public.agent_approvals;
CREATE POLICY agent_approvals_insert_authorized ON public.agent_approvals FOR INSERT
    TO moducraft_runtime
    WITH CHECK (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text, 'member'::text])
    );

DROP POLICY IF EXISTS agent_approvals_update_authorized ON public.agent_approvals;
CREATE POLICY agent_approvals_update_authorized ON public.agent_approvals FOR UPDATE
    TO moducraft_runtime
    USING (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text])
    )
    WITH CHECK (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text])
    );

DROP POLICY IF EXISTS agent_approvals_delete_authorized ON public.agent_approvals;
CREATE POLICY agent_approvals_delete_authorized ON public.agent_approvals FOR DELETE
    TO moducraft_runtime
    USING (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text])
    );

-- 8. Table & Column Level Grants for moducraft_runtime
-- agent_artifacts grants: content and content_hash are append-only (cannot be changed via UPDATE)
GRANT SELECT, DELETE ON public.agent_artifacts TO moducraft_runtime;
GRANT INSERT (organization_id, project_id, task_id, step_id, artifact_type, title, content, content_hash, size_bytes, review_status, metadata, created_by) ON public.agent_artifacts TO moducraft_runtime;
GRANT UPDATE (review_status, metadata, updated_at) ON public.agent_artifacts TO moducraft_runtime;

-- agent_approvals grants: action and target_content_hash are append-only
GRANT SELECT, DELETE ON public.agent_approvals TO moducraft_runtime;
GRANT INSERT (organization_id, task_id, step_id, artifact_id, action, target_content_hash, status, required_role, expires_at, metadata) ON public.agent_approvals TO moducraft_runtime;
GRANT UPDATE (status, approved_by, decided_at, decision_reason, metadata, updated_at) ON public.agent_approvals TO moducraft_runtime;

COMMIT;
