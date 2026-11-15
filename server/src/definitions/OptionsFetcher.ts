/**
 * `options_from` lists (M3): fetched by the panel only, never by hosts or hooks. https only, host on
 * OPTIONS_FETCH_HOSTS (redirects followed only to allowed hosts, at most 3), 10 s timeout, ≤ 2 MiB JSON body,
 * results cached in memory for OPTIONS_CACHE_MIN per URL+selector (failures cached 1 min, so a dead upstream isn't
 * hammered). Selection per `OptionsSource`: items → where → value → include → reverse → limit; values are strings
 * of ≤ 128 characters (others dropped). Static `options` are prepended and duplicates removed.
 */
import type { VariableOptionsResponse } from "@shared/api/definitions.ts";
import type { OptionsSource, VariableDecl } from "@shared/protocol/protocol.gen.ts";
import { HttpError } from "../lib/HttpError.ts";

export namespace OptionsFetcher {
  /**
   * The current list for a select with `options_from`. Never throws for upstream problems (they go in `error`).
   * @throws HttpError 400 when the variable has no `options_from`.
   */
  export async function getOptions(decl: VariableDecl): Promise<VariableOptionsResponse> {
    throw HttpError.notImplemented("OptionsFetcher.getOptions"); // TODO(builder): C
  }

  /**
   * Whether `value` is acceptable for the select: in the (cached or freshly fetched) list, or, when the list can't be
   * fetched, matching `decl.pattern`. Used by `DefinitionEngine.resolveVariables` callers.
   */
  export async function isAllowed(decl: VariableDecl, value: string): Promise<boolean> {
    throw HttpError.notImplemented("OptionsFetcher.isAllowed"); // TODO(builder): C
  }

  /**
   * Pure selection step, exported for the scratch test: apply `source` to a parsed JSON body.
   */
  export function select(body: unknown, source: OptionsSource): string[] {
    throw HttpError.notImplemented("OptionsFetcher.select"); // TODO(builder): C
  }
}

export default OptionsFetcher;
