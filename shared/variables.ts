/**
 * Rules about game.yml variables that the panel and the form must apply the same way: which variables an
 * `options_from` list depends on, and whether a variable's `when` holds.
 */
import type { OptionsSource } from "./protocol/protocol.gen.ts";

/**
 * A `{{vars.<key>}}` placeholder in an `options_from` source (no filters). Global: use with `matchAll` or `replace`.
 */
export const OPTIONS_PLACEHOLDER = /\{\{\s*vars\.([a-z][a-z0-9_]*)\s*\}\}/g;

/**
 * The variables an `options_from` source names (in `url`, `include` and `where` values), in order of first use.
 */
export function optionsDependencies(source: OptionsSource | undefined | null): string[] {
  if (!source) return [];
  const texts = [source.url, source.include ?? "", ...Object.values(source.where ?? {})];
  return [...new Set(texts.flatMap((text) => [...text.matchAll(OPTIONS_PLACEHOLDER)].map((match) => match[1])))];
}

/**
 * Whether a variable's `when` holds for these values: no `when`, or every named variable holds one of its listed
 * values (compared as text, so booleans are "true" / "false").
 */
export function whenHolds(when: Record<string, string[]> | undefined | null, values: Record<string, unknown>): boolean {
  return Object.entries(when ?? {}).every(([key, allowed]) => {
    const value = values[key];
    return (typeof value === "string" || typeof value === "number" || typeof value === "boolean") && allowed.includes(String(value));
  });
}
