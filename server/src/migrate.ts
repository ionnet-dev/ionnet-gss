/**
 * Migration runner (Umzug over Sequelize). `index.ts` calls `runPendingMigrations()` at startup when
 * `AUTO_MIGRATE=true`; this file is also the CLI.
 *
 * CLI:  deno task migrate [up|down|pending|executed|create <name>]
 */
import { SequelizeStorage, Umzug } from "umzug";
import type { QueryInterface } from "sequelize";
import { sequelize } from "./models/index.ts";
import { migrations } from "./migrations/index.ts";

export const umzug = new Umzug<QueryInterface>({
  migrations: migrations.map((m) => ({
    name: m.name,
    up: ({ context }) => m.up(context),
    down: ({ context }) => m.down(context),
  })),
  context: sequelize.getQueryInterface(),
  storage: new SequelizeStorage({ sequelize, tableName: "schema_migrations" }),
  logger: undefined,
});

/**
 * Apply every pending migration in order.
 * @returns The names of the migrations that ran.
 */
export async function runPendingMigrations(): Promise<string[]> {
  const done = await umzug.up();
  return done.map((m) => m.name);
}

/**
 * A `YYYYMMDDHHMMSS` prefix in UTC.
 */
function timestamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

async function cli(cmd: string, arg: string | undefined): Promise<void> {
  switch (cmd) {
    case "up": {
      const done = await runPendingMigrations();
      console.log(done.length ? `applied:\n${done.map((n) => `  ${n}`).join("\n")}` : "schema up to date");
      break;
    }
    case "down": {
      const done = await umzug.down();
      console.log(done.length ? `reverted: ${done.map((m) => m.name).join(", ")}` : "nothing to revert");
      break;
    }
    case "pending":
      console.log((await umzug.pending()).map((m) => m.name).join("\n") || "(none)");
      break;
    case "executed":
      console.log((await umzug.executed()).map((m) => m.name).join("\n") || "(none)");
      break;
    case "create": {
      if (!arg || !/^[a-z0-9-]+$/.test(arg)) {
        throw new Error("Usage: deno task migrate create <name>, where name is kebab-case (e.g. add-host-notes).");
      }
      const file = `${timestamp()}-${arg}.ts`;
      const body = `import { DataTypes, type QueryInterface } from "sequelize";

export async function up(qi: QueryInterface): Promise<void> {
}

export async function down(qi: QueryInterface): Promise<void> {
}
`;
      await Deno.writeTextFile(new URL(`./migrations/${file}`, import.meta.url), body, { createNew: true });
      console.log(`created server/src/migrations/${file}. Add it to server/src/migrations/index.ts.`);
      break;
    }
    default:
      throw new Error(`Unknown command "${cmd}". Use up, down, pending, executed or create <name>.`);
  }
}

if (import.meta.main) {
  const [cmd = "up", arg] = Deno.args;
  let code = 0;
  try {
    await cli(cmd, arg);
  } catch (error) {
    console.error((error as Error).message);
    code = 1;
  }
  await sequelize.close();
  Deno.exit(code);
}
