-- Smoke test for a disposable local database; fixture rows are rolled back.
BEGIN;
INSERT INTO app_users(id, identity_issuer, identity_subject, email, display_name) VALUES
 ('10000000-0000-4000-8000-000000000001','https://identity.example.test','subject-a','a@example.test','User A'),
 ('10000000-0000-4000-8000-000000000002','https://identity.example.test','subject-b','b@example.test','User B');
INSERT INTO organizations(id,name,slug,created_by) VALUES
 ('20000000-0000-4000-8000-000000000001','Org A','org-a-test','10000000-0000-4000-8000-000000000001'),
 ('20000000-0000-4000-8000-000000000002','Org B','org-b-test','10000000-0000-4000-8000-000000000002');
INSERT INTO organization_memberships(organization_id,user_id,role) VALUES
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','owner'),
 ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','owner');
INSERT INTO projects(id,organization_id,name,slug,created_by) VALUES
 ('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','Project A','project-a','10000000-0000-4000-8000-000000000001'),
 ('30000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','Project B','project-b','10000000-0000-4000-8000-000000000002');
SET LOCAL ROLE moducraft_runtime;
SELECT set_config('app.user_id','10000000-0000-4000-8000-000000000001',true);
-- Expected with an RLS-enforced, non-owner role: only Org A and Project A.
SELECT id,name FROM organizations ORDER BY slug;
SELECT id,name,organization_id FROM projects ORDER BY slug;

DO $$
DECLARE
    v_org_count int;
    v_proj_count int;
BEGIN
    SELECT count(*) INTO v_org_count FROM organizations;
    SELECT count(*) INTO v_proj_count FROM projects;
    IF v_org_count <> 1 THEN
        RAISE EXCEPTION 'Isolation smoke test failed: expected 1 organization, found %', v_org_count;
    END IF;
    IF v_proj_count <> 1 THEN
        RAISE EXCEPTION 'Isolation smoke test failed: expected 1 project, found %', v_proj_count;
    END IF;
    RAISE NOTICE 'Smoke test passed: Tenant A isolated successfully';
END $$;

ROLLBACK;
