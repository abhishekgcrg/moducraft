-- Migration 0009: Agent Approvals Consumed Status and Security Hardening
-- Phase 4D.1: Single-use approval consumption, RLS least-privilege review status, and audit referential integrity.
BEGIN;

-- 1. Update status check constraint on agent_approvals to support 'consumed'
ALTER TABLE public.agent_approvals DROP CONSTRAINT IF EXISTS agent_approvals_status_check;
ALTER TABLE public.agent_approvals ADD CONSTRAINT agent_approvals_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'consumed'));

-- 2. Update agent_approvals RLS UPDATE policy:
-- Owners and admins can decide/expire approvals.
-- Regular members can ONLY transition an already 'approved' approval to 'consumed' (consumption-only least-privilege).
DROP POLICY IF EXISTS agent_approvals_update_authorized ON public.agent_approvals;
CREATE POLICY agent_approvals_update_authorized ON public.agent_approvals FOR UPDATE
    TO moducraft_runtime
    USING (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text])
        OR (
            moducraft_has_org_role(organization_id, ARRAY['member'::text])
            AND status = 'approved'
        )
    )
    WITH CHECK (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text])
        OR (
            moducraft_has_org_role(organization_id, ARRAY['member'::text])
            AND status = 'consumed'
        )
    );

-- 3. Harden agent_artifacts RLS UPDATE policy:
-- Only owner and admin roles may update artifact review_status or metadata.
-- Regular members cannot approve/reject their own artifacts directly.
DROP POLICY IF EXISTS agent_artifacts_update_authorized ON public.agent_artifacts;
CREATE POLICY agent_artifacts_update_authorized ON public.agent_artifacts FOR UPDATE
    TO moducraft_runtime
    USING (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text])
    )
    WITH CHECK (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text])
    );

-- 4. Preserve approval audit integrity:
-- Prevent cascading deletion of approvals when an artifact is deleted.
-- Changing artifact_id foreign key from CASCADE to RESTRICT ensures an artifact referenced by an approval cannot be deleted.
ALTER TABLE public.agent_approvals DROP CONSTRAINT IF EXISTS agent_approvals_artifact_id_fkey;
ALTER TABLE public.agent_approvals ADD CONSTRAINT agent_approvals_artifact_id_fkey
    FOREIGN KEY (artifact_id)
    REFERENCES public.agent_artifacts(id)
    ON DELETE RESTRICT;

COMMIT;
