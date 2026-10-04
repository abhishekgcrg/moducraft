-- Migration 0002: Project CRUD policies, RBAC helpers, and runtime role configuration
BEGIN;

-- 1. Ensure runtime role exists
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'moducraft_runtime') THEN
        CREATE ROLE moducraft_runtime WITH NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOLOGIN;
    END IF;
END $$;

-- 2. Authorization helper functions
CREATE OR REPLACE FUNCTION public.moducraft_current_user_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION public.moducraft_is_org_member(target_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'pg_temp' AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.organization_memberships AS m
        WHERE m.organization_id = target_org
          AND m.user_id = public.moducraft_current_user_id()
    );
$$;

CREATE OR REPLACE FUNCTION public.moducraft_has_org_role(target_org uuid, allowed_roles text[])
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'pg_temp' AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.organization_memberships AS m
        WHERE m.organization_id = target_org
          AND m.user_id = public.moducraft_current_user_id()
          AND m.role = ANY(allowed_roles)
    );
$$;

CREATE OR REPLACE FUNCTION public.moducraft_set_updated_at()
RETURNS trigger LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp' AS $$
BEGIN
    NEW.updated_at := pg_catalog.now();
    RETURN NEW;
END;
$$;

-- 3. Trigger for updated_at on projects
DROP TRIGGER IF EXISTS projects_set_updated_at ON public.projects;
CREATE TRIGGER projects_set_updated_at
BEFORE UPDATE ON public.projects
FOR EACH ROW EXECUTE FUNCTION public.moducraft_set_updated_at();

-- 4. Secure function execution permissions (principle of least privilege)
REVOKE ALL ON FUNCTION public.moducraft_current_user_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.moducraft_is_org_member(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.moducraft_has_org_role(uuid, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.moducraft_set_updated_at() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.moducraft_current_user_id() TO moducraft_runtime;
GRANT EXECUTE ON FUNCTION public.moducraft_is_org_member(uuid) TO moducraft_runtime;
GRANT EXECUTE ON FUNCTION public.moducraft_has_org_role(uuid, text[]) TO moducraft_runtime;

-- 5. Table & column level grants for moducraft_runtime
GRANT SELECT ON public.app_users TO moducraft_runtime;
GRANT SELECT ON public.organizations TO moducraft_runtime;
GRANT SELECT ON public.organization_memberships TO moducraft_runtime;
GRANT SELECT ON public.audit_events TO moducraft_runtime;

-- Projects permissions: fine-grained column controls
GRANT SELECT, DELETE ON public.projects TO moducraft_runtime;
GRANT INSERT (organization_id, name, slug, description, created_by) ON public.projects TO moducraft_runtime;
GRANT UPDATE (name, slug, description) ON public.projects TO moducraft_runtime;

-- 6. Row-Level Security policies on projects
DROP POLICY IF EXISTS projects_select_org_member ON public.projects;
CREATE POLICY projects_select_org_member ON public.projects FOR SELECT
    USING (moducraft_is_org_member(organization_id));

DROP POLICY IF EXISTS projects_insert_authorized ON public.projects;
CREATE POLICY projects_insert_authorized ON public.projects FOR INSERT
    TO moducraft_runtime
    WITH CHECK (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text, 'member'::text])
        AND created_by = moducraft_current_user_id()
    );

DROP POLICY IF EXISTS projects_update_authorized ON public.projects;
CREATE POLICY projects_update_authorized ON public.projects FOR UPDATE
    TO moducraft_runtime
    USING (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text, 'member'::text])
    )
    WITH CHECK (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text, 'member'::text])
    );

DROP POLICY IF EXISTS projects_delete_authorized ON public.projects;
CREATE POLICY projects_delete_authorized ON public.projects FOR DELETE
    TO moducraft_runtime
    USING (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text])
    );

COMMIT;
