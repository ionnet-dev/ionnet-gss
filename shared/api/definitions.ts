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
  commit: string;
  /**
   * The create/settings form. `admin_only` variables are left out for non-admins; `secret` variables are listed but
   * never have a default shown.
   */
  variables: VariableDecl[];
  ports: PortDecl[];
  syncedAt: IsoDate;
}
