import * as jose from "jose";
import {
  type AuthVerifier,
  type VerifiedClaims,
  AuthNotConfiguredError,
  InvalidTokenError,
} from "./types.js";

export interface JwtVerifierOptions {
  issuer?: string;
  audience?: string;
  jwksUri?: string;
  publicKey?: string;
  secret?: string;
}

export class JoseJwtVerifier implements AuthVerifier {
  private readonly issuer?: string;
  private readonly audience?: string;
  private keyOrJwks?: jose.JWTVerifyGetKey | Uint8Array;

  constructor(options: JwtVerifierOptions) {
    this.issuer = options.issuer;
    this.audience = options.audience;

    if (options.jwksUri) {
      this.keyOrJwks = jose.createRemoteJWKSet(new URL(options.jwksUri));
    } else if (options.secret) {
      this.keyOrJwks = new TextEncoder().encode(options.secret);
    }
  }

  public isConfigured(): boolean {
    return Boolean(this.issuer && this.keyOrJwks);
  }

  public async verifyToken(token: string): Promise<VerifiedClaims> {
    if (!this.isConfigured() || !this.keyOrJwks) {
      throw new AuthNotConfiguredError();
    }

    if (!token || typeof token !== "string") {
      throw new InvalidTokenError("Missing token string.");
    }

    try {
      const verifyOptions: jose.JWTVerifyOptions = {};
      if (this.issuer) {
        verifyOptions.issuer = this.issuer;
      }
      if (this.audience) {
        verifyOptions.audience = this.audience;
      }

      const { payload } = await jose.jwtVerify(
        token,
        this.keyOrJwks as any,
        verifyOptions
      );

      if (!payload.iss || typeof payload.iss !== "string") {
        throw new InvalidTokenError("Token missing 'iss' (issuer) claim.");
      }

      if (!payload.sub || typeof payload.sub !== "string") {
        throw new InvalidTokenError("Token missing 'sub' (subject) claim.");
      }

      return {
        issuer: payload.iss,
        subject: payload.sub,
        email: typeof payload.email === "string" ? payload.email : undefined,
        displayName:
          typeof payload.name === "string"
            ? payload.name
            : typeof payload.preferred_username === "string"
            ? payload.preferred_username
            : undefined,
      };
    } catch (error: any) {
      if (error instanceof InvalidTokenError || error instanceof AuthNotConfiguredError) {
        throw error;
      }

      if (error?.code === "ERR_JWT_EXPIRED") {
        throw new InvalidTokenError("Token has expired.");
      }

      if (error?.code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
        throw new InvalidTokenError(`Token claim validation failed: ${error.message}`);
      }

      throw new InvalidTokenError(`Token signature verification failed: ${error?.message ?? "unauthorized"}`);
    }
  }
}
