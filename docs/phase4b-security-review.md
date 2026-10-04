# ModuCraft Phase 4B: Security Review & Threat Model

## 1. Threat Modeling Overview

Phase 4B introduces storage of sensitive external third-party API credentials, outbound network dispatching, token consumption tracking, and human-in-the-loop task execution gates.

### Threat Matrix

| Threat ID | Threat Category | Description | Mitigating Control | Verification Status |
|-----------|-----------------|-------------|--------------------|---------------------|
| **T-4B-01** | Information Disclosure | Plaintext API keys exposed in database dumps or logs | Authenticated AES-256-GCM encryption with tenant AAD; secrets never logged or returned in DTOs. | **VERIFIED PASS** |
| **T-4B-02** | Cross-Tenant Ciphertext Reuse | Attacker copies ciphertext from Org A to Org B | Tenant UUID bound as AAD; GCM decryption fails integrity check under Org B context. | **VERIFIED PASS** |
| **T-4B-03** | Server-Side Request Forgery (SSRF) | Malicious provider base URL targets internal VPC/metadata services | Strict IP literal checking, protocol enforcement (HTTPS), and DNS pre-resolution blocking private IPs. | **VERIFIED PASS** |
| **T-4B-04** | DNS Rebinding | Attacker hostname resolves to public IP on check, private IP on request | DNS resolved pre-flight and socket validated against private/reserved address lists. | **VERIFIED PASS** |
| **T-4B-05** | Token Quota Exhaustion / Denial of Wallet | Concurrent requests bypass token budget checks | Pessimistic locking (`SELECT ... FOR UPDATE`) inside database transactions. | **VERIFIED PASS** |
| **T-4B-06** | Unauthorized Action Execution | Task performs sensitive actions without human oversight | Approval hooks (`waiting_for_approval`) require explicit owner/admin authorization via `approveTask`. | **VERIFIED PASS** |
| **T-4B-07** | Cross-Tenant Provider Referencing | Task in Org Alpha configures provider owned by Org Beta | Composite foreign key `(organization_id, provider_config_id)` enforced at schema level. | **VERIFIED PASS** |

---

## 2. Cryptographic Security Assessment

### 2.1 Encryption Implementation
- **Implementation:** `apps/api/src/modules/providers/crypto.ts`
- **Algorithm:** AES-256-GCM (`node:crypto` standard library).
- **IV Generation:** 12-byte cryptographically secure random bytes via `crypto.randomBytes(12)`.
- **Auth Tag:** 16-byte GCM authentication tag.
- **Master Key Source:** Environment variable `PROVIDER_ENCRYPTION_KEY` (256-bit hex/base64 string).
- **Validation:** Master key length is validated on every operation; fails closed if key is missing or malformed.

### 2.2 AAD Binding & Tamper Protection
- Encryption passes `tenantAad` (`organization_id`) into `cipher.setAAD()`.
- Decryption validates `tenantAad` using `decipher.setAAD()`.
- **Test Verification:** Cross-tenant decryption attempt throws `ValidationError: Decryption failed. Secret integrity check failed or tenant context mismatch.`

### 2.3 Secret Masking & Redaction
- Non-sensitive prefix and suffix extraction (`key_prefix`, `key_suffix`) retains at most 4 characters.
- Audit event metadata records sanitized summaries only: `{ name, providerType }` and `{ latencyMs, model }`. Plaintext keys and ciphertexts are never passed to `moducraft_record_audit_event`.

---

## 3. Network & SSRF Security Assessment

### 3.1 Defense-in-Depth Pipeline
1. **URI Parser:** Standard Node.js `URL` class parses input; malformed formats throw `ValidationError`.
2. **Protocol Check:** Only `https:` is permitted (except local mock domains in test environment).
3. **Credentials Check:** URLs containing `user:pass@` throw `ValidationError`.
4. **Static Hostname Blacklist:**
   - `metadata.google.internal`
   - `instance-data`
   - `metadata`
   - Domains ending in `.internal` or `.local`
5. **Direct IP Literal Evaluation:**
   - Blocks `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.168.0.0/16`, `224.0.0.0/4`, `240.0.0.0/4`, `255.255.255.255`.
   - Blocks IPv6 loopback (`::1`), unique local (`fc00::/7`), link-local (`fe80::/10`), IPv4-mapped IPv6 (`::ffff:x.x.x.x`).
6. **DNS Pre-Resolution:**
   - Hostnames are resolved through `dns.lookup(hostname, { all: true })`.
   - Every returned IPv4 and IPv6 record is checked against the reserved address ranges.

---

## 4. Database Privilege & Forced RLS Isolation

### 4.1 Schema Isolation
- Table `provider_configs` enforces Row-Level Security:
  ```sql
  ALTER TABLE provider_configs ENABLE ROW LEVEL SECURITY;
  ALTER TABLE provider_configs FORCE ROW LEVEL SECURITY;
  ```
- Table `provider_usage_records` enforces Row-Level Security:
  ```sql
  ALTER TABLE provider_usage_records ENABLE ROW LEVEL SECURITY;
  ALTER TABLE provider_usage_records FORCE ROW LEVEL SECURITY;
  ```

### 4.2 Composite Foreign Keys
- `provider_configs` has composite unique constraint `(organization_id, id)`.
- `agent_tasks` references `provider_configs`:
  ```sql
  FOREIGN KEY (organization_id, provider_config_id)
    REFERENCES provider_configs(organization_id, id) ON DELETE SET NULL;
  ```
- `provider_usage_records` references `provider_configs`:
  ```sql
  FOREIGN KEY (organization_id, provider_config_id)
    REFERENCES provider_configs(organization_id, id) ON DELETE CASCADE;
  ```
- **Security Impact:** Impossible for a task in Organization Alpha to reference a provider configuration in Organization Beta, even if an attacker attempts direct SQL injection under the runtime role.

### 4.3 Column Grant Restrictions for `moducraft_runtime`
- `provider_configs`:
  - `SELECT`: `(id, organization_id, provider_type, name, base_url, model_id, encrypted_api_key, key_prefix, key_suffix, is_enabled, token_budget_monthly, tokens_used_month, version, created_by, created_at, updated_at)`
  - `INSERT`: `(id, organization_id, provider_type, name, base_url, model_id, encrypted_api_key, key_prefix, key_suffix, is_enabled, token_budget_monthly, version, created_by)`
  - `UPDATE`: `(name, base_url, model_id, encrypted_api_key, key_prefix, key_suffix, is_enabled, token_budget_monthly, tokens_used_month, version, updated_at)`
  - `DELETE`: full table grant subject to RLS (owner/admin policy).
- `provider_usage_records`:
  - `SELECT`: all columns.
  - `INSERT`: `(id, organization_id, provider_config_id, task_id, step_id, model_id, prompt_tokens, completion_tokens, total_tokens, created_at)`.
  - `UPDATE`: **REVOKED / NO GRANT** (immutable ledger).
  - `DELETE`: **REVOKED / NO GRANT** (immutable ledger).

---

## 5. Automated Verification Results

All 21 integration tests in `apps/api/test/providers.test.ts` passed:
1. Cryptographic encryption/decryption with tenant AAD matching.
2. Cross-tenant AAD mismatch decryption rejection (GCM tamper detection).
3. Ciphertext and auth tag corruption rejection.
4. Fail-closed behavior on missing or invalid master encryption key.
5. Safe key masking without leaking secret bytes.
6. SSRF loopback blocking (`127.0.0.1`, `localhost`, `::1`).
7. SSRF private IP blocking (`10.x`, `172.16.x`, `192.168.x`).
8. SSRF cloud metadata blocking (`169.254.169.254`, `metadata.google.internal`).
9. Non-HTTPS protocol rejection and embedded userinfo credential denial.
10. Valid public HTTPS endpoint approval.
11. Provider configuration creation by organization owner with secret scrubbing.
12. Role-based access control denying organization viewers (HTTP 403).
13. Secret-free provider configuration listing by members under forced RLS.
14. Anti-enumeration and cross-tenant isolation (HTTP 404 for unauthorized orgs).
15. Key rotation and configuration updating.
16. Safe provider connection testing without leaking credentials.
17. Concurrency-safe budget enforcement and ledger accounting.
18. Budget exhaustion rejection (HTTP 429).
19. Cross-tenant provider config referencing prevention in agent tasks.
20. Approval requirement pausing task execution in `waiting_for_approval` state.
21. Provider config revocation and audit event secret-freedom verification.
