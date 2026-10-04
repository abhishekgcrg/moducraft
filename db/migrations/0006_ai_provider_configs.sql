-- Migration 0006: AI Provider Abstraction Foundation
-- Tables, constraints, forced RLS, and grants for provider_configs and provider_usage_records
BEGIN;

-- 1. Create provider_configs table
CREATE TABLE public.provider_configs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    provider_type text NOT NULL CHECK(provider_type IN ('openai', 'anthropic', 'custom', 'mock')),
    name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
    base_url text NOT NULL CHECK(length(trim(base_url)) BETWEEN 1 AND 500),
    model_id text NOT NULL CHECK(length(trim(model_id)) BETWEEN 1 AND 100),
    encrypted_api_key text NOT NULL,
    key_prefix text NOT NULL CHECK(length(key_prefix) BETWEEN 1 AND 20),
    key_suffix text NOT NULL CHECK(length(key_suffix) BETWEEN 1 AND 20),
    is_enabled boolean NOT NULL DEFAULT true,
    token_budget_monthly bigint NOT NULL DEFAULT 1000000 CHECK(token_budget_monthly >= 0),
    tokens_used_month bigint NOT NULL DEFAULT 0 CHECK(tokens_used_month >= 0),
    version integer NOT NULL DEFAULT 1 CHECK(version >= 1),
    created_by uuid NOT NULL REFERENCES public.app_users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_provider_configs_org_id UNIQUE (organization_id, id),
    CONSTRAINT uq_provider_configs_org_name UNIQUE (organization_id, name)
);

-- 2. Add provider_config_id reference to agent_tasks (tenant-consistent FK)
ALTER TABLE public.agent_tasks ADD COLUMN provider_config_id uuid;

ALTER TABLE public.agent_tasks
    ADD CONSTRAINT fk_agent_tasks_provider_config
    FOREIGN KEY (organization_id, provider_config_id)
    REFERENCES public.provider_configs(organization_id, id)
    ON DELETE SET NULL;

-- 3. Create provider_usage_records table (Append-only usage tracking)
CREATE TABLE public.provider_usage_records (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id uuid NOT NULL,
    provider_config_id uuid NOT NULL,
    task_id uuid,
    step_id uuid,
    model_id text NOT NULL CHECK(length(trim(model_id)) BETWEEN 1 AND 100),
    prompt_tokens integer NOT NULL DEFAULT 0 CHECK(prompt_tokens >= 0),
    completion_tokens integer NOT NULL DEFAULT 0 CHECK(completion_tokens >= 0),
    total_tokens integer NOT NULL DEFAULT 0 CHECK(total_tokens >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_provider_usage_config
        FOREIGN KEY (organization_id, provider_config_id)
        REFERENCES public.provider_configs(organization_id, id)
        ON DELETE CASCADE,
    CONSTRAINT fk_provider_usage_step
        FOREIGN KEY (organization_id, step_id)
        REFERENCES public.agent_task_steps(organization_id, id)
        ON DELETE SET NULL
);

-- 4. Indexes for tenant and query lookups
CREATE INDEX idx_provider_configs_org ON public.provider_configs(organization_id, is_enabled);
CREATE INDEX idx_provider_usage_org_config ON public.provider_usage_records(organization_id, provider_config_id, created_at DESC);
CREATE INDEX idx_provider_usage_task ON public.provider_usage_records(task_id);

-- 5. Updated_at trigger for provider_configs
CREATE TRIGGER provider_configs_set_updated_at
BEFORE UPDATE ON public.provider_configs
FOR EACH ROW EXECUTE FUNCTION public.moducraft_set_updated_at();

-- 6. Enable and FORCE Row-Level Security
ALTER TABLE public.provider_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_configs FORCE ROW LEVEL SECURITY;

ALTER TABLE public.provider_usage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_usage_records FORCE ROW LEVEL SECURITY;

-- 7. RLS Policies on provider_configs
DROP POLICY IF EXISTS provider_configs_select_org_member ON public.provider_configs;
CREATE POLICY provider_configs_select_org_member ON public.provider_configs FOR SELECT
    USING (moducraft_is_org_member(organization_id));

DROP POLICY IF EXISTS provider_configs_insert_authorized ON public.provider_configs;
CREATE POLICY provider_configs_insert_authorized ON public.provider_configs FOR INSERT
    TO moducraft_runtime
    WITH CHECK (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text])
        AND created_by = moducraft_current_user_id()
    );

DROP POLICY IF EXISTS provider_configs_update_authorized ON public.provider_configs;
CREATE POLICY provider_configs_update_authorized ON public.provider_configs FOR UPDATE
    TO moducraft_runtime
    USING (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text])
    )
    WITH CHECK (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text])
    );

DROP POLICY IF EXISTS provider_configs_delete_authorized ON public.provider_configs;
CREATE POLICY provider_configs_delete_authorized ON public.provider_configs FOR DELETE
    TO moducraft_runtime
    USING (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text])
    );

-- 8. RLS Policies on provider_usage_records
DROP POLICY IF EXISTS provider_usage_select_org_member ON public.provider_usage_records;
CREATE POLICY provider_usage_select_org_member ON public.provider_usage_records FOR SELECT
    USING (moducraft_is_org_member(organization_id));

DROP POLICY IF EXISTS provider_usage_insert_authorized ON public.provider_usage_records;
CREATE POLICY provider_usage_insert_authorized ON public.provider_usage_records FOR INSERT
    TO moducraft_runtime
    WITH CHECK (
        moducraft_has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text, 'member'::text])
    );

-- 9. Table & column grants for moducraft_runtime
GRANT SELECT, DELETE ON public.provider_configs TO moducraft_runtime;
GRANT INSERT (
    organization_id, provider_type, name, base_url, model_id,
    encrypted_api_key, key_prefix, key_suffix, is_enabled,
    token_budget_monthly, tokens_used_month, version, created_by
) ON public.provider_configs TO moducraft_runtime;
GRANT UPDATE (
    name, base_url, model_id, encrypted_api_key, key_prefix,
    key_suffix, is_enabled, token_budget_monthly, tokens_used_month, version
) ON public.provider_configs TO moducraft_runtime;

-- Allow moducraft_runtime to reference and update provider_config_id on agent_tasks
GRANT INSERT (provider_config_id) ON public.agent_tasks TO moducraft_runtime;
GRANT UPDATE (provider_config_id) ON public.agent_tasks TO moducraft_runtime;

-- provider_usage_records grants (append-only)
GRANT SELECT ON public.provider_usage_records TO moducraft_runtime;
GRANT INSERT (
    organization_id, provider_config_id, task_id, step_id,
    model_id, prompt_tokens, completion_tokens, total_tokens
) ON public.provider_usage_records TO moducraft_runtime;

COMMIT;
