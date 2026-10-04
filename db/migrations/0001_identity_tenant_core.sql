BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE app_users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 identity_issuer text NOT NULL,
 identity_subject text NOT NULL,
 email text,
 display_name text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(identity_issuer, identity_subject)
);

CREATE TABLE organizations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
 slug text NOT NULL UNIQUE CHECK(slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
 created_by uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_memberships (
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
 role text NOT NULL CHECK(role IN ('owner','admin','member','viewer')),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
 PRIMARY KEY(organization_id, user_id)
);

CREATE TABLE projects (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
 slug text NOT NULL CHECK(slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
 description text,
 created_by uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id, slug),
 UNIQUE(organization_id, id)
);

CREATE TABLE audit_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
 organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
 action text NOT NULL CHECK(length(trim(action)) BETWEEN 1 AND 120),
 resource_type text NOT NULL CHECK(length(trim(resource_type)) BETWEEN 1 AND 80),
 resource_id text,
 outcome text NOT NULL CHECK(outcome IN ('success','denied','failure')),
 request_id text,
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_memberships_user ON organization_memberships(user_id, organization_id);
CREATE INDEX idx_projects_org_created ON projects(organization_id, created_at DESC);
CREATE INDEX idx_audit_org_created ON audit_events(organization_id, created_at DESC);
CREATE INDEX idx_audit_actor_created ON audit_events(actor_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION moducraft_current_user_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION moducraft_is_org_member(target_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT EXISTS (
   SELECT 1 FROM organization_memberships m
   WHERE m.organization_id = target_org
     AND m.user_id = moducraft_current_user_id()
 )
$$;

ALTER TABLE app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_users FORCE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

CREATE POLICY app_users_select_self ON app_users FOR SELECT
 USING(id = moducraft_current_user_id());
CREATE POLICY organizations_select_member ON organizations FOR SELECT
 USING(moducraft_is_org_member(id));
CREATE POLICY memberships_select_org_member ON organization_memberships FOR SELECT
 USING(moducraft_is_org_member(organization_id));
CREATE POLICY projects_select_org_member ON projects FOR SELECT
 USING(moducraft_is_org_member(organization_id));
CREATE POLICY audit_select_org_member ON audit_events FOR SELECT
 USING(organization_id IS NOT NULL AND moducraft_is_org_member(organization_id));

-- Intentionally no write policies yet: RLS-constrained application roles are
-- default-denied for INSERT/UPDATE/DELETE until authorized API workflows exist.
COMMIT;
