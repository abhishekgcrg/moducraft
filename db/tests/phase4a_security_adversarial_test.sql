-- Phase 4A Adversarial Security Audit Script
-- Target: moducraft_disposable_audit
-- Tests direct SQL attacks as moducraft_runtime against agent_tasks, agent_task_steps, agent_task_events

\set ON_ERROR_STOP on

-- Connect as superuser to seed test entities
\c moducraft_disposable_audit moducraft

DO $$
BEGIN
    RAISE NOTICE '=== SEEDING TEST FIXTURES IN DISPOSABLE DB ===';
END $$;

-- 1. Seed test users
INSERT INTO public.app_users (id, identity_issuer, identity_subject, email, display_name)
VALUES
    ('a0000000-0000-4000-8000-000000000001', 'https://auth.moducraft.test', 'sub-adv-a1', 'a1@adv.test', 'Adv User A1 (Owner)'),
    ('a0000000-0000-4000-8000-000000000002', 'https://auth.moducraft.test', 'sub-adv-a2', 'a2@adv.test', 'Adv User A2 (Viewer)'),
    ('b0000000-0000-4000-8000-000000000001', 'https://auth.moducraft.test', 'sub-adv-b1', 'b1@adv.test', 'Adv User B1 (Owner)')
ON CONFLICT (id) DO NOTHING;

-- 2. Seed organizations
INSERT INTO public.organizations (id, name, slug, created_by)
VALUES
    ('a1111111-0000-4000-8000-000000000001', 'Org Alpha', 'org-alpha', 'a0000000-0000-4000-8000-000000000001'),
    ('b1111111-0000-4000-8000-000000000001', 'Org Beta', 'org-beta', 'b0000000-0000-4000-8000-000000000001')
ON CONFLICT (id) DO NOTHING;

-- 3. Seed memberships
INSERT INTO public.organization_memberships (organization_id, user_id, role, created_by)
VALUES
    ('a1111111-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'owner', 'a0000000-0000-4000-8000-000000000001'),
    ('a1111111-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 'viewer', 'a0000000-0000-4000-8000-000000000001'),
    ('b1111111-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'owner', 'b0000000-0000-4000-8000-000000000001')
ON CONFLICT (organization_id, user_id) DO NOTHING;

-- 4. Seed projects
INSERT INTO public.projects (id, organization_id, name, slug, description, created_by)
VALUES
    ('a2222222-0000-4000-8000-000000000001', 'a1111111-0000-4000-8000-000000000001', 'Alpha Project', 'alpha-proj', 'Alpha', 'a0000000-0000-4000-8000-000000000001'),
    ('b2222222-0000-4000-8000-000000000001', 'b1111111-0000-4000-8000-000000000001', 'Beta Project', 'beta-proj', 'Beta', 'b0000000-0000-4000-8000-000000000001')
ON CONFLICT (id) DO NOTHING;

-- 5. Seed an initial task in Org Alpha
INSERT INTO public.agent_tasks (
    id, organization_id, project_id, created_by, task_type, title, status, current_step_key, version
) VALUES (
    'a3333333-0000-4000-8000-000000000001',
    'a1111111-0000-4000-8000-000000000001',
    'a2222222-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    'project_summary',
    'Initial Alpha Task',
    'queued',
    'step_1',
    1
) ON CONFLICT (id) DO NOTHING;

-- 6. Seed a step in Org Alpha
INSERT INTO public.agent_task_steps (
    id, task_id, organization_id, step_key, step_type, position, status, attempt_count, max_attempts
) VALUES (
    'a4444444-0000-4000-8000-000000000001',
    'a3333333-0000-4000-8000-000000000001',
    'a1111111-0000-4000-8000-000000000001',
    'step_1',
    'inspect_project_meta',
    1,
    'ready',
    0,
    3
) ON CONFLICT (id) DO NOTHING;

-- 7. Seed an event in Org Alpha
INSERT INTO public.agent_task_events (
    task_id, organization_id, step_id, event_type, actor_user_id, metadata
) VALUES (
    'a3333333-0000-4000-8000-000000000001',
    'a1111111-0000-4000-8000-000000000001',
    'a4444444-0000-4000-8000-000000000001',
    'task.created',
    'a0000000-0000-4000-8000-000000000001',
    '{"init": true}'::jsonb
);

-- =========================================================================
-- SWITCH TO RESTRICTED RUNTIME ROLE
-- =========================================================================
\c moducraft_disposable_audit moducraft_runtime

DO $$
BEGIN
    RAISE NOTICE '=== CONNECTED AS moducraft_runtime: EXECUTING ADVERSARIAL TESTS ===';
END $$;

-- -------------------------------------------------------------------------
-- TEST 1: Cross-Tenant Read & Write as User B1 (Tenant Beta attacking Tenant Alpha)
-- -------------------------------------------------------------------------
BEGIN;
SELECT set_config('app.user_id', 'b0000000-0000-4000-8000-000000000001', true);

-- Attempt cross-tenant SELECT on agent_tasks
DO $$
DECLARE
    cnt integer;
BEGIN
    SELECT count(*) INTO cnt FROM public.agent_tasks WHERE organization_id = 'a1111111-0000-4000-8000-000000000001';
    IF cnt <> 0 THEN
        RAISE EXCEPTION '[FAIL] Cross-tenant SELECT on agent_tasks returned % rows!', cnt;
    END IF;
    RAISE NOTICE ' [PASS] Cross-tenant SELECT on agent_tasks returned 0 rows (RLS enforced)';
END $$;

-- Attempt cross-tenant SELECT on agent_task_steps
DO $$
DECLARE
    cnt integer;
BEGIN
    SELECT count(*) INTO cnt FROM public.agent_task_steps WHERE organization_id = 'a1111111-0000-4000-8000-000000000001';
    IF cnt <> 0 THEN
        RAISE EXCEPTION '[FAIL] Cross-tenant SELECT on agent_task_steps returned % rows!', cnt;
    END IF;
    RAISE NOTICE ' [PASS] Cross-tenant SELECT on agent_task_steps returned 0 rows (RLS enforced)';
END $$;

-- Attempt cross-tenant SELECT on agent_task_events
DO $$
DECLARE
    cnt integer;
BEGIN
    SELECT count(*) INTO cnt FROM public.agent_task_events WHERE organization_id = 'a1111111-0000-4000-8000-000000000001';
    IF cnt <> 0 THEN
        RAISE EXCEPTION '[FAIL] Cross-tenant SELECT on agent_task_events returned % rows!', cnt;
    END IF;
    RAISE NOTICE ' [PASS] Cross-tenant SELECT on agent_task_events returned 0 rows (RLS enforced)';
END $$;

-- Attempt cross-tenant INSERT into agent_tasks
DO $$
BEGIN
    INSERT INTO public.agent_tasks (
        organization_id, created_by, task_type, title, status, version
    ) VALUES (
        'a1111111-0000-4000-8000-000000000001',
        'b0000000-0000-4000-8000-000000000001',
        'project_summary',
        'Attacker Task',
        'queued',
        1
    );
    RAISE EXCEPTION '[FAIL] Cross-tenant INSERT into agent_tasks succeeded!';
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE ' [PASS] Cross-tenant INSERT into agent_tasks blocked by RLS WITH CHECK';
END $$;

-- Attempt cross-tenant UPDATE on agent_tasks
DO $$
DECLARE
    affected integer;
BEGIN
    UPDATE public.agent_tasks
    SET status = 'cancelled'
    WHERE organization_id = 'a1111111-0000-4000-8000-000000000001';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN
        RAISE EXCEPTION '[FAIL] Cross-tenant UPDATE on agent_tasks affected % rows!', affected;
    END IF;
    RAISE NOTICE ' [PASS] Cross-tenant UPDATE on agent_tasks affected 0 rows';
END $$;

-- Attempt cross-tenant DELETE on agent_tasks
DO $$
DECLARE
    affected integer;
BEGIN
    DELETE FROM public.agent_tasks
    WHERE organization_id = 'a1111111-0000-4000-8000-000000000001';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN
        RAISE EXCEPTION '[FAIL] Cross-tenant DELETE on agent_tasks affected % rows!', affected;
    END IF;
    RAISE NOTICE ' [PASS] Cross-tenant DELETE on agent_tasks affected 0 rows';
END $$;
ROLLBACK;

-- -------------------------------------------------------------------------
-- TEST 2: Tenant Reassignment Attack (Altering organization_id)
-- -------------------------------------------------------------------------
BEGIN;
SELECT set_config('app.user_id', 'a0000000-0000-4000-8000-000000000001', true);

DO $$
BEGIN
    UPDATE public.agent_tasks
    SET organization_id = 'b1111111-0000-4000-8000-000000000001'
    WHERE id = 'a3333333-0000-4000-8000-000000000001';
    RAISE EXCEPTION '[FAIL] Updating organization_id on agent_tasks succeeded!';
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE ' [PASS] Updating organization_id on agent_tasks denied by column privileges';
END $$;

DO $$
BEGIN
    UPDATE public.agent_task_steps
    SET organization_id = 'b1111111-0000-4000-8000-000000000001'
    WHERE id = 'a4444444-0000-4000-8000-000000000001';
    RAISE EXCEPTION '[FAIL] Updating organization_id on agent_task_steps succeeded!';
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE ' [PASS] Updating organization_id on agent_task_steps denied by column privileges';
END $$;
ROLLBACK;

-- -------------------------------------------------------------------------
-- TEST 3: Tampering with Primary Key id or created_by
-- -------------------------------------------------------------------------
BEGIN;
SELECT set_config('app.user_id', 'a0000000-0000-4000-8000-000000000001', true);

DO $$
BEGIN
    UPDATE public.agent_tasks
    SET created_by = 'b0000000-0000-4000-8000-000000000001'
    WHERE id = 'a3333333-0000-4000-8000-000000000001';
    RAISE EXCEPTION '[FAIL] Updating created_by on agent_tasks succeeded!';
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE ' [PASS] Updating created_by on agent_tasks denied by column privileges';
END $$;

DO $$
BEGIN
    UPDATE public.agent_tasks
    SET id = 'a9999999-0000-4000-8000-000000000001'
    WHERE id = 'a3333333-0000-4000-8000-000000000001';
    RAISE EXCEPTION '[FAIL] Updating id on agent_tasks succeeded!';
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE ' [PASS] Updating id on agent_tasks denied by column privileges';
END $$;
ROLLBACK;

-- -------------------------------------------------------------------------
-- TEST 4: Event Journal Tampering (UPDATE & DELETE denial)
-- -------------------------------------------------------------------------
BEGIN;
SELECT set_config('app.user_id', 'a0000000-0000-4000-8000-000000000001', true);

DO $$
BEGIN
    UPDATE public.agent_task_events
    SET event_type = 'forged.event'
    WHERE task_id = 'a3333333-0000-4000-8000-000000000001';
    RAISE EXCEPTION '[FAIL] UPDATE on agent_task_events succeeded!';
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE ' [PASS] Direct UPDATE on agent_task_events denied by table privileges';
END $$;

DO $$
BEGIN
    DELETE FROM public.agent_task_events
    WHERE task_id = 'a3333333-0000-4000-8000-000000000001';
    RAISE EXCEPTION '[FAIL] DELETE on agent_task_events succeeded!';
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE ' [PASS] Direct DELETE on agent_task_events denied by table privileges';
END $$;
ROLLBACK;

-- -------------------------------------------------------------------------
-- TEST 5: Parent-Child Organization Mismatches (Foreign Key Enforcement)
-- -------------------------------------------------------------------------
BEGIN;
SELECT set_config('app.user_id', 'a0000000-0000-4000-8000-000000000001', true);

-- Attempt attaching Task in Org Alpha to Project in Org Beta
DO $$
BEGIN
    INSERT INTO public.agent_tasks (
        organization_id, project_id, created_by, task_type, title, status, version
    ) VALUES (
        'a1111111-0000-4000-8000-000000000001',
        'b2222222-0000-4000-8000-000000000001', -- Project from Org Beta
        'a0000000-0000-4000-8000-000000000001',
        'project_summary',
        'Org Mismatch Task',
        'queued',
        1
    );
    RAISE EXCEPTION '[FAIL] Inserting task with mismatched project organization succeeded!';
EXCEPTION
    WHEN foreign_key_violation THEN
        RAISE NOTICE ' [PASS] Parent-child organization mismatch (task -> project) blocked by composite FK';
END $$;

-- Attempt attaching Step in Org Beta to Task in Org Alpha
DO $$
BEGIN
    INSERT INTO public.agent_task_steps (
        task_id, organization_id, step_key, step_type, position, status, attempt_count, max_attempts
    ) VALUES (
        'a3333333-0000-4000-8000-000000000001', -- Task from Org Alpha
        'b1111111-0000-4000-8000-000000000001', -- Step claimed in Org Beta
        'evil_step',
        'inspect_project_meta',
        99,
        'ready',
        0,
        3
    );
    RAISE EXCEPTION '[FAIL] Inserting step with mismatched task organization succeeded!';
EXCEPTION
    WHEN foreign_key_violation THEN
        RAISE NOTICE ' [PASS] Parent-child organization mismatch (step -> task) blocked by composite FK';
    WHEN insufficient_privilege THEN
        RAISE NOTICE ' [PASS] Parent-child organization mismatch (step -> task) blocked by RLS';
END $$;
ROLLBACK;

-- -------------------------------------------------------------------------
-- TEST 6: Viewer Role Restrictions on Tasks and Steps
-- -------------------------------------------------------------------------
BEGIN;
SELECT set_config('app.user_id', 'a0000000-0000-4000-8000-000000000002', true); -- User A2 is Viewer

-- Viewer attempts to insert task
DO $$
BEGIN
    INSERT INTO public.agent_tasks (
        organization_id, created_by, task_type, title, status, version
    ) VALUES (
        'a1111111-0000-4000-8000-000000000001',
        'a0000000-0000-4000-8000-000000000002',
        'project_summary',
        'Viewer Task',
        'queued',
        1
    );
    RAISE EXCEPTION '[FAIL] Viewer INSERT into agent_tasks succeeded!';
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE ' [PASS] Viewer INSERT on agent_tasks denied by RLS';
END $$;

-- Viewer attempts to update task status
DO $$
DECLARE
    affected integer;
BEGIN
    UPDATE public.agent_tasks
    SET status = 'cancelled'
    WHERE id = 'a3333333-0000-4000-8000-000000000001';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN
        RAISE EXCEPTION '[FAIL] Viewer UPDATE on agent_tasks affected % rows!', affected;
    END IF;
    RAISE NOTICE ' [PASS] Viewer UPDATE on agent_tasks affected 0 rows';
END $$;
ROLLBACK;

-- -------------------------------------------------------------------------
-- TEST 7: Event Actor Forgery Attack (Adversarial Investigation)
-- Can moducraft_runtime insert an arbitrary actor_user_id into agent_task_events?
-- -------------------------------------------------------------------------
BEGIN;
SELECT set_config('app.user_id', 'a0000000-0000-4000-8000-000000000001', true); -- Authenticated as User A1

DO $$
BEGIN
    INSERT INTO public.agent_task_events (
        task_id, organization_id, step_id, event_type, actor_user_id, metadata
    ) VALUES (
        'a3333333-0000-4000-8000-000000000001',
        'a1111111-0000-4000-8000-000000000001',
        'a4444444-0000-4000-8000-000000000001',
        'forged.actor.event',
        'b0000000-0000-4000-8000-000000000001', -- Impersonating User B1!
        '{"spoofed": true}'::jsonb
    );
    RAISE NOTICE ' [FINDING-VERIFIED] Event actor forgery: moducraft_runtime was able to insert actor_user_id = User B1 without check!';
END $$;
ROLLBACK;

-- -------------------------------------------------------------------------
-- TEST 8: Direct Status and Step Result Modification as Member
-- Can a compromised SQL session as moducraft_runtime arbitrarily change status/results?
-- -------------------------------------------------------------------------
BEGIN;
SELECT set_config('app.user_id', 'a0000000-0000-4000-8000-000000000001', true);

DO $$
BEGIN
    UPDATE public.agent_tasks
    SET status = 'succeeded'
    WHERE id = 'a3333333-0000-4000-8000-000000000001';

    UPDATE public.agent_task_steps
    SET status = 'succeeded', attempt_count = 0
    WHERE id = 'a4444444-0000-4000-8000-000000000001';

    RAISE NOTICE ' [FINDING-VERIFIED] moducraft_runtime has SQL column grant to update status/attempt_count directly (mitigated by API validation layer, but present in DB grants)';
END $$;
ROLLBACK;

DO $$
BEGIN
    RAISE NOTICE '=== ALL ADVERSARIAL SQL CHECKS COMPLETED ON DISPOSABLE DB ===';
END $$;
