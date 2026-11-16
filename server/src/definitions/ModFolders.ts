/**
 * Rules about a definition's `mods` folders (definition.json ModFolder) that the Mods tab applies: which folders apply
 * to a server, which entries count as mods, where disabled ones go and which loaders a catalog is asked for. Pure.
 */
import type { GameDefinition, ModCatalogRef, ModFolder } from "@shared/protocol/protocol.gen.ts";
import { whenHolds } from "@shared/variables.ts";
import { DefinitionEngine } from "./DefinitionEngine.ts";

export namespace ModFolders {
  /**
   * Most bytes a file or folder name can have (Linux NAME_MAX).
   */
  export const NAME_MAX_BYTES = 255;

  /**
   * Whether an entry name matches one of the patterns: `*` is any run of characters, `?` one character, everything
   * else literal (case-sensitive, like the game's loader). A pattern with a trailing `/` matches folders only, one
   * without matches everything else.
   * @param isFolder Whether the entry is a folder.
   */
  export function matches(patterns: string[], name: string, isFolder: boolean): boolean {
    return patterns.some((pattern) => {
      const folderPattern = pattern.endsWith("/");
      if (folderPattern !== isFolder) return false;
      return wildcard(folderPattern ? pattern.slice(0, -1) : pattern, name);
    });
  }

  /**
   * The patterns that match files (no trailing `/`): what an upload's name must match.
   */
  export function filePatterns(folder: ModFolder): string[] {
    return folder.match.filter((pattern) => !pattern.endsWith("/"));
  }

  /**
   * The definition's mod folders whose `when` holds for the server's variable values, in definition order.
   */
  export function applicable(def: GameDefinition, values: Record<string, unknown>): ModFolder[] {
    return (def.mods ?? []).filter((folder) => whenHolds(folder.when, values));
  }

  /**
   * Where the folder's disabled mods live: `disabled_folder`, default `<folder>.disabled`.
   */
  export function disabledFolder(folder: ModFolder): string {
    return folder.disabled_folder ?? `${folder.folder}.disabled`;
  }

  /**
   * A catalog's loader names rendered with the server's values (`{{vars.flavour}}` → `neoforge`), trimmed, without
   * empty ones and duplicates. A template naming a variable the server has no value for is left out, so a catalog that
   * declares loaders can come out with none (the caller treats that as unusable; no `loaders` at all means any).
   */
  export function loaders(catalog: ModCatalogRef, values: Record<string, DefinitionEngine.Value>): string[] {
    const rendered: string[] = [];
    for (const template of catalog.loaders ?? []) {
      let loader: string;
      try {
        loader = DefinitionEngine.render(template, { vars: values, ports: {}, server: { id: "", name: "" } }).trim();
      } catch {
        continue;
      }
      if (loader !== "" && !rendered.includes(loader)) rendered.push(loader);
    }
    return rendered;
  }

  /**
   * Whether `name` is one plain file or folder name: not empty, `.` or `..`, no `/`, `\` or NUL, at most
   * NAME_MAX_BYTES bytes of UTF-8.
   */
  export function isFileName(name: unknown): name is string {
    if (typeof name !== "string" || name === "" || name === "." || name === "..") return false;
    if (/[/\\\0]/.test(name)) return false;
    return new TextEncoder().encode(name).length <= NAME_MAX_BYTES;
  }

  /**
   * Whether `name` matches `pattern` (`*` any run, `?` one character, case-sensitive): two pointers, backtracking only
   * to the last `*`, so the time is linear-ish in both lengths whatever the pattern.
   */
  function wildcard(pattern: string, name: string): boolean {
    const p = [...pattern];
    const n = [...name];
    let i = 0; // In the name.
    let j = 0; // In the pattern.
    let star = -1; // Pattern index after the last `*`.
    let resume = 0; // Name index that `*` would swallow next.
    while (i < n.length) {
      if (j < p.length && (p[j] === "?" || (p[j] !== "*" && p[j] === n[i]))) {
        i++;
        j++;
      }
      else if (j < p.length && p[j] === "*") {
        star = ++j;
        resume = i;
      }
      else if (star !== -1) {
        j = star;
        i = ++resume;
      }
      else {
        return false;
      }
    }
    while (j < p.length && p[j] === "*") j++;
    return j === p.length;
  }
}

export default ModFolders;
