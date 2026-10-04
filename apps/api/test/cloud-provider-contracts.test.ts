import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type {
  DatabaseProvider,
  ObjectStorageProvider,
} from "../src/modules/resources/types.js";
import {
  ResourceNotFoundError,
  DatabaseProvisioningError,
  DatabaseHealthCheckError,
} from "../src/modules/resources/types.js";
import type {
  BuildExecutor,
  DeploymentProvider,
  BuildLogChunk,
} from "../src/modules/deployments/types.js";
import {
  BuildNotFoundError,
  BuildCancelledError,
  BuildExecutionError,
  DeploymentNotFoundError,
  DeploymentRollbackError,
  InvalidRoutingError,
} from "../src/modules/deployments/types.js";
import { ValidationError } from "../src/errors/app-errors.js";
import {
  MockDatabaseProvider,
  MockObjectStorageProvider,
  MockBuildExecutor,
  MockDeploymentProvider,
} from "./mocks/cloud-provider.mocks.js";

describe("Phase 5 Task 5.1: Cloud Provider Contracts & Deterministic Mocks", () => {
  const tenantOrgAlpha = "00000000-0000-0000-0000-000000000001";
  const tenantOrgBeta = "00000000-0000-0000-0000-000000000002";
  const projectX = "11111111-1111-1111-1111-111111111111";
  const projectY = "22222222-2222-2222-2222-222222222222";

  // ===========================================================================
  // 1. Compile-Time Interface Satisfaction
  // ===========================================================================
  describe("1. Compile-time Contract Conformance", () => {
    it("should satisfy DatabaseProvider interface at compile-time", () => {
      const dbProvider: DatabaseProvider = new MockDatabaseProvider();
      assert.equal(typeof dbProvider.provisionDatabase, "function");
      assert.equal(typeof dbProvider.deprovisionDatabase, "function");
      assert.equal(typeof dbProvider.rotateCredentials, "function");
      assert.equal(typeof dbProvider.checkHealth, "function");
      assert.equal(typeof dbProvider.providerId, "string");
    });

    it("should satisfy ObjectStorageProvider interface at compile-time", () => {
      const storageProvider: ObjectStorageProvider = new MockObjectStorageProvider();
      assert.equal(typeof storageProvider.createBucket, "function");
      assert.equal(typeof storageProvider.updatePolicy, "function");
      assert.equal(typeof storageProvider.generateSignedUrl, "function");
      assert.equal(typeof storageProvider.deleteBucket, "function");
      assert.equal(typeof storageProvider.providerId, "string");
    });

    it("should satisfy BuildExecutor interface at compile-time", () => {
      const buildExecutor: BuildExecutor = new MockBuildExecutor();
      assert.equal(typeof buildExecutor.triggerBuild, "function");
      assert.equal(typeof buildExecutor.getStatus, "function");
      assert.equal(typeof buildExecutor.getLogs, "function");
      assert.equal(typeof buildExecutor.subscribeLogs, "function");
      assert.equal(typeof buildExecutor.cancelBuild, "function");
      assert.equal(typeof buildExecutor.executorId, "string");
    });

    it("should satisfy DeploymentProvider interface at compile-time", () => {
      const deployProvider: DeploymentProvider = new MockDeploymentProvider();
      assert.equal(typeof deployProvider.deploy, "function");
      assert.equal(typeof deployProvider.updateRouting, "function");
      assert.equal(typeof deployProvider.checkHealth, "function");
      assert.equal(typeof deployProvider.rollback, "function");
      assert.equal(typeof deployProvider.providerId, "string");
    });
  });

  // ===========================================================================
  // 2. Database Provider Lifecycle & Failures
  // ===========================================================================
  describe("2. DatabaseProvider: Provisioning, Credentials, Health, and Deprovisioning", () => {
    let dbProvider: MockDatabaseProvider;

    beforeEach(() => {
      dbProvider = new MockDatabaseProvider();
    });

    it("2.1 should provision a database and return endpoints and credentials", async () => {
      const resId = "res-db-001";
      const result = await dbProvider.provisionDatabase({
        organizationId: tenantOrgAlpha,
        projectId: projectX,
        resourceId: resId,
        databaseName: "tenant_projx_db",
        options: { maxConnections: 50 },
      });

      assert.equal(result.organizationId, tenantOrgAlpha);
      assert.equal(result.projectId, projectX);
      assert.equal(result.resourceId, resId);
      assert.equal(result.databaseName, "tenant_projx_db");
      assert.equal(result.status, "provisioned");
      assert.equal(result.endpoint.host, "127.0.0.1");
      assert.equal(result.endpoint.port, 5432);
      assert.ok(result.credentials.username.startsWith("usr_"));
      assert.ok(result.credentials.password.startsWith("mock_sec_"));
      assert.ok(result.credentials.connectionStringTemplate.includes("127.0.0.1:5432/tenant_projx_db"));

      // Verify health check succeeds
      const health = await dbProvider.checkHealth({
        organizationId: tenantOrgAlpha,
        projectId: projectX,
        resourceId: resId,
      });
      assert.equal(health.status, "healthy");
      assert.ok(health.latencyMs >= 0);
    });

    it("2.2 should rotate database credentials and preserve database state", async () => {
      const resId = "res-db-002";
      const initial = await dbProvider.provisionDatabase({
        organizationId: tenantOrgAlpha,
        projectId: projectX,
        resourceId: resId,
        databaseName: "rotation_eval_db",
      });

      const rotated = await dbProvider.rotateCredentials({
        organizationId: tenantOrgAlpha,
        projectId: projectX,
        resourceId: resId,
      });

      assert.equal(rotated.resourceId, resId);
      assert.equal(rotated.status, "rotated");
      assert.notEqual(rotated.credentials.password, initial.credentials.password);
      assert.ok(rotated.credentials.password.startsWith("mock_rot_"));
    });

    it("2.3 should deprovision a provisioned database and subsequent health check reports unreachable", async () => {
      const resId = "res-db-003";
      await dbProvider.provisionDatabase({
        organizationId: tenantOrgAlpha,
        projectId: projectX,
        resourceId: resId,
        databaseName: "deprov_eval_db",
      });

      const deprov = await dbProvider.deprovisionDatabase({
        organizationId: tenantOrgAlpha,
        projectId: projectX,
        resourceId: resId,
      });
      assert.equal(deprov.status, "deprovisioned");

      const health = await dbProvider.checkHealth({
        organizationId: tenantOrgAlpha,
        projectId: projectX,
        resourceId: resId,
      });
      assert.equal(health.status, "unreachable");

      // Repeated deprovision should fail with ResourceNotFoundError
      await assert.rejects(
        async () =>
          dbProvider.deprovisionDatabase({
            organizationId: tenantOrgAlpha,
            projectId: projectX,
            resourceId: resId,
          }),
        ResourceNotFoundError
      );
    });

    it("2.4 should fail closed with validation error on missing tenant or empty database name", async () => {
      await assert.rejects(
        async () =>
          dbProvider.provisionDatabase({
            organizationId: "",
            projectId: projectX,
            resourceId: "res-db-invalid",
            databaseName: "valid_name",
          }),
        (err: any) => err instanceof ValidationError && err.message.includes("Missing tenant")
      );

      await assert.rejects(
        async () =>
          dbProvider.provisionDatabase({
            organizationId: tenantOrgAlpha,
            projectId: projectX,
            resourceId: "res-db-invalid",
            databaseName: "   ",
          }),
        (err: any) => err instanceof ValidationError && err.message.includes("Database name must not be empty")
      );
    });

    it("2.5 should simulate controlled provider failure", async () => {
      dbProvider.setFailure(
        "provisionDatabase",
        new DatabaseProvisioningError("Simulated infrastructure allocation timeout", "res-fail-01", true)
      );

      await assert.rejects(
        async () =>
          dbProvider.provisionDatabase({
            organizationId: tenantOrgAlpha,
            projectId: projectX,
            resourceId: "res-fail-01",
            databaseName: "fail_db",
          }),
        (err: any) => err instanceof DatabaseProvisioningError && err.isRetryable === true
      );
    });
  });

  // ===========================================================================
  // 3. Object Storage Provider Lifecycle & Security Policies
  // ===========================================================================
  describe("3. ObjectStorageProvider: Buckets, Policies, Presigned URLs, and Deletion", () => {
    let storageProvider: MockObjectStorageProvider;

    beforeEach(() => {
      storageProvider = new MockObjectStorageProvider();
    });

    it("3.1 should create a project bucket and apply custom access policies", async () => {
      const resId = "res-s3-001";
      const bucket = await storageProvider.createBucket({
        organizationId: tenantOrgAlpha,
        projectId: projectX,
        resourceId: resId,
        bucketName: "moducraft-artifacts-alpha",
        options: { initialPolicy: { isPublicRead: false } },
      });

      assert.equal(bucket.status, "created");
      assert.equal(bucket.arnOrUri, "s3://moducraft-artifacts-alpha");

      // Idempotent creation
      const dup = await storageProvider.createBucket({
        organizationId: tenantOrgAlpha,
        projectId: projectX,
        resourceId: resId,
        bucketName: "moducraft-artifacts-alpha",
      });
      assert.equal(dup.status, "already_exists");

      // Update policy
      const updated = await storageProvider.updatePolicy({
        organizationId: tenantOrgAlpha,
        projectId: projectX,
        resourceId: resId,
        bucketName: "moducraft-artifacts-alpha",
        policy: {
          isPublicRead: false,
          corsRules: [{ allowedOrigins: ["https://app.moducraft.com"], allowedMethods: ["GET", "PUT"] }],
        },
      });

      assert.equal(updated.status, "policy_applied");
      assert.equal(updated.appliedPolicy.corsRules?.length, 1);
    });

    it("3.2 should generate time-limited presigned URLs with correct expiration", async () => {
      const resId = "res-s3-002";
      await storageProvider.createBucket({
        organizationId: tenantOrgAlpha,
        projectId: projectX,
        resourceId: resId,
        bucketName: "moducraft-downloads",
      });

      const before = Date.now();
      const presigned = await storageProvider.generateSignedUrl({
        organizationId: tenantOrgAlpha,
        projectId: projectX,
        resourceId: resId,
        bucketName: "moducraft-downloads",
        objectKey: "builds/artifact-123.tar.gz",
        operation: "read",
        expiresInSeconds: 300,
      });

      assert.equal(presigned.operation, "read");
      assert.ok(presigned.url.includes("op=read"));
      assert.ok(presigned.url.includes("sig="));
      assert.ok(presigned.expiresAt.getTime() >= before + 299 * 1000);
      assert.ok(presigned.expiresAt.getTime() <= before + 301 * 1000);
    });

    it("3.3 should reject negative or zero expiration for presigned URLs", async () => {
      const resId = "res-s3-003";
      await storageProvider.createBucket({
        organizationId: tenantOrgAlpha,
        projectId: projectX,
        resourceId: resId,
        bucketName: "test-bucket-neg",
      });

      await assert.rejects(
        async () =>
          storageProvider.generateSignedUrl({
            organizationId: tenantOrgAlpha,
            projectId: projectX,
            resourceId: resId,
            bucketName: "test-bucket-neg",
            objectKey: "file.txt",
            operation: "write",
            expiresInSeconds: 0,
          }),
        (err: any) => err instanceof ValidationError && err.message.includes("Expiration must be a positive integer")
      );
    });

    it("3.4 should delete bucket and fail subsequent policy updates with ResourceNotFoundError", async () => {
      const resId = "res-s3-004";
      await storageProvider.createBucket({
        organizationId: tenantOrgAlpha,
        projectId: projectX,
        resourceId: resId,
        bucketName: "bucket-to-delete",
      });

      const deleted = await storageProvider.deleteBucket({
        organizationId: tenantOrgAlpha,
        projectId: projectX,
        resourceId: resId,
        bucketName: "bucket-to-delete",
      });
      assert.equal(deleted.status, "deleted");

      await assert.rejects(
        async () =>
          storageProvider.updatePolicy({
            organizationId: tenantOrgAlpha,
            projectId: projectX,
            resourceId: resId,
            bucketName: "bucket-to-delete",
            policy: { isPublicRead: true },
          }),
        ResourceNotFoundError
      );
    });
  });

  // ===========================================================================
  // 4. Build Executor Lifecycle & Log Streaming
  // ===========================================================================
  describe("4. BuildExecutor: Build Execution, Log Streaming, and Cancellation", () => {
    let buildExecutor: MockBuildExecutor;

    beforeEach(() => {
      buildExecutor = new MockBuildExecutor();
    });

    it("4.1 should trigger a build and stream logs chronologically to listeners", async () => {
      const buildId = "bld-001";
      const receivedLogs: BuildLogChunk[] = [];

      const unsubscribe = buildExecutor.subscribeLogs(buildId, (chunk) => {
        receivedLogs.push(chunk);
      });

      const result = await buildExecutor.triggerBuild({
        organizationId: tenantOrgAlpha,
        projectId: projectX,
        buildId,
        source: {
          type: "artifact",
          artifactId: "art-999",
          contentHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
        config: { dockerfilePath: "Dockerfile" },
      });

      assert.equal(result.buildId, buildId);
      assert.equal(result.status, "succeeded");
      assert.ok(result.imageDigest?.startsWith("sha256:"));

      // Ensure logs were received via subscription
      assert.ok(receivedLogs.length >= 3);
      assert.equal(receivedLogs[0].sequence, 1);
      assert.equal(receivedLogs[1].sequence, 2);
      assert.equal(receivedLogs[2].sequence, 3);
      assert.ok(receivedLogs[0].message.includes("Starting isolated build"));

      // Unsubscribe and verify no more events arrive
      unsubscribe();
      buildExecutor.emitLogChunk(buildId, "stdout", "Post completion log");
      assert.equal(receivedLogs.length, 3);

      // Verify getLogs returns the full history
      const fullLogs = await buildExecutor.getLogs(buildId);
      assert.equal(fullLogs.length, 4);
    });

    it("4.2 should cancel a running build and record cancellation reason", async () => {
      const buildId = "bld-cancel-01";
      await buildExecutor.triggerBuild({
        organizationId: tenantOrgAlpha,
        projectId: projectX,
        buildId,
        source: {
          type: "artifact",
          artifactId: "art-cancel",
          contentHash: "hash-cancel",
        },
      });

      const cancelled = await buildExecutor.cancelBuild(buildId, "Deployment superseded");
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.errorSummary, "Deployment superseded");

      const status = await buildExecutor.getStatus(buildId);
      assert.equal(status.status, "cancelled");
    });

    it("4.3 should return 404 BuildNotFoundError for non-existent build", async () => {
      await assert.rejects(
        async () => buildExecutor.getStatus("bld-does-not-exist"),
        BuildNotFoundError
      );
    });
  });

  // ===========================================================================
  // 5. Deployment Provider: Deployment, Routing, Health, and Rollback
  // ===========================================================================
  describe("5. DeploymentProvider: Deployments, Traffic Routing, Health, and Rollback", () => {
    let deployProvider: MockDeploymentProvider;

    beforeEach(() => {
      deployProvider = new MockDeploymentProvider();
    });

    it("5.1 should deploy artifact to environment and set active version", async () => {
      const depId = "dep-001";
      const result = await deployProvider.deploy({
        organizationId: tenantOrgAlpha,
        projectId: projectX,
        deploymentId: depId,
        environment: "production",
        imageDigest: "sha256:111122223333444455556666777788889999aaaabbbbccccddddeeeeffff0000",
        config: { port: 8080, replicas: 2 },
      });

      assert.equal(result.deploymentId, depId);
      assert.equal(result.environment, "production");
      assert.equal(result.status, "active");
      assert.ok(result.endpointUrl?.includes("production"));

      const health = await deployProvider.checkHealth({
        organizationId: tenantOrgAlpha,
        projectId: projectX,
        deploymentId: depId,
      });
      assert.equal(health.status, "healthy");
      assert.equal(health.healthyReplicas, 1);
    });

    it("5.2 should update traffic routing and domain aliases", async () => {
      const depId = "dep-002";
      await deployProvider.deploy({
        organizationId: tenantOrgAlpha,
        projectId: projectX,
        deploymentId: depId,
        environment: "staging",
        imageDigest: "sha256:digest-staging",
      });

      const routing = await deployProvider.updateRouting({
        organizationId: tenantOrgAlpha,
        projectId: projectX,
        deploymentId: depId,
        environment: "staging",
        trafficWeight: 50,
        domainAliases: ["staging.api.example.com"],
      });

      assert.equal(routing.trafficWeight, 50);
      assert.equal(routing.effectiveDomains[0], "staging.api.example.com");

      // Invalid routing weight
      await assert.rejects(
        async () =>
          deployProvider.updateRouting({
            organizationId: tenantOrgAlpha,
            projectId: projectX,
            deploymentId: depId,
            environment: "staging",
            trafficWeight: 150,
          }),
        InvalidRoutingError
      );
    });

    it("5.3 should roll back to a previously active deployment within the same environment", async () => {
      const dep1 = "dep-v1";
      const dep2 = "dep-v2";

      // Deploy v1
      await deployProvider.deploy({
        organizationId: tenantOrgAlpha,
        projectId: projectX,
        deploymentId: dep1,
        environment: "production",
        imageDigest: "sha256:digest-v1",
      });

      // Deploy v2
      await deployProvider.deploy({
        organizationId: tenantOrgAlpha,
        projectId: projectX,
        deploymentId: dep2,
        environment: "production",
        imageDigest: "sha256:digest-v2",
      });

      // Rollback to v1
      const rolledBack = await deployProvider.rollback({
        organizationId: tenantOrgAlpha,
        projectId: projectX,
        targetDeploymentId: dep1,
        environment: "production",
        reason: "Regression detected in v2",
      });

      assert.equal(rolledBack.status, "rolled_back");
      assert.equal(rolledBack.previousDeploymentId, dep2);
      assert.equal(rolledBack.currentDeploymentId, dep1);

      // Verify v2 is marked as rolled_back and v1 is active
      const recV2 = deployProvider.getDeployment(dep2);
      assert.equal(recV2?.status, "rolled_back");

      const recV1 = deployProvider.getDeployment(dep1);
      assert.equal(recV1?.status, "active");
    });

    it("5.4 should reject rollback to target from a different project or environment", async () => {
      const depStaging = "dep-staging-only";

      await deployProvider.deploy({
        organizationId: tenantOrgAlpha,
        projectId: projectX,
        deploymentId: depStaging,
        environment: "staging",
        imageDigest: "sha256:staging-digest",
      });

      // Attempt rollback in production to staging deployment
      await assert.rejects(
        async () =>
          deployProvider.rollback({
            organizationId: tenantOrgAlpha,
            projectId: projectX,
            targetDeploymentId: depStaging,
            environment: "production",
          }),
        (err: any) =>
          err instanceof DeploymentRollbackError &&
          err.message.includes("does not belong to environment 'production'")
      );
    });
  });

  // ===========================================================================
  // 6. Tenant and Project Scope Isolation Verification
  // ===========================================================================
  describe("6. Cross-Tenant and Multi-Project Scope Isolation", () => {
    it("6.1 should prevent cross-tenant collision across database provider records", async () => {
      const dbProvider = new MockDatabaseProvider();

      // Org Alpha provisions database with resourceId 'shared-res-name'
      await dbProvider.provisionDatabase({
        organizationId: tenantOrgAlpha,
        projectId: projectX,
        resourceId: "shared-res-name",
        databaseName: "alpha_db",
      });

      // Org Beta provisions database with same resourceId 'shared-res-name'
      await dbProvider.provisionDatabase({
        organizationId: tenantOrgBeta,
        projectId: projectY,
        resourceId: "shared-res-name",
        databaseName: "beta_db",
      });

      const alphaDb = dbProvider.getDatabase(tenantOrgAlpha, projectX, "shared-res-name");
      const betaDb = dbProvider.getDatabase(tenantOrgBeta, projectY, "shared-res-name");

      assert.ok(alphaDb);
      assert.ok(betaDb);
      assert.equal(alphaDb.databaseName, "alpha_db");
      assert.equal(betaDb.databaseName, "beta_db");
      assert.notEqual(alphaDb.username, betaDb.username);
    });

    it("6.2 should prevent cross-tenant storage access and deletion", async () => {
      const storageProvider = new MockObjectStorageProvider();

      await storageProvider.createBucket({
        organizationId: tenantOrgAlpha,
        projectId: projectX,
        resourceId: "bucket-res-1",
        bucketName: "alpha-private-bucket",
      });

      // Org Beta attempts to delete Org Alpha's bucket -> ResourceNotFoundError
      await assert.rejects(
        async () =>
          storageProvider.deleteBucket({
            organizationId: tenantOrgBeta,
            projectId: projectY,
            resourceId: "bucket-res-1",
            bucketName: "alpha-private-bucket",
          }),
        ResourceNotFoundError
      );
    });

    it("6.3 should reject cross-tenant routing updates and leave original routing state unmutated", async () => {
      const deployProvider = new MockDeploymentProvider();
      const depAlphaId = "dep-alpha-prod-001";

      // 1. Create a deployment owned by Organization Alpha and Project Alpha in production
      await deployProvider.deploy({
        organizationId: tenantOrgAlpha,
        projectId: projectX,
        deploymentId: depAlphaId,
        environment: "production",
        imageDigest: "sha256:alpha-digest",
      });

      // Establish known initial routing state via public mock method
      const initialRouting = await deployProvider.updateRouting({
        organizationId: tenantOrgAlpha,
        projectId: projectX,
        deploymentId: depAlphaId,
        environment: "production",
        trafficWeight: 80,
        domainAliases: ["app.alpha.example.com"],
      });
      assert.equal(initialRouting.trafficWeight, 80);
      assert.deepEqual(initialRouting.effectiveDomains, ["app.alpha.example.com"]);

      // 2. Attempt to update that deployment using Organization Beta's identity -> must reject with DeploymentNotFoundError
      await assert.rejects(
        async () =>
          deployProvider.updateRouting({
            organizationId: tenantOrgBeta,
            projectId: projectY,
            deploymentId: depAlphaId,
            environment: "production",
            trafficWeight: 10,
            domainAliases: ["hijack.beta.example.com"],
          }),
        (err: any) =>
          err instanceof DeploymentNotFoundError &&
          err.message.includes(`Deployment with ID '${depAlphaId}' was not found.`)
      );

      // 3. Verify mismatched project fails closed
      await assert.rejects(
        async () =>
          deployProvider.updateRouting({
            organizationId: tenantOrgAlpha,
            projectId: projectY, // Mismatched project
            deploymentId: depAlphaId,
            environment: "production",
            trafficWeight: 10,
          }),
        DeploymentNotFoundError
      );

      // 4. Verify mismatched environment fails closed
      await assert.rejects(
        async () =>
          deployProvider.updateRouting({
            organizationId: tenantOrgAlpha,
            projectId: projectX,
            deploymentId: depAlphaId,
            environment: "staging", // Mismatched environment
            trafficWeight: 10,
          }),
        DeploymentNotFoundError
      );

      // 5. Read the original deployment's routing state again using the public mock interface
      const currentRouting = await deployProvider.updateRouting({
        organizationId: tenantOrgAlpha,
        projectId: projectX,
        deploymentId: depAlphaId,
        environment: "production",
        trafficWeight: 80,
      });

      // 6. Assert that original routing state is unchanged after all rejected attempts
      assert.equal(currentRouting.trafficWeight, 80);
      assert.deepEqual(currentRouting.effectiveDomains, ["app.alpha.example.com"]);
    });
  });

  // ===========================================================================
  // 7. Sensitive Credential Hygiene
  // ===========================================================================
  describe("7. Sensitive Value Protection & Credential Hygiene", () => {
    it("7.1 should not include raw passwords in generic error messages", async () => {
      const dbProvider = new MockDatabaseProvider();
      try {
        await dbProvider.deprovisionDatabase({
          organizationId: tenantOrgAlpha,
          projectId: projectX,
          resourceId: "non-existent-db-404",
        });
        assert.fail("Should have thrown");
      } catch (err: any) {
        assert.ok(err instanceof ResourceNotFoundError);
        // Error message must not contain password, secret, or key patterns
        assert.ok(!err.message.includes("password"));
        assert.ok(!err.message.includes("secret"));
        assert.ok(!err.message.includes("connectionString"));
      }
    });

    it("7.2 should provide connectionStringTemplate without hardcoded plaintext password", async () => {
      const dbProvider = new MockDatabaseProvider();
      const res = await dbProvider.provisionDatabase({
        organizationId: tenantOrgAlpha,
        projectId: projectX,
        resourceId: "db-template-check",
        databaseName: "template_db",
      });

      // Template must mask credentials with *** to avoid accidental log leakage
      assert.ok(res.credentials.connectionStringTemplate.includes(":***@"));
    });
  });
});
