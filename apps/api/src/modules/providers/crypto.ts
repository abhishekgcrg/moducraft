import crypto from "node:crypto";
import { ConfigurationError, ValidationError } from "../../errors/app-errors.js";

const ALGORITHM = "aes-256-gcm";
const KEY_VERSION = "v1";
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const TAG_LENGTH = 16; // 128-bit auth tag

/**
 * Derives or validates a 32-byte (256-bit) encryption key from the environment.
 * Accepts 64-char hex string, base64 string, or raw 32-byte string.
 */
export function getMasterEncryptionKey(providedKey?: string): Buffer {
  const rawKey = providedKey ?? process.env.PROVIDER_ENCRYPTION_KEY;
  if (!rawKey || rawKey.trim().length === 0) {
    throw new ConfigurationError(
      "PROVIDER_ENCRYPTION_KEY is not configured. Secret storage fails closed."
    );
  }

  const trimmed = rawKey.trim();

  // 1. Check 64-character hex encoding (32 bytes)
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  // 2. Check base64 encoding
  try {
    const b64Buf = Buffer.from(trimmed, "base64");
    if (b64Buf.length === 32) {
      return b64Buf;
    }
  } catch {
    // Fall through to error
  }

  // 3. Check direct 32-byte UTF-8 string
  const utf8Buf = Buffer.from(trimmed, "utf8");
  if (utf8Buf.length === 32) {
    return utf8Buf;
  }

  throw new ConfigurationError(
    "PROVIDER_ENCRYPTION_KEY must be exactly 32 bytes (256 bits), encoded as 64 hex characters, base64, or 32 raw bytes."
  );
}

/**
 * Encrypts a sensitive string (e.g. API key) using AES-256-GCM.
 * Tenant ID (organizationId) is bound as Additional Authenticated Data (AAD)
 * to cryptographically prevent cross-tenant ciphertext transplanting attacks.
 *
 * Output format: `v1:<iv_hex>:<tag_hex>:<ciphertext_hex>`
 */
export function encryptSecret(
  plaintext: string,
  tenantAad: string,
  masterKey?: Buffer
): string {
  if (!plaintext || plaintext.trim().length === 0) {
    throw new ValidationError("Plaintext secret cannot be empty.");
  }
  if (!tenantAad || tenantAad.trim().length === 0) {
    throw new ValidationError("Tenant AAD context is required for secret encryption.");
  }

  const key = masterKey ?? getMasterEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_LENGTH,
  });

  cipher.setAAD(Buffer.from(tenantAad, "utf8"));

  let ciphertext = cipher.update(plaintext, "utf8", "hex");
  ciphertext += cipher.final("hex");
  const authTag = cipher.getAuthTag();

  return `${KEY_VERSION}:${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext}`;
}

/**
 * Decrypts an encrypted secret and validates integrity and tenant AAD.
 * Throws ValidationError if the ciphertext has been tampered with or used under a different tenant.
 */
export function decryptSecret(
  encryptedString: string,
  tenantAad: string,
  masterKey?: Buffer
): string {
  if (!encryptedString || !encryptedString.startsWith(`${KEY_VERSION}:`)) {
    throw new ValidationError("Malformed or unsupported secret encryption format.");
  }
  if (!tenantAad || tenantAad.trim().length === 0) {
    throw new ValidationError("Tenant AAD context is required for secret decryption.");
  }

  const parts = encryptedString.split(":");
  if (parts.length !== 4) {
    throw new ValidationError("Invalid encrypted secret structure.");
  }

  const [, ivHex, tagHex, ciphertextHex] = parts;
  const key = masterKey ?? getMasterEncryptionKey();
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(tagHex, "hex");

  if (iv.length !== IV_LENGTH || authTag.length !== TAG_LENGTH) {
    throw new ValidationError("Corrupt IV or authentication tag in encrypted secret.");
  }

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: TAG_LENGTH,
    });

    decipher.setAAD(Buffer.from(tenantAad, "utf8"));
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertextHex, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (err: any) {
    throw new ValidationError(
      "Secret decryption failed: Authentication tag mismatch or corrupted ciphertext."
    );
  }
}

/**
 * Safely extracts non-sensitive prefix/suffix and masks the secret.
 * Never stores or leaks the full secret.
 */
export function maskApiKey(apiKey: string): {
  prefix: string;
  suffix: string;
  masked: string;
} {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 8) {
    return {
      prefix: trimmed.slice(0, 2),
      suffix: trimmed.slice(-2),
      masked: "••••••••",
    };
  }

  const prefix = trimmed.slice(0, 4);
  const suffix = trimmed.slice(-4);
  const masked = `${prefix}••••••••${suffix}`;

  return { prefix, suffix, masked };
}
