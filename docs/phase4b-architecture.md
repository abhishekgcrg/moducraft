# ModuCraft Phase 4B: AI Provider Abstraction Architecture

## 1. Executive Summary

Phase 4B introduces a secure, multi-tenant AI Provider Abstraction layer to ModuCraft. This layer decouples the Phase 4A AI Agent Orchestrator from specific LLM vendors while enforcing strict tenant boundary controls, cryptographic secrecy via authenticated AES-256-GCM encryption with tenant-specific Additional Authenticated Data (AAD), strict Server-Side Request Forgery (SSRF) defense-in-depth, concurrency-safe monthly token budgets, and human-in-the-loop task approval gates.

---

## 2. Architecture & Layering

```
+-----------------------------------------------------------------------------------+
|                           Client Layer (Web / IDE / CLI)                          |
+-----------------------------------------------------------------------------------+
                                       |
                                       v  (Bearer JWT / OIDC Auth Boundary)
+-----------------------------------------------------------------------------------+
|                        ModuCraft Fastify API (Modular Monolith)                   |
|                                                                                   |
|  [Provider Routes]                                    [Orchestrator Routes]       |
|  - POST   /api/v1/provider-configs                    - POST /agent-tasks         |
|  - GET    /api/v1/provider-configs                    - POST /agent-tasks/:id/run |
|  - GET    /api/v1/provider-configs/:id                - POST /agent-tasks/:id/appr|
|  - PATCH  /api/v1/provider-configs/:id                                            |
|  - DELETE /api/v1/provider-configs/:id                                            |
|  - POST   /api/v1/provider-configs/:id/test-connection                            |
+-----------------------------------------------------------------------------------+
                                       |
                   withAuthenticatedContext(pool, userId)
                                       v
+-----------------------------------------------------------------------------------+
|                     AI Provider Service & Security Subsystems                     |
|                                                                                   |
|   +-----------------------+   +----------------------+   +---------------------+  |
|   | Cryptographic Module  |   |    SSRF Protection   |   |   Usage & Budget    |  |
|   | - AES-256-GCM         |   | - HTTPS Enforcement  |   | - Atomic Row Lock   |  |
|   | - Tenant AAD Binding  |   | - Private IP Deny    |   | - Ledger Recording  |  |
|   | - Version 'v1'        |   | - Cloud Metadata Blk |   | - Fail Closed       |  |
|   | - Key Masking         |   | - DNS Pre-resolution |   |                     |  |
|   +-----------------------+   +----------------------+   +---------------------+  |
+-----------------------------------------------------------------------------------+
                                       |
                                       v
+-----------------------------------------------------------------------------------+
|                         AI Provider Adapter Interface                             |
|                                                                                   |
|   +------------------------------------+   +----------------------------------+   |
|   |        MockAIProviderAdapter       |   |     OpenAICompatibleAdapter      |   |
|   | - Deterministic test execution     |   | - Strictly SSRF-validated base   |   |
|   | - Zero outbound network calls      |   | - AbortSignal timeouts           |   |
|   | - Simulated token usage accounting |   | - Exponential backoff + retries  |   |
|   +------------------------------------+   +----------------------------------+   |
+-----------------------------------------------------------------------------------+
                                       |
                                       v  (Connection Pool via `moducraft_runtime`)
+-----------------------------------------------------------------------------------+
|                      PostgreSQL Storage Layer (Forced RLS)                        |
|                                                                                   |
|  - provider_configs (Tenant isolated, AES-256-GCM encrypted API keys)             |
|  - provider_usage_records (Append-only audit ledger of all consumed tokens)       |
|  - agent_tasks (Composite FK: organization_id, provider_config_id)                |
|  - agent_task_steps & agent_task_events                                           |
+-----------------------------------------------------------------------------------+
```

---

## 3. Cryptographic Design (AES-256-GCM + Tenant AAD)

Provider API keys and sensitive credentials are encrypted using authenticated symmetric encryption:

1. **Algorithm:** AES-256-GCM (`aes-256-gcm`).
2. **Master Key (`PROVIDER_ENCRYPTION_KEY`):**
   - 256 bits (32 bytes), represented as a 64-character hexadecimal string or 32-byte Base64.
   - Sourced exclusively from the process environment (`process.env.PROVIDER_ENCRYPTION_KEY`).
   - Never written to the database, migrations, log files, or git repositories.
   - Fails closed immediately if missing, invalid length, or corrupted.
3. **Initialization Vector (IV):**
   - 12 bytes generated cryptographically per encryption operation using `crypto.randomBytes(12)`.
   - Never reused across encryptions.
4. **Tenant AAD (Additional Authenticated Data):**
   - The owning `organization_id` UUID is bound as authenticated data: `cipher.setAAD(Buffer.from(tenantAad, "utf8"))`.
   - **Cross-Tenant Cryptographic Tamper Protection:** Even if ciphertext is copied or moved between rows, attempting to decrypt under a different organization's context fails GCM authentication verification and is rejected immediately.
5. **Stored Ciphertext Format:**
   `v1:<iv_hex>:<auth_tag_hex>:<ciphertext_hex>`
   - `KEY_VERSION = "v1"` supports zero-downtime key rotation in future upgrades.
6. **Masking (`maskApiKey`):**
   - Non-sensitive prefix (up to 4 characters) and suffix (last 4 characters) are stored in plaintext columns `key_prefix` and `key_suffix`.
   - For short keys (<= 8 chars), 2 prefix and 2 suffix chars are stored.
   - Plaintext keys are strictly ephemeral and never leave the memory of the specific execution step.

---

## 4. Server-Side Request Forgery (SSRF) Protection

When configuring external AI providers (OpenAI, Anthropic, vLLM, Ollama, self-hosted LLM gateways), callers supply a `base_url`. To protect internal infrastructure, the SSRF validator (`validateProviderBaseUrl`) executes multi-stage validation:

1. **Protocol Restriction:**
   - HTTPS is strictly mandatory (`https:`).
   - Insecure plain HTTP (`http:`) is rejected outright.
   - Arbitrary schemes (`file:`, `ftp:`, `gopher:`, etc.) are blocked.
2. **Credential Sanitization:**
   - URLs containing embedded user credentials (`https://user:pass@host/`) are rejected to prevent credential sniffing or proxy confusion.
3. **Reserved & Cloud Metadata Blocking:**
   - Destination hostnames matching cloud metadata endpoints (`169.254.169.254`, `metadata.google.internal`, `instance-data`, `.internal`, `.local`) are blocked before DNS lookup.
4. **RFC 1918 & Reserved IP Filtering:**
   - Direct IP literals and DNS-resolved addresses are checked against:
     - `127.0.0.0/8` (Loopback)
     - `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (Private networks)
     - `169.254.0.0/16` (Link-local / AWS / GCP / Azure metadata)
     - `100.64.0.0/10` (Carrier-grade NAT)
     - `0.0.0.0/8`, `224.0.0.0/4`, `240.0.0.0/4`, `255.255.255.255`
     - IPv6 equivalents: `::1`, `fc00::/7` (Unique local), `fe80::/10` (Link-local), `::ffff:x.x.x.x` (IPv4-mapped).
5. **DNS Rebinding Defense:**
   - Hostnames are resolved through Node's `dns.lookup` with `{ all: true }`.
   - If any resolved IP address belongs to a private or reserved block, the URL is rejected before any network socket is opened.

---

## 5. Token Budget Accounting & Concurrency Safety

1. **Monthly Token Budget:**
   - `provider_configs` stores `token_budget_monthly` and `tokens_used_month`.
   - Concurrency is managed via pessimistic row-level locking (`SELECT ... FOR UPDATE` inside `ScopedTransaction`).
   - If `tokens_used_month >= token_budget_monthly`, the execution fails closed with `ProviderBudgetExceededError` (HTTP 429).
2. **Append-Only Usage Ledger:**
   - Every completed AI generation step appends a row to `provider_usage_records`.
   - Recorded fields: `organization_id`, `provider_config_id`, `task_id`, `step_id`, `model_id`, `prompt_tokens`, `completion_tokens`, `total_tokens`, `created_at`.
   - Both `provider_configs` and `provider_usage_records` enforce tenant isolation via PostgreSQL Row-Level Security (RLS).
   - Foreign key is composite: `(organization_id, provider_config_id) REFERENCES provider_configs(organization_id, id) ON DELETE CASCADE`.

---

## 6. Orchestrator Integration & Human-in-the-Loop Approval

1. **Provider-Aware Agent Tasks:**
   - `agent_tasks` includes `provider_config_id` with composite FK `(organization_id, provider_config_id)` ensuring cross-tenant provider referencing is impossible at the database level.
   - When creating an agent task with `providerConfigId`, the API verifies the calling user is an authorized member (`owner`, `admin`, or `member`) of the owning organization.
2. **Task Step Execution:**
   - Task steps of type `ai_chat_completion` use `AIProviderService.executeChatCompletion`.
   - Deterministic mock provider is supported out-of-the-box for offline testing and development environments without incurring API costs.
3. **Approval Gates:**
   - If an agent task step contains `requiresApproval: true` (e.g. actions with significant financial, security, or external impact), the orchestrator transitions the step and task to `waiting_for_approval` and pauses execution.
   - Authorized organization owners or admins invoke `POST /api/v1/agent-tasks/:id/approve` to resume execution.
   - Approval records are stored in `result_data` under least-privilege SQL grants, recording `approvedBy` and `approvedAt`.
