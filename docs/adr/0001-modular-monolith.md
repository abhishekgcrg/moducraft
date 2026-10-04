# ADR 0001: Start with a Modular Monolith

- Status: Proposed
- Decision: Keep core domain modules in one backend deployable initially; keep web UI separate.
- Context: Early microservices add deployment, networking, tracing, and data-consistency costs before domain boundaries are proven.
- Consequences: Simpler local development and transactions; modules must have clear interfaces and must not reach into each other's internals. Extract a service only with evidence of scaling/isolation need.
- Revisit when: a module requires independent scaling, fault isolation, or release cadence that cannot be handled acceptably in the monolith.
