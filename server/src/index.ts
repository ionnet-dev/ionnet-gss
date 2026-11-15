/**
 * Panel entry point: data folders → database → migrations → gateways → serve. Main-session only.
 */
import { AppSystem } from "./AppSystem.ts";
import { Config } from "./Config.ts";
import { connectDatabase, sequelize } from "./models/index.ts";
import { runPendingMigrations } from "./migrate.ts";
import { createApp } from "./App.ts";
import { AgentGateway } from "./gateways/agent/AgentGateway.ts";
import { LiveGateway } from "./gateways/live/LiveGateway.ts";
import { DefinitionSync } from "./definitions/DefinitionSync.ts";
import { startSourceSync } from "./jobs/sourceSync.ts";

// Last-resort net: log instead of exiting, which would drop every agent and browser socket at once.
globalThis.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  console.error("unhandled rejection", event.reason);
});

await AppSystem.init();
await connectDatabase();
if (Config.AUTO_MIGRATE) {
  const applied = await runPendingMigrations();
  if (applied.length) console.log(`migrations applied: ${applied.join(", ")}`);
}
await DefinitionSync.syncBuiltin(); // games/ → definitions rows; logs failures, never throws.

const app = createApp();
AgentGateway.start();
LiveGateway.start();
const stopSourceSync = startSourceSync();

const server = Deno.serve({
  port: Config.PORT,
  hostname: Config.HOST,
  onListen: ({ hostname, port }) => console.log(`${AppSystem.name} ${AppSystem.version} on http://${hostname}:${port} (${Config.DENO_ENV})`),
}, app.fetch);

async function shutdown(): Promise<void> {
  console.log("shutting down");
  AgentGateway.stop();
  LiveGateway.stop();
  stopSourceSync();
  await server.shutdown();
  await sequelize.close();
  Deno.exit(0);
}

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);
