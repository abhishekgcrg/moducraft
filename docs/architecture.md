# ModuCraft Architecture — Initial Decision

## System shape
Begin with a modular monolith and a separately deployed web frontend. Extract services only when isolation, scaling, or operational needs justify the added complexity.

- `apps/web`: user-facing IDE and Cloud console
- `apps/api`: modular backend boundary; future modules include identity integration, organizations/tenants, projects, provider settings, agent workflows, resources, deployments, marketplace, audit events
- PostgreSQL: durable relational data and workflow state
- Object storage: behind an internal provider interface; select implementation only after version/license/security review
- Agent execution: isolated workers/sandboxes; never execute generated code inside the API process
- Background work: add a queue only after selecting workload and recovery semantics

## Provider interfaces
Keep internal interfaces owned by ModuCraft:
- `ModelProvider`
- `DatabaseProvider`
- `ObjectStorageProvider`
- `BuildExecutor`
- `DeploymentProvider`
- `IdentityProvider`

Do not leak vendor-specific types into domain models or public APIs.

## Data ownership
ModuCraft owns the canonical tenant, project, permission, workflow, provider-configuration, and deployment metadata model. Third-party engines are replaceable implementation details.

## Trust boundaries
Browser -> API -> database/provider adapters. Agent orchestrator -> isolated worker -> restricted tools. Secrets are never passed to model prompts unless specifically required and explicitly scoped. Production and destructive actions require explicit approval.
