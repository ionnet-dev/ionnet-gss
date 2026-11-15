/**
 * `/api/definitions`: the games users can create servers from (active versions only).
 */
import type { IsoDate } from "./common.ts";
import type { PortDecl, VariableDecl } from "../protocol/protocol.gen.ts";

export interface DefinitionDto {
  id: number; // Definition row (one version); what CreateServerBody.definitionId takes.
  gameId: string; // e.g. "minecraft-java"
  name: string;
  source: string; // Source name; "builtin" for the repo's games/ folder.
  sourceKind: "local" | "git";
  commit: string; // "local" for the built-in source.
  /**
   * The definition declares `services` (a stack).
   */
  isStack: boolean;
  /**
   * Extra containers that come with the game (stacks). Empty when there are none. `memoryMb` counts against capacity.
   */
  services: DefinitionServiceDto[];
  /**
   * The create/settings form. `admin_only` variables are left out for non-admins; `secret` variables are listed but
   * never have a default shown.
   */
  variables: VariableDecl[];
  ports: PortDecl[];
  syncedAt: IsoDate;
}

/**
 * `GET /api/definitions/:id/options/:key`: the resolved list of an `options_from` select (static `options` first).
 * On a fetch failure `options` holds only the static ones, `error` says why, and any value matching `pattern` is
 * accepted at create.
 */
export interface VariableOptionsResponse {
  options: string[];
  fetchedAt: IsoDate | null;
  error: string | null;
  pattern: string | null;
}

/**
 * One extra container a stack definition brings along, as shown before a server is created.
 */
export interface DefinitionServiceDto {
  name: string;
  image: string;
  memoryMb: number | null;
}
