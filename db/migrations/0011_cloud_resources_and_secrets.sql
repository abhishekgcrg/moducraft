-- Migration 0011: Cloud Resources and Secret Credentials Foundation
-- Phase 5: Self-hostable Cloud MVP - Database/Storage resources and encrypted credentials
BEGIN;

-- 1. Create project_resources table
CREATE TABLE public.project_resources (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    project_id uuid NOT NULL,
    provider_id text NOT NULL CHECK(length(trim(provider_id)) BETWEEN 1 AND 80),
    resource_type text NOT NULL CHECK(resource_type IN ('database', 'object_storage')),
    name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
    status text NOT NULL CHECK(status IN ('provisioning', 'active', 'failed', 'deprovisioning', 'deprovisioned')),
    endpoint jsonb,
    configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
    error_details text,
    created_by uuid NOT NULL REFERENCES public.app_users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,

    -- Foreign keys & composite constraints
    CONSTRAINT fk_project_resources_project
        FOREIGN KEY (organization_id, project_id)
        REFERENCES public.projects(organization_id, id)
        ON DELETE CASCADE,
    CONSTRAINT uq_project_resources_org_id UNIQUE (organization_id, id),
    CONSTRAINT uq_project_resources_org_project_id UNIQUE (organization_id, project_id, id),

    -- Secret leakage prevention check constraints
    CONSTRAINT chk_project_resources_config_no_secrets
        CHECK (NOT (configuration ?| ARRAY['password', 'secret', 'token', 'apiKey', 'authorization', 'cookie', 'jwt', 'private_key', 'credentials'])),
    CONSTRAINT chk_project_resources_endpoint_no_secrets
        CHECK (endpoint IS NULL OR NOT (endpoint ?| ARRAY['password', 'secret', 'token', 'authorization']))
);

-- Partial unique index for active resource name reuse after soft-delete
CREATE UNIQUE INDEX uq_project_resources_active_name
    ON public.project_resources (organization_id, project_id, name)
    WHERE (deleted_at IS NULL AND status <> 'deprovisioned');

CREATE INDEX idx_project_resources_org_project
    ON public.project_resources (organization_id, project_id, created_at DESC);

-- Trigger for updated_at
CREATE TRIGGER project_resources_set_updated_at
BEFORE UPDATE ON public.project_resources
FOR EACH ROW EXECUTE FUNCTION public.moducraft_set_updated_at();

-- 2. Create resource_credentials table
CREATE TABLE public.resource_credentials (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    project_id uuid NOT NULL,
    resource_id uuid NOT NULL,
    status text NOT NULL CHECK(status IN ('active', 'rotated', 'revoked')),
    version integer NOT NULL DEFAULT 1 CHECK(version >= 1),
    username text NOT NULL CHECK(length(trim(username)) BETWEEN 1 AND 120),
    encrypted_password text NOT NULL,
    key_prefix text NOT NULL CHECK(length(key_prefix) BETWEEN 1 AND 20),
    key_suffix text NOT NULL CHECK(length(key_suffix) BETWEEN 1 AND 20),
    connection_string_template text NOT NULL,
    created_by uuid NOT NULL REFERENCES public.app_users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    rotated_at timestamptz,
    revoked_at timestamptz,

    -- Composite FK guaranteeing project and resource belong to identical tenant and project scope
    CONSTRAINT fk_resource_credentials_resource_project
        FOREIGN KEY (organization_id, project_id, resource_id)
        REFERENCES public.project_resources(organization_id, project_id, id)
        ON DELETE CASCADE,
    CONSTRAINT uq_resource_credentials_org_id UNIQUE (organization_id, id)
);

-- Invariant: At most ONE active credential per resource
CREATE UNIQUE INDEX uq_resource_credentials_one_active
    ON public.resource_credentials (organization_id, resource_id)
    WHERE (status = 'active');

CREATE INDEX idx_resource_credentials_lookup
    ON public.resource_credentials (organization_id, resource_id, version DESC);

-- 3. Enable and FORCE Row-Level Security
ALTER TABLE public.project_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_resources FORCE ROW LEVEL SECURITY;

ALTER TABLE public.resource_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resource_credentials FORCE ROW LEVEL SECURITY;

-- 4. RLS Policies on project_resources
CREATE POLICY project_resources_select_org_member ON public.project_resources FOR SELECT
    USING (moducraft_is_org_member(organization_id));

CREATE POLICY project_resources_insert_authorized ON public.project_resources FOR INSERT
    TO moducraft_runtime
    WITH CHECK (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text, 'member'::text])
        AND created_by = moducraft_current_user_id()
    );

CREATE POLICY project_resources_update_authorized ON public.project_resources FOR UPDATE
    TO moducraft_runtime
    USING (moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text, 'member'::text]))
    WITH CHECK (moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text, 'member'::text]));

CREATE POLICY project_resources_delete_authorized ON public.project_resources FOR DELETE
    TO moducraft_runtime
    USING (moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text]));

-- 5. RLS Policies on resource_credentials (Strict Admin/Owner Only)
CREATE POLICY resource_credentials_select_authorized ON public.resource_credentials FOR SELECT
    TO moducraft_runtime
    USING (moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text]));

CREATE POLICY resource_credentials_insert_authorized ON public.resource_credentials FOR INSERT
    TO moducraft_runtime
    WITH CHECK (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text])
        AND created_by = moducraft_current_user_id()
    );

CREATE POLICY resource_credentials_update_authorized ON public.resource_credentials FOR UPDATE
    TO moducraft_runtime
    USING (moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text]))
    WITH CHECK (moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text]));

CREATE POLICY resource_credentials_delete_authorized ON public.resource_credentials FOR DELETE
    TO moducraft_runtime
    USING (moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text]));

-- 6. Granular Table Grants to moducraft_runtime
GRANT SELECT, DELETE ON public.project_resources TO moducraft_runtime;
GRANT INSERT (
    organization_id, project_id, provider_id, resource_type,
    name, status, endpoint, configuration, error_details, created_by
) ON public.project_resources TO moducraft_runtime;
GRANT UPDATE (
    name, status, endpoint, configuration, error_details, deleted_at, updated_at
) ON public.project_resources TO moducraft_runtime;

GRANT SELECT, DELETE ON public.resource_credentials TO moducraft_runtime;
GRANT INSERT (
    organization_id, project_id, resource_id, status, version,
    username, encrypted_password, key_prefix, key_suffix,
    connection_string_template, created_by
) ON public.resource_credentials TO moducraft_runtime;
GRANT UPDATE (
    status, rotated_at, revoked_at
) ON public.resource_credentials TO moducraft_runtime;

COMMIT;
