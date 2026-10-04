export interface AppConfig {
  env: string;
  port: number;
  host: string;
  databaseUrl: string;
  auth: {
    issuer?: string;
    audience?: string;
    jwksUri?: string;
    publicKey?: string;
    secret?: string;
  };
}

export function loadConfig(envOverrides?: Partial<Record<string, string>>): AppConfig {
  const env = envOverrides ?? process.env;

  const nodeEnv = env.NODE_ENV ?? "development";
  const port = Number(env.API_PORT ?? 4000);
  const host = env.API_HOST ?? "127.0.0.1";

  // Use restricted runtime role by default for application requests
  // Local dev default credentials connect strictly as moducraft_runtime
  const databaseUrl =
    env.DATABASE_URL ??
    "postgresql://moducraft_runtime:moducraft_runtime_local@127.0.0.1:5432/moducraft";

  return {
    env: nodeEnv,
    port,
    host,
    databaseUrl,
    auth: {
      issuer: env.AUTH_ISSUER,
      audience: env.AUTH_AUDIENCE,
      jwksUri: env.AUTH_JWKS_URI,
      publicKey: env.AUTH_PUBLIC_KEY,
      secret: env.AUTH_SECRET,
    },
  };
}
