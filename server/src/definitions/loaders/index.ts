/**
 * Loader per source kind. M3 adds `git: new GitLoader()`.
 */
import type { Source } from "../../models/Source.ts";
import type { DefinitionLoader } from "./DefinitionLoader.ts";
import { LocalLoader } from "./LocalLoader.ts";

export const LOADERS: { [K in Source.Kind]?: DefinitionLoader } = {
  local: new LocalLoader(),
};
