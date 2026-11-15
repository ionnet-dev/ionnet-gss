/**
 * Ordered list of migrations. Append new entries; never reorder or rename applied ones.
 * Umzug's glob loader needs Node's require(), which Deno doesn't have, so the list is explicit.
 * Main-session only: builders that need a schema change hand it back instead of adding a file here.
 */
import type { QueryInterface } from "sequelize";
import * as m20261115000000 from "./20261115000000-initial.ts";
import * as m20261116000000 from "./20261116000000-m2-servers.ts";

export interface Migration {
  name: string;
  up: (qi: QueryInterface) => Promise<void>;
  down: (qi: QueryInterface) => Promise<void>;
}

export const migrations: Migration[] = [
  { name: "20261115000000-initial", ...m20261115000000 },
  { name: "20261116000000-m2-servers", ...m20261116000000 },
];
