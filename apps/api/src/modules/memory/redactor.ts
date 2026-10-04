export interface RedactionResult {
  text: string;
  redactionsCount: number;
}

const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // 1. PEM Private Keys
  {
    pattern: /-----BEGIN[ A-Z0-9_-]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z0-9_-]*PRIVATE KEY-----/gi,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  // 2. JWTs (three dot-separated base64url strings starting with ey...)
  {
    pattern: /\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+\b/g,
    replacement: "[REDACTED_JWT_TOKEN]",
  },
  // 3. Common AI / Cloud API Keys (sk-..., ak-..., key-...)
  {
    pattern: /\b(?:sk|ak|ghp|gho|pat|xoxb|xoxp)-[a-zA-Z0-9_-]{16,}\b/g,
    replacement: "[REDACTED_API_KEY]",
  },
  // 4. Authorization Header Bearer tokens
  {
    pattern: /\bBearer\s+[a-zA-Z0-9._~+/-]{20,}=*\b/gi,
    replacement: "Bearer [REDACTED_TOKEN]",
  },
  // 5. Connection Strings & URLs with credentials (postgres, mysql, redis, mongodb, amqp, http, https)
  {
    pattern: /\b(?:https?|postgres(?:ql)?|mysql|mariadb|redis(?:s)?|mongodb(?:\+srv)?|amqp(?:s)?|kafka):\/\/[^:\s\/]+:[^@\s\/]+@[^\s"'>)]+/gi,
    replacement: "[REDACTED_CONNECTION_STRING]",
  },
  // 6. Explicit password/secret key-value assignments (supports JSON, YAML, config formats)
  {
    pattern: /(['"]?)\b(password|secret|api_?key|access_?token|auth_?token|bearer_?token)\1\s*[:=]\s*(['"]?)(?!\[REDACTED_)([^'"\s]{8,})\3/gi,
    replacement: "$1$2$1: $3[REDACTED_SECRET]$3",
  },
];

/**
 * Scans text and redacts credentials, private keys, tokens, and secrets.
 * Returns the sanitized string and the count of redactions performed.
 */
export function redactSensitiveData(input: string): RedactionResult {
  if (!input || typeof input !== "string") {
    return { text: input ?? "", redactionsCount: 0 };
  }

  let sanitized = input;
  let count = 0;

  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    const matches = sanitized.match(pattern);
    if (matches) {
      count += matches.length;
      sanitized = sanitized.replace(pattern, replacement);
    }
  }

  return { text: sanitized, redactionsCount: count };
}
