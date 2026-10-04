-- Migration 0004: Constrained audit event recording helper
BEGIN;

-- Helper function to record audit events strictly inside transactions
-- Enforces that:
-- 1. Actor is strictly derived from moducraft_current_user_id() (set via withAuthenticatedContext).
-- 2. Organization ID is required and actor membership is verified (cannot log events for foreign tenants).
-- 3. Action, resource_type, outcome, and metadata are strictly validated.
-- 4. Sensitive keys (passwords, tokens, secrets, JWTs) are blocked from metadata.
-- 5. Audit table remains protected against direct INSERT/UPDATE/DELETE.
CREATE OR REPLACE FUNCTION public.moducraft_record_audit_event(
    p_organization_id uuid,
    p_action text,
    p_resource_type text,
    p_resource_id text,
    p_outcome text,
    p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'pg_temp' AS $$
DECLARE
    v_actor_id uuid;
    v_audit_id bigint;
    v_clean_metadata jsonb;
BEGIN
    v_actor_id := public.moducraft_current_user_id();
    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'Cannot record audit event: no authenticated user context set';
    END IF;

    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'Cannot record audit event: organization_id is required';
    END IF;

    IF NOT public.moducraft_is_org_member(p_organization_id) THEN
        RAISE EXCEPTION 'Cannot record audit event for organization actor is not a member of';
    END IF;

    IF p_action IS NULL OR length(trim(p_action)) NOT BETWEEN 1 AND 120 THEN
        RAISE EXCEPTION 'Invalid audit action: must be between 1 and 120 characters';
    END IF;

    IF p_resource_type IS NULL OR length(trim(p_resource_type)) NOT BETWEEN 1 AND 80 THEN
        RAISE EXCEPTION 'Invalid audit resource_type: must be between 1 and 80 characters';
    END IF;

    IF p_resource_id IS NOT NULL AND length(p_resource_id) > 120 THEN
        RAISE EXCEPTION 'Invalid audit resource_id: must not exceed 120 characters';
    END IF;

    IF p_outcome IS NULL OR p_outcome NOT IN ('success', 'denied', 'failure') THEN
        RAISE EXCEPTION 'Invalid audit outcome: %', p_outcome;
    END IF;

    v_clean_metadata := COALESCE(p_metadata, '{}'::jsonb);

    IF jsonb_typeof(v_clean_metadata) <> 'object' THEN
        RAISE EXCEPTION 'Invalid audit metadata: must be a JSON object';
    END IF;

    -- Block sensitive keys from being recorded in audit metadata
    IF v_clean_metadata ?| ARRAY['password', 'secret', 'token', 'apiKey', 'authorization', 'cookie', 'jwt', 'private_key'] THEN
        RAISE EXCEPTION 'Sensitive key detected in audit metadata';
    END IF;

    INSERT INTO public.audit_events (
        actor_user_id,
        organization_id,
        action,
        resource_type,
        resource_id,
        outcome,
        metadata
    ) VALUES (
        v_actor_id,
        p_organization_id,
        trim(p_action),
        trim(p_resource_type),
        p_resource_id,
        p_outcome,
        v_clean_metadata
    )
    RETURNING id INTO v_audit_id;

    RETURN v_audit_id;
END;
$$;

-- Secure function execution grants (least privilege)
REVOKE ALL ON FUNCTION public.moducraft_record_audit_event(uuid, text, text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.moducraft_record_audit_event(uuid, text, text, text, text, jsonb) TO moducraft_runtime;

COMMIT;
