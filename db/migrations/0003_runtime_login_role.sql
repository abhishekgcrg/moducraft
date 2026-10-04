-- Migration 0003: Configure restricted runtime login role and identity resolution helper
BEGIN;

-- 1. Enable direct connection for the least-privilege runtime role
DO $$
BEGIN
    ALTER ROLE moducraft_runtime WITH LOGIN;
END $$;

-- 2. Secure identity resolution helper
-- Allows the trusted backend to resolve a verified (issuer, subject) claim pair
-- to an internal app_users.id without weakening RLS on app_users table.
CREATE OR REPLACE FUNCTION public.moducraft_resolve_identity(p_issuer text, p_subject text)
RETURNS TABLE (
    id uuid,
    identity_issuer text,
    identity_subject text,
    email text,
    display_name text,
    created_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'pg_temp' AS $$
    SELECT u.id, u.identity_issuer, u.identity_subject, u.email, u.display_name, u.created_at
    FROM public.app_users u
    WHERE u.identity_issuer = p_issuer
      AND u.identity_subject = p_subject;
$$;

-- Enforce least privilege on resolution helper
REVOKE ALL ON FUNCTION public.moducraft_resolve_identity(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.moducraft_resolve_identity(text, text) TO moducraft_runtime;

COMMIT;
