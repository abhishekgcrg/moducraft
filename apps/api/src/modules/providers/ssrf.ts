import dns from "node:dns/promises";
import net from "node:net";
import { ValidationError } from "../../errors/app-errors.js";

export type DnsLookupFn = (
  hostname: string,
  options: { all: boolean }
) => Promise<Array<{ address: string; family: number }>>;

export interface UrlValidationOptions {
  allowLocalMock?: boolean;
  dnsLookup?: DnsLookupFn;
}

/**
 * Checks whether an IPv4 address is in a private, loopback, link-local, or reserved range.
 */
function isPrivateOrReservedIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true; // Malformed IP is considered unsafe
  }

  const [a, b] = parts;

  // 0.0.0.0/8 (Current network)
  if (a === 0) return true;

  // 10.0.0.0/8 (Private)
  if (a === 10) return true;

  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;

  // 169.254.0.0/16 (Link-local & Cloud Metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;

  // 172.16.0.0/12 (Private)
  if (a === 172 && b >= 16 && b <= 31) return true;

  // 192.168.0.0/16 (Private)
  if (a === 192 && b === 168) return true;

  // 100.64.0.0/10 (Shared address space / Carrier-grade NAT)
  if (a === 100 && b >= 64 && b <= 127) return true;

  // 224.0.0.0/4 (Multicast)
  if (a >= 224 && a <= 239) return true;

  // 240.0.0.0/4 (Reserved)
  if (a >= 240) return true;

  // 255.255.255.255 (Broadcast)
  if (parts.every((p) => p === 255)) return true;

  return false;
}

/**
 * Checks whether an IPv6 address is loopback, unique local, link-local, or IPv4-mapped private.
 */
function isPrivateOrReservedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();

  // ::1 / :: (Loopback / Unspecified)
  if (normalized === "::1" || normalized === "::") return true;

  // fc00::/7 (Unique local)
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;

  // fe80::/10 (Link-local)
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;

  // IPv4-mapped IPv6 (::ffff:x.x.x.x)
  if (normalized.startsWith("::ffff:")) {
    const ipv4Part = normalized.slice(7);
    if (net.isIPv4(ipv4Part)) {
      return isPrivateOrReservedIPv4(ipv4Part);
    }
  }

  return false;
}

/**
 * Validates a base URL against SSRF and unsafe network targets.
 * Resolves DNS to prevent DNS-rebinding attacks to private IPs.
 */
export async function validateProviderBaseUrl(
  rawUrl: string,
  options: UrlValidationOptions = {}
): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new ValidationError("Invalid provider base URL format.");
  }

  const isLocalMockAllowed = options.allowLocalMock ?? false;

  // Protocol validation: HTTPS mandatory in non-test, or HTTP if local mock allowed
  if (parsed.protocol !== "https:") {
    if (
      parsed.protocol === "http:" &&
      isLocalMockAllowed &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
    ) {
      // Allowed for local test mocks only
    } else {
      throw new ValidationError(
        "Provider base URL must use HTTPS. Insecure HTTP is prohibited."
      );
    }
  }

  // Deny credentials in URL
  if (parsed.username || parsed.password) {
    throw new ValidationError("Provider base URL must not contain embedded credentials.");
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block obvious metadata domains
  if (
    hostname === "metadata.google.internal" ||
    hostname === "instance-data" ||
    hostname === "metadata" ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".local")
  ) {
    if (!isLocalMockAllowed || (hostname !== "localhost" && hostname !== "127.0.0.1")) {
      throw new ValidationError(
        `Destination '${hostname}' is an internal or reserved network target and cannot be used.`
      );
    }
  }

  function getNormalizedUrl(): string {
    return `${parsed.origin}${parsed.pathname === "/" ? "" : parsed.pathname}`.replace(/\/+$/, "");
  }

  // Check if hostname is direct IP literal
  if (net.isIP(hostname)) {
    if (isLocalMockAllowed && (hostname === "127.0.0.1" || hostname === "::1")) {
      return getNormalizedUrl();
    }
    if (net.isIPv4(hostname) && isPrivateOrReservedIPv4(hostname)) {
      throw new ValidationError(`Provider base URL points to a private or reserved IPv4 address.`);
    }
    if (net.isIPv6(hostname) && isPrivateOrReservedIPv6(hostname)) {
      throw new ValidationError(`Provider base URL points to a private or reserved IPv6 address.`);
    }
    return getNormalizedUrl();
  }

  // If test environment is allowed, permit localhost and RFC 2606 test domains (.test, .example)
  if (
    isLocalMockAllowed &&
    (hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname.endsWith(".test") ||
      hostname.endsWith(".example"))
  ) {
    return getNormalizedUrl();
  }

  // Resolve hostname through DNS to prevent DNS rebinding to private IPs
  try {
    const lookupFn = options.dnsLookup ?? ((h) => dns.lookup(h, { all: true }));
    const lookupResults = await lookupFn(hostname, { all: true });
    for (const record of lookupResults) {
      if (record.family === 4 && isPrivateOrReservedIPv4(record.address)) {
        throw new ValidationError(
          `Provider host '${hostname}' resolved to private or reserved IP address (${record.address}). Request blocked for SSRF protection.`
        );
      }
      if (record.family === 6 && isPrivateOrReservedIPv6(record.address)) {
        throw new ValidationError(
          `Provider host '${hostname}' resolved to private or reserved IPv6 address (${record.address}). Request blocked for SSRF protection.`
        );
      }
    }
  } catch (err: any) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError(
      `Failed to resolve provider hostname '${hostname}' via DNS: ${err.message}`
    );
  }

  return getNormalizedUrl();
}
