export interface VerifiedClaims {
  issuer: string;
  subject: string;
  email?: string;
  displayName?: string;
}

export interface ResolvedUser {
  id: string;
  identityIssuer: string;
  identitySubject: string;
  email: string | null;
  displayName: string | null;
  createdAt: Date;
}

export interface AuthVerifier {
  isConfigured(): boolean;
  verifyToken(token: string): Promise<VerifiedClaims>;
}

export class AuthenticationError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(message: string, code: string = "UNAUTHORIZED", statusCode: number = 401) {
    super(message);
    this.name = "AuthenticationError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class AuthNotConfiguredError extends AuthenticationError {
  constructor() {
    super(
      "Authentication provider is not configured. Protected endpoints are disabled.",
      "AUTH_NOT_CONFIGURED",
      401
    );
    this.name = "AuthNotConfiguredError";
  }
}

export class InvalidTokenError extends AuthenticationError {
  constructor(detail?: string) {
    super(detail ?? "Invalid authentication token.", "INVALID_TOKEN", 401);
    this.name = "InvalidTokenError";
  }
}
