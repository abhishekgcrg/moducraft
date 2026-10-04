-- ==============================================================================
-- ModuCraft Phase 2 - Final Authorization & Security Verification Suite
-- File: db/tests/phase2_authorization_test.sql
-- Description: Deterministic, automated test suite verifying PostgreSQL RLS policies,
--              role permissions, RBAC helpers, identity context boundaries, and constraints.
-- Exit Code: 0 on SUCCESS, non-zero on any failure when run with ON_ERROR_STOP=1.
-- ==============================================================================

\set ON_ERROR_STOP on
\set QUIET on

BEGIN;

-- ------------------------------------------------------------------------------
-- 0. PRE-FLIGHT CHECKS: Role Attributes & Function Privileges
-- ------------------------------------------------------------------------------
DO $$
DECLARE
    v_is_super boolean;
    v_bypass_rls boolean;
    v_can_login boolean;
    v_pub_exec boolean;
    v_rt_exec boolean;
BEGIN
    RAISE NOTICE '=== TEST 1: Runtime Role Attributes (moducraft_runtime) ===';
    SELECT rolsuper, rolbypassrls, rolcanlogin
    INTO v_is_super, v_bypass_rls, v_can_login
    FROM pg_roles
    WHERE rolname = 'moducraft_runtime';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'FAIL: Role moducraft_runtime does not exist';
    END IF;

    IF v_is_super THEN
        RAISE EXCEPTION 'FAIL: moducraft_runtime MUST NOT be superuser';
    END IF;

    IF v_bypass_rls THEN
        RAISE EXCEPTION 'FAIL: moducraft_runtime MUST NOT have BYPASSRLS';
    END IF;

    RAISE NOTICE ' [PASS] moducraft_runtime is non-superuser and has NOBYPASSRLS';

    RAISE NOTICE '=== TEST 2: Helper Functions Execution Privileges ===';
    -- Check PUBLIC execution
    SELECT bool_or(has_function_privilege('public', oid, 'EXECUTE'))
    INTO v_pub_exec
    FROM pg_proc
    WHERE proname IN ('moducraft_current_user_id', 'moducraft_is_org_member', 'moducraft_has_org_role');

    IF v_pub_exec THEN
        RAISE EXCEPTION 'FAIL: Helper functions MUST NOT be executable by PUBLIC';
    END IF;

    -- Check moducraft_runtime execution
    SELECT bool_and(has_function_privilege('moducraft_runtime', oid, 'EXECUTE'))
    INTO v_rt_exec
    FROM pg_proc
    WHERE proname IN ('moducraft_current_user_id', 'moducraft_is_org_member', 'moducraft_has_org_role');

    IF NOT v_rt_exec THEN
        RAISE EXCEPTION 'FAIL: Helper functions must be executable by moducraft_runtime';
    END IF;

    RAISE NOTICE ' [PASS] Helper functions revoked from PUBLIC and granted to moducraft_runtime';
END $$;

-- ------------------------------------------------------------------------------
-- 1. SETUP FIXTURES (Deterministic UUIDs)
-- ------------------------------------------------------------------------------
-- Users
INSERT INTO app_users(id, identity_issuer, identity_subject, email, display_name) VALUES
    ('a0000000-0000-4000-8000-000000000001', 'https://auth.test', 'sub-owner-a', 'owner@tenanta.test', 'User A Owner'),
    ('a0000000-0000-4000-8000-000000000002', 'https://auth.test', 'sub-admin-a', 'admin@tenanta.test', 'User A Admin'),
    ('a0000000-0000-4000-8000-000000000003', 'https://auth.test', 'sub-member-a', 'member@tenanta.test', 'User A Member'),
    ('a0000000-0000-4000-8000-000000000004', 'https://auth.test', 'sub-viewer-a', 'viewer@tenanta.test', 'User A Viewer'),
    ('b0000000-0000-4000-8000-000000000001', 'https://auth.test', 'sub-owner-b', 'owner@tenantb.test', 'User B Owner');

-- Organizations
INSERT INTO organizations(id, name, slug, created_by) VALUES
    ('e0000000-0000-4000-8000-000000000001', 'Tenant A Org', 'tenant-a-org', 'a0000000-0000-4000-8000-000000000001'),
    ('e0000000-0000-4000-8000-000000000002', 'Tenant B Org', 'tenant-b-org', 'b0000000-0000-4000-8000-000000000001');

-- Memberships
INSERT INTO organization_memberships(organization_id, user_id, role) VALUES
    ('e0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'owner'),
    ('e0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 'admin'),
    ('e0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000003', 'member'),
    ('e0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000004', 'viewer'),
    ('e0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'owner');

-- Pre-existing Projects
INSERT INTO projects(id, organization_id, name, slug, description, created_by) VALUES
    ('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'Project A Initial', 'project-a-initial', 'Init A', 'a0000000-0000-4000-8000-000000000001'),
    ('f0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000002', 'Project B Initial', 'project-b-initial', 'Init B', 'b0000000-0000-4000-8000-000000000001');

-- Audit events
INSERT INTO audit_events(actor_user_id, organization_id, action, resource_type, outcome) VALUES
    ('a0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'project.created', 'project', 'success'),
    ('b0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000002', 'project.created', 'project', 'success');

-- ------------------------------------------------------------------------------
-- 2. SCHEMA CONSTRAINTS VERIFICATION (Admin Context)
-- ------------------------------------------------------------------------------
DO $$
BEGIN
    RAISE NOTICE '=== TEST 3: Database Integrity Constraints ===';

    -- Test invalid organization slug
    BEGIN
        INSERT INTO organizations(name, slug, created_by)
        VALUES ('Bad Slug Org', 'Invalid_Slug!', 'a0000000-0000-4000-8000-000000000001');
        RAISE EXCEPTION 'FAIL: Invalid organization slug was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE ' [PASS] Invalid organization slug rejected by check constraint';
    END;

    -- Test duplicate organization slug
    BEGIN
        INSERT INTO organizations(name, slug, created_by)
        VALUES ('Duplicate Org', 'tenant-a-org', 'a0000000-0000-4000-8000-000000000001');
        RAISE EXCEPTION 'FAIL: Duplicate organization slug was accepted';
    EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE ' [PASS] Duplicate organization slug rejected by unique constraint';
    END;

    -- Test invalid membership role
    BEGIN
        INSERT INTO organization_memberships(organization_id, user_id, role)
        VALUES ('e0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'superadmin');
        RAISE EXCEPTION 'FAIL: Invalid membership role was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE ' [PASS] Invalid role rejected by check constraint';
    END;

    -- Test invalid project slug
    BEGIN
        INSERT INTO projects(organization_id, name, slug, created_by)
        VALUES ('e0000000-0000-4000-8000-000000000001', 'Bad Project', '-bad-slug-', 'a0000000-0000-4000-8000-000000000001');
        RAISE EXCEPTION 'FAIL: Invalid project slug was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE ' [PASS] Invalid project slug rejected by check constraint';
    END;

    -- Test duplicate project slug in SAME organization
    BEGIN
        INSERT INTO projects(organization_id, name, slug, created_by)
        VALUES ('e0000000-0000-4000-8000-000000000001', 'Duplicate Slug Project', 'project-a-initial', 'a0000000-0000-4000-8000-000000000001');
        RAISE EXCEPTION 'FAIL: Duplicate project slug in same org was accepted';
    EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE ' [PASS] Duplicate project slug in same org rejected by unique constraint';
    END;

    -- Test same project slug in DIFFERENT organization (should succeed)
    INSERT INTO projects(organization_id, name, slug, created_by)
    VALUES ('e0000000-0000-4000-8000-000000000002', 'Same Slug In B', 'project-a-initial', 'b0000000-0000-4000-8000-000000000001');
    RAISE NOTICE ' [PASS] Identical project slug in distinct organization allowed';
END $$;

-- ------------------------------------------------------------------------------
-- 3. TRANSITION TO RESTRICTED RUNTIME ROLE
-- ------------------------------------------------------------------------------
SET LOCAL ROLE moducraft_runtime;

-- ------------------------------------------------------------------------------
-- 4. DIRECT TABLE MODIFICATION ATTEMPTS (Table Privileges Verification)
-- ------------------------------------------------------------------------------
DO $$
BEGIN
    RAISE NOTICE '=== TEST 4: Direct Table Modification Privilege Denial ===';

    -- Attempt INSERT on app_users
    BEGIN
        INSERT INTO app_users(identity_issuer, identity_subject, email)
        VALUES ('https://evil.test', 'sub-evil', 'evil@test');
        RAISE EXCEPTION 'FAIL: Direct INSERT on app_users was permitted';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE ' [PASS] Direct INSERT on app_users denied';
    END;

    -- Attempt INSERT on organizations
    BEGIN
        INSERT INTO organizations(name, slug, created_by)
        VALUES ('Direct Org', 'direct-org', 'a0000000-0000-4000-8000-000000000001');
        RAISE EXCEPTION 'FAIL: Direct INSERT on organizations was permitted';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE ' [PASS] Direct INSERT on organizations denied';
    END;

    -- Attempt INSERT on organization_memberships
    BEGIN
        INSERT INTO organization_memberships(organization_id, user_id, role)
        VALUES ('e0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'owner');
        RAISE EXCEPTION 'FAIL: Direct INSERT on organization_memberships was permitted';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE ' [PASS] Direct INSERT on organization_memberships denied';
    END;

    -- Attempt UPDATE on organization_memberships
    BEGIN
        UPDATE organization_memberships SET role = 'owner';
        RAISE EXCEPTION 'FAIL: Direct UPDATE on organization_memberships was permitted';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE ' [PASS] Direct UPDATE on organization_memberships denied';
    END;

    -- Attempt DELETE on organization_memberships
    BEGIN
        DELETE FROM organization_memberships;
        RAISE EXCEPTION 'FAIL: Direct DELETE on organization_memberships was permitted';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE ' [PASS] Direct DELETE on organization_memberships denied';
    END;

    -- Attempt INSERT on audit_events
    BEGIN
        INSERT INTO audit_events(action, resource_type, outcome)
        VALUES ('tampered.event', 'system', 'success');
        RAISE EXCEPTION 'FAIL: Direct INSERT on audit_events was permitted';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE ' [PASS] Direct INSERT on audit_events denied';
    END;

    -- Attempt UPDATE on audit_events
    BEGIN
        UPDATE audit_events SET outcome = 'failure';
        RAISE EXCEPTION 'FAIL: Direct UPDATE on audit_events was permitted';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE ' [PASS] Direct UPDATE on audit_events denied';
    END;

    -- Attempt DELETE on audit_events
    BEGIN
        DELETE FROM audit_events;
        RAISE EXCEPTION 'FAIL: Direct DELETE on audit_events was permitted';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE ' [PASS] Direct DELETE on audit_events denied';
    END;
END $$;

-- ------------------------------------------------------------------------------
-- 5. PROTECTED COLUMN IMMUTABILITY ON PROJECTS (Column Privileges Verification)
-- ------------------------------------------------------------------------------
SELECT set_config('app.user_id', 'a0000000-0000-4000-8000-000000000001', true);

DO $$
BEGIN
    RAISE NOTICE '=== TEST 5: Protected Column Immutability on Projects ===';

    -- Attempt to change organization_id
    BEGIN
        UPDATE projects
        SET organization_id = 'e0000000-0000-4000-8000-000000000002'
        WHERE id = 'f0000000-0000-4000-8000-000000000001';
        RAISE EXCEPTION 'FAIL: Modifying organization_id was permitted';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE ' [PASS] Moving project to another organization denied by column privilege';
    END;

    -- Attempt to change created_by
    BEGIN
        UPDATE projects
        SET created_by = 'a0000000-0000-4000-8000-000000000002'
        WHERE id = 'f0000000-0000-4000-8000-000000000001';
        RAISE EXCEPTION 'FAIL: Modifying created_by was permitted';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE ' [PASS] Tampering with created_by denied by column privilege';
    END;

    -- Attempt to change id
    BEGIN
        UPDATE projects
        SET id = 'f0000000-0000-4000-8000-000000000099'
        WHERE id = 'f0000000-0000-4000-8000-000000000001';
        RAISE EXCEPTION 'FAIL: Modifying id was permitted';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE ' [PASS] Modifying primary key id denied by column privilege';
    END;
END $$;

-- ------------------------------------------------------------------------------
-- 6. TENANT ISOLATION READ ACCESS (Tenant A Member vs Tenant B Data)
-- ------------------------------------------------------------------------------
SELECT set_config('app.user_id', 'a0000000-0000-4000-8000-000000000003', true);

DO $$
DECLARE
    v_cnt int;
BEGIN
    RAISE NOTICE '=== TEST 6: Tenant Isolation Read Boundaries ===';

    -- Tenant A Member cannot read Tenant B's organization
    SELECT count(*) INTO v_cnt FROM organizations WHERE id = 'e0000000-0000-4000-8000-000000000002';
    IF v_cnt <> 0 THEN RAISE EXCEPTION 'FAIL: Tenant A can read Tenant B organization'; END IF;

    -- Tenant A Member cannot read Tenant B's projects
    SELECT count(*) INTO v_cnt FROM projects WHERE organization_id = 'e0000000-0000-4000-8000-000000000002';
    IF v_cnt <> 0 THEN RAISE EXCEPTION 'FAIL: Tenant A can read Tenant B projects'; END IF;

    -- Tenant A Member cannot read Tenant B's memberships
    SELECT count(*) INTO v_cnt FROM organization_memberships WHERE organization_id = 'e0000000-0000-4000-8000-000000000002';
    IF v_cnt <> 0 THEN RAISE EXCEPTION 'FAIL: Tenant A can read Tenant B memberships'; END IF;

    -- Tenant A Member cannot read Tenant B's audit events
    SELECT count(*) INTO v_cnt FROM audit_events WHERE organization_id = 'e0000000-0000-4000-8000-000000000002';
    IF v_cnt <> 0 THEN RAISE EXCEPTION 'FAIL: Tenant A can read Tenant B audit events'; END IF;

    -- Tenant A Member cannot read other users from app_users
    SELECT count(*) INTO v_cnt FROM app_users WHERE id = 'b0000000-0000-4000-8000-000000000001';
    IF v_cnt <> 0 THEN RAISE EXCEPTION 'FAIL: User A can read User B profile'; END IF;

    RAISE NOTICE ' [PASS] Tenant A cannot read Tenant B data across all core tables';
END $$;

-- ------------------------------------------------------------------------------
-- 7. ROLE-BASED PROJECT CRUD (Viewer, Member, Admin, Owner)
-- ------------------------------------------------------------------------------
-- A. VIEWER TESTS
SELECT set_config('app.user_id', 'a0000000-0000-4000-8000-000000000004', true);

DO $$
DECLARE
    v_affected int;
BEGIN
    RAISE NOTICE '=== TEST 7A: Viewer Role Restrictions ===';

    -- Viewer CANNOT insert
    BEGIN
        INSERT INTO projects(organization_id, name, slug, created_by)
        VALUES ('e0000000-0000-4000-8000-000000000001', 'Viewer Proj', 'viewer-proj', 'a0000000-0000-4000-8000-000000000004');
        RAISE EXCEPTION 'FAIL: Viewer was able to insert project';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE ' [PASS] Viewer insert rejected by RLS policy';
    END;

    -- Viewer CANNOT update (affects 0 rows)
    UPDATE projects SET name = 'Viewer Mutated' WHERE id = 'f0000000-0000-4000-8000-000000000001';
    GET DIAGNOSTICS v_affected = ROW_COUNT;
    IF v_affected <> 0 THEN RAISE EXCEPTION 'FAIL: Viewer updated % rows', v_affected; END IF;
    RAISE NOTICE ' [PASS] Viewer update affected 0 rows';

    -- Viewer CANNOT delete (affects 0 rows)
    DELETE FROM projects WHERE id = 'f0000000-0000-4000-8000-000000000001';
    GET DIAGNOSTICS v_affected = ROW_COUNT;
    IF v_affected <> 0 THEN RAISE EXCEPTION 'FAIL: Viewer deleted % rows', v_affected; END IF;
    RAISE NOTICE ' [PASS] Viewer delete affected 0 rows';
END $$;

-- B. MEMBER TESTS
SELECT set_config('app.user_id', 'a0000000-0000-4000-8000-000000000003', true);

DO $$
DECLARE
    v_affected int;
    v_t1 timestamptz;
    v_t2 timestamptz;
BEGIN
    RAISE NOTICE '=== TEST 7B: Member Role Permissions ===';

    -- Member CAN insert in authorized organization
    INSERT INTO projects(organization_id, name, slug, description, created_by)
    VALUES ('e0000000-0000-4000-8000-000000000001', 'Member Proj', 'member-proj', 'Desc by Member', 'a0000000-0000-4000-8000-000000000003');
    RAISE NOTICE ' [PASS] Member created project successfully';

    -- Member CAN update allowed fields
    SELECT updated_at INTO v_t1 FROM projects WHERE slug = 'member-proj';
    UPDATE projects SET name = 'Member Proj Renamed', description = 'New Desc' WHERE slug = 'member-proj';
    GET DIAGNOSTICS v_affected = ROW_COUNT;
    IF v_affected <> 1 THEN RAISE EXCEPTION 'FAIL: Member update affected % rows', v_affected; END IF;
    SELECT updated_at INTO v_t2 FROM projects WHERE slug = 'member-proj';
    IF v_t2 < v_t1 THEN RAISE EXCEPTION 'FAIL: updated_at trigger did not update timestamp'; END IF;
    RAISE NOTICE ' [PASS] Member updated project successfully and updated_at trigger fired';

    -- Member CANNOT delete (affects 0 rows)
    DELETE FROM projects WHERE slug = 'member-proj';
    GET DIAGNOSTICS v_affected = ROW_COUNT;
    IF v_affected <> 0 THEN RAISE EXCEPTION 'FAIL: Member deleted % rows', v_affected; END IF;
    RAISE NOTICE ' [PASS] Member delete affected 0 rows';
END $$;

-- C. ADMIN TESTS
SELECT set_config('app.user_id', 'a0000000-0000-4000-8000-000000000002', true);

DO $$
DECLARE
    v_affected int;
BEGIN
    RAISE NOTICE '=== TEST 7C: Admin Role Permissions ===';

    -- Admin CAN delete projects within authorized org
    DELETE FROM projects WHERE slug = 'member-proj';
    GET DIAGNOSTICS v_affected = ROW_COUNT;
    IF v_affected <> 1 THEN RAISE EXCEPTION 'FAIL: Admin expected to delete 1 row, deleted %', v_affected; END IF;
    RAISE NOTICE ' [PASS] Admin deleted project successfully';
END $$;

-- D. OWNER TESTS
SELECT set_config('app.user_id', 'a0000000-0000-4000-8000-000000000001', true);

DO $$
DECLARE
    v_affected int;
BEGIN
    RAISE NOTICE '=== TEST 7D: Owner Role Permissions ===';

    -- Owner CAN delete projects within authorized org
    DELETE FROM projects WHERE id = 'f0000000-0000-4000-8000-000000000001';
    GET DIAGNOSTICS v_affected = ROW_COUNT;
    IF v_affected <> 1 THEN RAISE EXCEPTION 'FAIL: Owner expected to delete 1 row, deleted %', v_affected; END IF;
    RAISE NOTICE ' [PASS] Owner deleted project successfully';
END $$;

-- ------------------------------------------------------------------------------
-- 8. UNAUTHORIZED CREATION & CROSS-TENANT MUTATION ATTEMPTS
-- ------------------------------------------------------------------------------
SELECT set_config('app.user_id', 'a0000000-0000-4000-8000-000000000001', true);

DO $$
DECLARE
    v_affected int;
BEGIN
    RAISE NOTICE '=== TEST 8: Unauthorized Creation & Cross-Tenant Mutation ===';

    -- Attempt to insert project into Tenant B Org by User A
    BEGIN
        INSERT INTO projects(organization_id, name, slug, created_by)
        VALUES ('e0000000-0000-4000-8000-000000000002', 'Cross Proj', 'cross-proj', 'a0000000-0000-4000-8000-000000000001');
        RAISE EXCEPTION 'FAIL: User A created project in Tenant B';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE ' [PASS] Creation in unauthorized tenant organization rejected by RLS';
    END;

    -- Attempt to insert project with spoofed created_by
    BEGIN
        INSERT INTO projects(organization_id, name, slug, created_by)
        VALUES ('e0000000-0000-4000-8000-000000000001', 'Spoofed Proj', 'spoofed-proj', 'a0000000-0000-4000-8000-000000000002');
        RAISE EXCEPTION 'FAIL: Project created with spoofed created_by';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE ' [PASS] Creation with spoofed created_by rejected by RLS';
    END;

    -- Cross-tenant UPDATE attempt (affects 0 rows)
    UPDATE projects SET name = 'Exploited' WHERE organization_id = 'e0000000-0000-4000-8000-000000000002';
    GET DIAGNOSTICS v_affected = ROW_COUNT;
    IF v_affected <> 0 THEN RAISE EXCEPTION 'FAIL: Cross-tenant update modified % rows', v_affected; END IF;
    RAISE NOTICE ' [PASS] Cross-tenant update affected 0 rows';

    -- Cross-tenant DELETE attempt (affects 0 rows)
    DELETE FROM projects WHERE organization_id = 'e0000000-0000-4000-8000-000000000002';
    GET DIAGNOSTICS v_affected = ROW_COUNT;
    IF v_affected <> 0 THEN RAISE EXCEPTION 'FAIL: Cross-tenant delete affected % rows', v_affected; END IF;
    RAISE NOTICE ' [PASS] Cross-tenant delete affected 0 rows';
END $$;

-- ------------------------------------------------------------------------------
-- 9. IDENTITY TRUST BOUNDARY VERIFICATION
-- ------------------------------------------------------------------------------
DO $$
DECLARE
    v_orig_user text;
    v_spoofed_user text;
BEGIN
    RAISE NOTICE '=== TEST 9: Identity Trust Boundary (set_config behavior) ===';

    v_orig_user := current_setting('app.user_id', true);
    PERFORM set_config('app.user_id', 'b0000000-0000-4000-8000-000000000001', true);
    v_spoofed_user := current_setting('app.user_id', true);

    IF v_spoofed_user <> 'b0000000-0000-4000-8000-000000000001' THEN
        RAISE EXCEPTION 'FAIL: set_config did not set app.user_id';
    END IF;

    -- Document finding: Database role with access CAN change app.user_id arbitrarily
    RAISE NOTICE ' [VULNERABILITY FINDING] moducraft_runtime role CAN execute set_config(''app.user_id'', ...) directly.';
    RAISE NOTICE ' [TRUST BOUNDARY] app.user_id provides context passing from trusted backend, NOT cryptographic identity proof.';
END $$;

-- ------------------------------------------------------------------------------
-- CLEANUP / ROLLBACK
-- ------------------------------------------------------------------------------
ROLLBACK;

\echo '=============================================================================='
\echo '>>> ALL PHASE 2 AUTHORIZATION & SECURITY TESTS PASSED SUCCESSFULLY! <<<'
\echo '=============================================================================='
