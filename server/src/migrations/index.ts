/**
 * Ordered list of migrations. Append new entries; never reorder or rename applied ones.
 * Umzug's glob loader needs Node's require(), which Deno doesn't have, so the list is explicit.
 * Main-session only: builders that need a schema change hand it back instead of adding a file here.
 */
import type { QueryInterface } from "sequelize";
import * as m20261115000000 from "./20261115000000-initial.ts";
import * as m20261116000000 from "./20261116000000-m2-servers.ts";
import * as m20261117000000 from "./20261117000000-server-deleting.ts";
import * as m20261118000000 from "./20261118000000-server-private-network.ts";
import * as m20261119000000 from "./20261119000000-m3-sources.ts";
import * as m20261120000000 from "./20261120000000-m5-tenancy.ts";
import * as m20261121000000 from "./20261121000000-agent-updates.ts";

export interface Migration {
  name: string;
  up: (qi: QueryInterface) => Promise<void>;
  down: (qi: QueryInterface) => Promise<void>;
}

export const migrations: Migration[] = [
  { name: "20261115000000-initial", ...m20261115000000 },
  { name: "20261116000000-m2-servers", ...m20261116000000 },
  { name: "20261117000000-server-deleting", ...m20261117000000 },
  { name: "20261118000000-server-private-network", ...m20261118000000 },
  { name: "20261119000000-m3-sources", ...m20261119000000 },
  { name: "20261120000000-m5-tenancy", ...m20261120000000 },
  { name: "20261121000000-agent-updates", ...m20261121000000 },
];
