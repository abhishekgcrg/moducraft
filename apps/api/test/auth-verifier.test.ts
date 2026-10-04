import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as jose from "jose";
import { JoseJwtVerifier } from "../src/auth/verifier.js";
import { AuthNotConfiguredError, InvalidTokenError } from "../src/auth/types.js";

describe("JoseJwtVerifier Unit & Boundary Tests", () => {
  const secretKey = "super-secret-key-that-is-at-least-32-characters-long!";
  const issuer = "https://identity.moducraft.test";
  const audience = "moducraft-api";

  it("should fail-closed when provider is unconfigured", async () => {
    const unconfiguredVerifier = new JoseJwtVerifier({});

    assert.equal(unconfiguredVerifier.isConfigured(), false);
    await assert.rejects(
      async () => {
        await unconfiguredVerifier.verifyToken("any.token.here");
      },
      (err: any) => {
        assert.ok(err instanceof AuthNotConfiguredError);
        assert.equal(err.code, "AUTH_NOT_CONFIGURED");
        return true;
      }
    );
  });

  it("should successfully verify a valid signed JWT and extract claims", async () => {
    const verifier = new JoseJwtVerifier({
      issuer,
      audience,
      secret: secretKey,
    });
    assert.equal(verifier.isConfigured(), true);

    const secretBytes = new TextEncoder().encode(secretKey);
    const validToken = await new jose.SignJWT({
      email: "engineer@moducraft.test",
      name: "Lead Engineer",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("user-subject-12345")
      .setExpirationTime("2h")
      .sign(secretBytes);

    const claims = await verifier.verifyToken(validToken);

    assert.equal(claims.issuer, issuer);
    assert.equal(claims.subject, "user-subject-12345");
    assert.equal(claims.email, "engineer@moducraft.test");
    assert.equal(claims.displayName, "Lead Engineer");
  });

  it("should reject token with tampered signature or payload", async () => {
    const verifier = new JoseJwtVerifier({
      issuer,
      audience,
      secret: secretKey,
    });

    const secretBytes = new TextEncoder().encode(secretKey);
    const validToken = await new jose.SignJWT({ email: "tampered@test.org" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("sub-original")
      .setExpirationTime("1h")
      .sign(secretBytes);

    // Tamper with the token string
    const parts = validToken.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ sub: "sub-hacked", iss: issuer, aud: audience })
    ).toString("base64url");
    const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

    await assert.rejects(
      async () => {
        await verifier.verifyToken(tamperedToken);
      },
      (err: any) => {
        assert.ok(err instanceof InvalidTokenError);
        assert.equal(err.code, "INVALID_TOKEN");
        return true;
      }
    );
  });

  it("should reject expired token", async () => {
    const verifier = new JoseJwtVerifier({
      issuer,
      audience,
      secret: secretKey,
    });

    const secretBytes = new TextEncoder().encode(secretKey);
    const expiredToken = await new jose.SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("sub-expired")
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600) // 1 hour ago
      .sign(secretBytes);

    await assert.rejects(
      async () => {
        await verifier.verifyToken(expiredToken);
      },
      (err: any) => {
        assert.ok(err instanceof InvalidTokenError);
        assert.match(err.message, /expired/i);
        return true;
      }
    );
  });

  it("should reject token with mismatched issuer", async () => {
    const verifier = new JoseJwtVerifier({
      issuer,
      audience,
      secret: secretKey,
    });

    const secretBytes = new TextEncoder().encode(secretKey);
    const wrongIssuerToken = await new jose.SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setIssuer("https://rogue-identity.attacker.test")
      .setAudience(audience)
      .setSubject("sub-victim")
      .setExpirationTime("1h")
      .sign(secretBytes);

    await assert.rejects(
      async () => {
        await verifier.verifyToken(wrongIssuerToken);
      },
      (err: any) => {
        assert.ok(err instanceof InvalidTokenError);
        assert.match(err.message, /iss/i);
        return true;
      }
    );
  });

  it("should reject token with mismatched audience", async () => {
    const verifier = new JoseJwtVerifier({
      issuer,
      audience,
      secret: secretKey,
    });

    const secretBytes = new TextEncoder().encode(secretKey);
    const wrongAudToken = await new jose.SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setIssuer(issuer)
      .setAudience("different-service-api")
      .setSubject("sub-victim")
      .setExpirationTime("1h")
      .sign(secretBytes);

    await assert.rejects(
      async () => {
        await verifier.verifyToken(wrongAudToken);
      },
      (err: any) => {
        assert.ok(err instanceof InvalidTokenError);
        assert.match(err.message, /aud/i);
        return true;
      }
    );
  });
});
