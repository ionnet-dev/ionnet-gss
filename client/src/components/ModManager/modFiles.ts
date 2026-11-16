import type { ModInstallResponse } from "@shared/api/mods.ts";

/**
 * Name matching for the mod folders: the definition's `match` patterns (one path segment; `*` and `?`; a trailing `/`
 * matches folders only).
 */

function toRegExp(pattern: string): RegExp {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${source}$`);
}

/**
 * The patterns a dropped or picked file can match (those without a trailing `/`).
 */
export function filePatterns(match: string[]): string[] {
  return match.filter((pattern) => !pattern.endsWith("/"));
}

/**
 * Whether the folder's mods can be folders (some pattern ends with `/`).
 */
export function hasFolderPatterns(match: string[]): boolean {
  return match.some((pattern) => pattern.endsWith("/"));
}

export function matchesFile(name: string, match: string[]): boolean {
  return filePatterns(match).some((pattern) => toRegExp(pattern).test(name));
}

/**
 * `.jar`, `.jar or .zip files` style wording for the empty state: the extensions when every pattern is `*.ext`, the
 * patterns otherwise.
 */
export function describePatterns(match: string[]): string {
  const patterns = filePatterns(match);
  if (patterns.length === 0) return "files";
  const extensions = patterns.map((pattern) => /^\*(\.[^*?]+)$/.exec(pattern)?.[1]);
  const names = extensions.every((extension) => extension !== undefined) ? extensions as string[] : patterns;
  const joined = names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : names[0];
  return `${joined} files`;
}

/**
 * The toast text for an install or update: what landed (dependencies marked) and what was skipped and why.
 */
export function describeInstall(response: ModInstallResponse): string {
  const parts: string[] = [];
  if (response.installed.length > 0) {
    parts.push(`Installed ${response.installed.map((mod) => `${mod.title} ${mod.versionNumber}${mod.dependency ? " (dependency)" : ""}`).join(", ")}.`);
  }
  if (response.skipped.length > 0) {
    parts.push(`Skipped ${response.skipped.map((mod) => `${mod.title} (${mod.reason})`).join(", ")}.`);
  }
  return parts.join(" ") || "Nothing needed installing.";
}

const PROVIDER_LABELS: Record<string, string> = { curseforge: "CurseForge", modrinth: "Modrinth" };

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/**
 * Whether a file is a modpack the folder can import (and not a mod it would take as it is): `.mrpack`, a CurseForge
 * `manifest.json`, or a `.zip` the folder's own patterns don't claim.
 */
export function isPackFile(name: string, folder: { match: string[]; packs: string[] }): boolean {
  if (folder.packs.length === 0 || matchesFile(name, folder.match)) return false;
  const lower = name.toLowerCase();
  return lower.endsWith(".mrpack") || lower.endsWith(".zip") || lower === "manifest.json";
}
