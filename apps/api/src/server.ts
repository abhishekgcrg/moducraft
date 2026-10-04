import { loadConfig } from "./config/env.js";
import { buildApp } from "./app.js";

const config = loadConfig();

try {
  const app = await buildApp({ config });
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    { port: config.port, host: config.host, env: config.env },
    "ModuCraft API server started with restricted database connection"
  );
} catch (error: any) {
  // Avoid logging raw connection strings or secrets on error
  console.error("Failed to start ModuCraft API server:", error.message);
  process.exit(1);
}
