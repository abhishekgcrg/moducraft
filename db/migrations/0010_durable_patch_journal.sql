-- Migration 0010: Durable Patch Application Journal & Crash Consistency
-- Phase 4D.5: Tenant-scoped durable patch journal for crash consistency, idempotent recovery, and dirty workspace fencing.

BEGIN;

CREATE TABLE IF NOT EXISTS public.patch_application_journals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    project_id UUID NOT NULL,
    task_id UUID NOT NULL,
    patch_artifact_id UUID NOT NULL,
    approval_id UUID NOT NULL,
    target_content_hash CHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL,
    baseline_state JSONB NOT NULL DEFAULT '{}'::jsonb,
    applied_files JSONB NOT NULL DEFAULT '[]'::jsonb,
    recovery_details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT patch_journals_status_check
        CHECK (status IN ('prepared', 'applying', 'applied', 'rolling_back', 'rolled_back', 'recovery_required', 'recovered')),

    CONSTRAINT patch_journals_organization_fkey
        FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE,

    CONSTRAINT patch_journals_project_fkey
        FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE,

    CONSTRAINT patch_journals_task_fkey
        FOREIGN KEY (task_id) REFERENCES public.agent_tasks(id) ON DELETE CASCADE,

    CONSTRAINT patch_journals_patch_artifact_fkey
        FOREIGN KEY (patch_artifact_id) REFERENCES public.agent_artifacts(id) ON DELETE CASCADE,

    CONSTRAINT patch_journals_approval_fkey
        FOREIGN KEY (approval_id) REFERENCES public.agent_approvals(id) ON DELETE CASCADE,

    CONSTRAINT patch_journals_created_by_fkey
        FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE RESTRICT
);

-- Indices for performance and tenant isolation
CREATE INDEX IF NOT EXISTS idx_patch_journals_org_proj 
    ON public.patch_application_journals(organization_id, project_id);

CREATE INDEX IF NOT EXISTS idx_patch_journals_task_artifact 
    ON public.patch_application_journals(task_id, patch_artifact_id);

CREATE INDEX IF NOT EXISTS idx_patch_journals_status 
    ON public.patch_application_journals(status);

-- Enable & force Row-Level Security
ALTER TABLE public.patch_application_journals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patch_application_journals FORCE ROW LEVEL SECURITY;

-- Grant permissions to moducraft_runtime
GRANT SELECT, INSERT, UPDATE ON public.patch_application_journals TO moducraft_runtime;

-- RLS Policies
DROP POLICY IF EXISTS patch_journals_select_authorized ON public.patch_application_journals;
CREATE POLICY patch_journals_select_authorized ON public.patch_application_journals FOR SELECT
    TO moducraft_runtime
    USING (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text, 'member'::text, 'viewer'::text])
    );

DROP POLICY IF EXISTS patch_journals_insert_authorized ON public.patch_application_journals;
CREATE POLICY patch_journals_insert_authorized ON public.patch_application_journals FOR INSERT
    TO moducraft_runtime
    WITH CHECK (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text, 'member'::text])
    );

DROP POLICY IF EXISTS patch_journals_update_authorized ON public.patch_application_journals;
CREATE POLICY patch_journals_update_authorized ON public.patch_application_journals FOR UPDATE
    TO moducraft_runtime
    USING (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text, 'member'::text])
    )
    WITH CHECK (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text, 'member'::text])
    );

COMMIT;
