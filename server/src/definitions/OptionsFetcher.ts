/**
 * `options_from` lists (M3): fetched by the panel only, never by hosts or hooks. https only, host on
 * OPTIONS_FETCH_HOSTS (redirects followed only to allowed hosts, at most 3), 10 s timeout, ≤ 2 MiB JSON body,
 * results cached in memory for OPTIONS_CACHE_MIN per URL+selector (failures cached 1 min, so a dead upstream isn't
 * hammered; a refresh that fails keeps serving the last good list). Selection per `OptionsSource`: items → where →
 * value → include → reverse → limit; values are strings of ≤ 128 characters without control characters (others
 * dropped). Static `options` are prepended and duplicates removed.
 */
import type { VariableOptionsResponse } from "@shared/api/definitions.ts";
import type { OptionsSource, VariableDecl } from "@shared/protocol/protocol.gen.ts";
import { Config } from "../Config.ts";
import { HttpError } from "../lib/HttpError.ts";
import { Patterns } from "./patterns.ts";

export namespace OptionsFetcher {
  export const MAX_BODY_BYTES = 2 * 1024 * 1024;
  export const TIMEOUT_MS = 10_000;
  export const MAX_REDIRECTS = 3;
  export const DEFAULT_LIMIT = 100;
  export const MAX_LIMIT = 500;
  /**
   * What non-admins see instead of a fetch error.
   */
  export const GENERIC_ERROR = "The list of choices couldn't be loaded right now.";
  const MAX_VALUE_LENGTH = 128;
  const FAILURE_CACHE_MS = 60_000;
  const PATH_PATTERN = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

  interface Entry {
    values: string[] | null; // The last good list.
    fetchedAt: Date | null;
    error: string | null; // Why the last fetch failed.
    expires: number;
  }

  const _cache = new Map<string, Entry>();
  const _inFlight = new Map<string, Promise<Entry>>();

  /**
   * The https hosts `options_from` may fetch from (lowercase).
   */
  export function allowedHosts(): string[] {
    return Config.OPTIONS_FETCH_HOSTS.split(",").map((host) => host.trim().toLowerCase()).filter((host) => host !== "");
  }

  /**
   * Check a `options_from` mapping from a game.yml (structure, https URL on the allowlist, paths, patterns, limit).
   * @returns What is wrong, phrased to follow `options_from `, or null.
   */
  export function problem(raw: unknown): string | null {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "must be a mapping with a url.";
    const source = raw as Record<string, unknown>;
    for (const key of Object.keys(source)) {
      if (!["url", "items", "value", "where", "include", "reverse", "limit"].includes(key)) return `has the unknown key "${key}". Known keys: url, items, value, where, include, reverse, limit.`;
    }
    if (typeof source.url !== "string") return "needs a url (https).";
    const urlProblem = checkUrl(source.url);
    if (urlProblem) return `url ${urlProblem}`;
    for (const key of ["items", "value"] as const) {
      const path = source[key];
      if (path === undefined) continue;
      if (typeof path !== "string" || (path !== "" && !PATH_PATTERN.test(path))) return `${key} must be a dotted path like versions or id (letters, digits, _ and -).`;
    }
    if (source.where !== undefined) {
      if (typeof source.where !== "object" || source.where === null || Array.isArray(source.where)) return "where must be a mapping of field to value.";
      for (const [path, value] of Object.entries(source.where)) {
        if (!PATH_PATTERN.test(path) || typeof value !== "string") return `where.${path} must be a field path with a string value.`;
      }
    }
    if (source.include !== undefined) {
      if (typeof source.include !== "string") return "include must be a regular expression string.";
      const found = Patterns.problem(source.include);
      if (found) return `include ${found}`;
    }
    if (source.reverse !== undefined && typeof source.reverse !== "boolean") return "reverse must be true or false.";
    if (source.limit !== undefined && (!Number.isInteger(source.limit) || (source.limit as number) < 1 || (source.limit as number) > MAX_LIMIT)) {
      return `limit must be a whole number from 1 to ${MAX_LIMIT}.`;
    }
    return null;
  }

  /**
   * Why `url` can't be fetched (not https, credentials, or a host that isn't on OPTIONS_FETCH_HOSTS), or null.
   * @returns The problem phrased to follow "url ".
   */
  export function checkUrl(url: string): string | null {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return "isn't a valid URL.";
    }
    if (parsed.protocol !== "https:") return "must be https://.";
    if (parsed.username !== "" || parsed.password !== "") return "can't contain credentials.";
    if (!allowedHosts().includes(parsed.hostname.toLowerCase())) {
      return `host "${parsed.hostname}" isn't allowed. The panel's OPTIONS_FETCH_HOSTS lists: ${allowedHosts().join(", ") || "nothing"}.`;
    }
    return null;
  }

  /**
   * The current list for a select with `options_from`. Never throws for upstream problems (they go in `error`).
   * @throws HttpError 400 when the variable has no `options_from`.
   */
  export async function getOptions(decl: VariableDecl): Promise<VariableOptionsResponse> {
    const source = decl.options_from;
    if (!source) throw HttpError.badRequest(`The variable "${decl.key}" doesn't load its options from a URL.`);
    const entry = await load(source);
    const options = [...new Set([...(decl.options ?? []), ...(entry.values ?? [])])];
    return {
      options,
      fetchedAt: entry.fetchedAt?.toISOString() ?? null,
      error: entry.values === null ? entry.error : null,
      pattern: decl.pattern ?? null,
    };
  }

  /**
   * Whether `value` is acceptable for the select: in the (cached or freshly fetched) list, or, when the list can't be
   * fetched, matching `decl.pattern`. Used by the server service after `DefinitionEngine.resolveVariables`.
   */
  export async function isAllowed(decl: VariableDecl, value: string): Promise<boolean> {
    if (decl.options?.includes(value)) return true;
    if (!decl.options_from) return decl.options === undefined;
    const result = await getOptions(decl);
    if (result.error === null) return result.options.includes(value);
    return decl.pattern !== undefined && Patterns.matchesWhole(decl.pattern, value);
  }

  /**
   * Pure selection step, exported for the scratch test: apply `source` to a parsed JSON body.
   * @throws Error when the body has no list at `source.items`.
   */
  export function select(body: unknown, source: OptionsSource): string[] {
    const list = source.items ? pathValue(body, source.items) : body;
    if (!Array.isArray(list)) throw new Error(source.items ? `The response has no list at "${source.items}".` : "The response isn't a list.");
    const limit = Math.min(MAX_LIMIT, Math.max(1, source.limit ?? DEFAULT_LIMIT));
    const where = Object.entries(source.where ?? {});
    const values: string[] = [];
    for (const item of list) {
      if (!where.every(([path, expected]) => {
        const actual = pathValue(item, path);
        return (typeof actual === "string" || typeof actual === "number" || typeof actual === "boolean") && String(actual) === expected;
      })) continue;
      const value = source.value ? pathValue(item, source.value) : item;
      // deno-lint-ignore no-control-regex
      if (typeof value !== "string" || value === "" || value.length > MAX_VALUE_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) continue;
      if (source.include !== undefined && !Patterns.matchesAnywhere(source.include, value)) continue;
      values.push(value);
    }
    if (source.reverse) values.reverse();
    return [...new Set(values)].slice(0, limit);
  }

  /**
   * Forget every cached list (the allowlist or a definition changed).
   */
  export function clearCache(): void {
    _cache.clear();
  }

  function pathValue(root: unknown, path: string): unknown {
    let current = root;
    for (const part of path.split(".")) {
      if (typeof current !== "object" || current === null || !Object.hasOwn(current, part)) return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  function cacheKey(source: OptionsSource): string {
    return JSON.stringify([source.url, source.items ?? "", source.value ?? "", source.where ?? {}, source.include ?? "", source.reverse ?? false, source.limit ?? DEFAULT_LIMIT]);
  }

  async function load(source: OptionsSource): Promise<Entry> {
    const key = cacheKey(source);
    const cached = _cache.get(key);
    if (cached && cached.expires > Date.now()) return cached;
    let pending = _inFlight.get(key);
    if (!pending) {
      pending = refresh(source, cached).then((entry) => {
        _cache.set(key, entry);
        return entry;
      }).finally(() => _inFlight.delete(key));
      _inFlight.set(key, pending);
    }
    return await pending;
  }

  async function refresh(source: OptionsSource, previous: Entry | undefined): Promise<Entry> {
    try {
      const body = await fetchJson(source.url);
      return { values: select(body, source), fetchedAt: new Date(), error: null, expires: Date.now() + Config.OPTIONS_CACHE_MIN * 60_000 };
    } catch (error) {
      const message = (error as Error).message;
      if (previous?.values) return { ...previous, expires: Date.now() + FAILURE_CACHE_MS }; // Keep serving the last good list.
      return { values: null, fetchedAt: null, error: message, expires: Date.now() + FAILURE_CACHE_MS };
    }
  }

  /**
   * GET the JSON at `url`, following at most MAX_REDIRECTS redirects to allowed https hosts.
   * @throws Error with a readable reason.
   */
  async function fetchJson(url: string): Promise<unknown> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const problem = checkUrl(current);
      if (problem) throw new Error(`The options URL ${problem}`);
      const response = await fetch(current, {
        redirect: "manual",
        headers: { accept: "application/json", "user-agent": "ionnet-gss-panel" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }).catch((error: Error) => {
        throw new Error(error.name === "TimeoutError" ? `The options server didn't answer within ${TIMEOUT_MS / 1000} seconds.` : `The options server couldn't be reached (${error.message}).`);
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) throw new Error(`The options server answered ${response.status} without a Location.`);
        current = new URL(location, current).toString();
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`The options server answered ${response.status}.`);
      }
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > MAX_BODY_BYTES) {
        await response.body?.cancel();
        throw new Error(`The options response is larger than ${MAX_BODY_BYTES / 1024 / 1024} MiB.`);
      }
      const text = await readLimited(response);
      try {
        return JSON.parse(text);
      } catch {
        throw new Error("The options response isn't JSON.");
      }
    }
    throw new Error(`The options URL redirected more than ${MAX_REDIRECTS} times.`);
  }

  async function readLimited(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_BODY_BYTES) throw new Error(`The options response is larger than ${MAX_BODY_BYTES / 1024 / 1024} MiB.`);
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    return new TextDecoder().decode(bytes);
  }
}

export default OptionsFetcher;
