/**
 * `options_from` lists (M3): fetched by the panel only, never by hosts or hooks. https only, host on
 * OPTIONS_FETCH_HOSTS (redirects followed only to allowed hosts, at most 3), 10 s timeout, ≤ 2 MiB JSON body,
 * responses cached in memory for OPTIONS_CACHE_MIN per URL and lists per URL+selector (failures cached 1 min, so a
 * dead upstream isn't hammered; a refresh that fails keeps serving the last good list). Both caches are capped. Selection per `OptionsSource`: items → where →
 * value → include → reverse → limit; values are strings of ≤ 128 characters without control characters (others
 * dropped). Static `options` are prepended and duplicates removed.  
 * A source may name other variables (`{{vars.<key>}}` in `url` after the host, `where` values and `include`): it is
 * rendered with their current values first (`render`), which must be valid values of those variables
 * (`dependencyValues`), so a caller can't make the panel fetch or cache arbitrary combinations. Only a templated `url`
 * fetches per value; `where` and `include` select from the one cached response.
 */
import type { VariableOptionsResponse } from "@shared/api/definitions.ts";
import type { OptionsSource, VariableDecl } from "@shared/protocol/protocol.gen.ts";
import { OPTIONS_PLACEHOLDER, optionsDependencies, whenHolds } from "@shared/variables.ts";
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
  const TEMPLATE = OPTIONS_PLACEHOLDER;
  /**
   * Most rendered lists kept; the oldest go first once expired ones are dropped.
   */
  const MAX_CACHED_LISTS = 500;
  /**
   * Most upstream responses kept (each up to MAX_BODY_BYTES).
   */
  const MAX_CACHED_BODIES = 32;
  /**
   * Longest value of a variable a source depends on.
   */
  export const MAX_DEPENDENCY_LENGTH = 128;

  interface Entry {
    values: string[] | null; // The last good list.
    fetchedAt: Date | null;
    error: string | null; // Why the last fetch failed.
    expires: number;
  }

  interface Body {
    body: unknown; // Parsed JSON; undefined when the fetch failed.
    fetchedAt: Date | null;
    error: string | null;
    expires: number;
  }

  const _cache = new Map<string, Entry>();
  const _inFlight = new Map<string, Promise<Entry>>();
  const _bodies = new Map<string, Body>();
  const _bodiesInFlight = new Map<string, Promise<Body>>();
  let _generation = 0; // Bumped by clearCache: a fetch started before it doesn't store its result.

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
    const templateProblem = [source.url, source.include, ...(isPlainObject(source.where) ? Object.values(source.where) : [])]
      .filter((text): text is string => typeof text === "string")
      .map((text) => text.replace(TEMPLATE, "").includes("{{") ? "can only use {{vars.<key>}} placeholders, without filters." : null)
      .find((found) => found !== null);
    if (templateProblem) return templateProblem;
    // The host must not depend on a variable: render with two different values and compare.
    const [urlA, urlB] = ["a", "b"].map((sample) => (source.url as string).replace(TEMPLATE, sample));
    const urlProblem = checkUrl(urlA);
    if (urlProblem) return `url ${urlProblem}`;
    if (new URL(urlA).host !== new URL(urlB).host) return "url can only use {{vars.<key>}} after the host.";
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
      const found = Patterns.problem(source.include.replace(TEMPLATE, "x"));
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
   * The variables an `options_from` source names, in order of first use.
   */
  export function dependencies(source: OptionsSource | undefined): string[] {
    return optionsDependencies(source);
  }

  /**
   * The values `decl`'s source depends on, as text: from `given` (submitted or stored values, or the options request's
   * query), else the dependency's default, else empty. Each must be a value its own variable accepts: one of its
   * static options, in its own fetched list (checked the same way, so with its own dependencies), matching its
   * `pattern`, or a number or boolean of that type; a plain string without a pattern only gets the length and
   * character checks. `.` and `..` are refused so a value can't step out of a templated URL path.
   * @throws HttpError 400 naming the dependency.
   */
  export async function dependencyValues(decl: VariableDecl, decls: VariableDecl[], given: Record<string, unknown>): Promise<Record<string, string>> {
    const values: Record<string, string> = {};
    for (const key of dependencies(decl.options_from)) {
      const other = decls.find((candidate) => candidate.key === key);
      const raw = given[key] ?? other?.default;
      const value = typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean" ? String(raw) : "";
      if (value !== "" && !(other && await isValidDependency(other, value, decls, given))) {
        throw HttpError.badRequest(`"${other?.label ?? key}" (${key}) isn't one of its choices, so the choices of "${decl.label ?? decl.key}" can't be loaded for it.`);
      }
      values[key] = value;
    }
    return values;
  }

  async function isValidDependency(decl: VariableDecl, value: string, decls: VariableDecl[], given: Record<string, unknown>): Promise<boolean> {
    // deno-lint-ignore no-control-regex
    if (value.length > MAX_DEPENDENCY_LENGTH || /[\u0000-\u001f\u007f]/.test(value) || value === "." || value === "..") return false;
    if (decl.options?.includes(value)) return true;
    switch (decl.type) {
      case "number": {
        const number = value.trim() === "" ? NaN : Number(value);
        return Number.isFinite(number) && (decl.min === undefined || number >= decl.min) && (decl.max === undefined || number <= decl.max);
      }
      case "boolean":
        return value === "true" || value === "false";
      case "secret":
        return false; // Validation refuses secret dependencies; never send one to another site.
      case "select":
        if (decl.options_from) return await isAllowed(decl, value, await dependencyValues(decl, decls, given));
        return false; // A static select's value must be one of its options.
      default:
        return decl.pattern === undefined || Patterns.matchesWhole(decl.pattern, value);
    }
  }

  /**
   * `source` with its `{{vars.<key>}}` placeholders filled from `values`: URL-encoded in `url`, as is in `where`,
   * regex-escaped in `include` (matched literally). A missing value renders as empty text.
   */
  export function render(source: OptionsSource, values: Record<string, string>): OptionsSource {
    const fill = (text: string, encode: (value: string) => string) => text.replace(TEMPLATE, (_, key: string) => encode(values[key] ?? ""));
    const rendered: OptionsSource = { ...source, url: fill(source.url, encodeURIComponent) };
    if (source.where) rendered.where = Object.fromEntries(Object.entries(source.where).map(([path, value]) => [path, fill(value, (text) => text)]));
    if (source.include !== undefined) rendered.include = fill(source.include, escapeRegExp);
    return rendered;
  }

  /**
   * The current list for a select with `options_from`, rendered with `values` (see `dependencyValues`) when the source
   * names other variables. Never throws for upstream problems (they go in `error`).
   * @throws HttpError 400 when the variable has no `options_from`.
   */
  export async function getOptions(decl: VariableDecl, values: Record<string, string> = {}): Promise<VariableOptionsResponse> {
    if (!decl.options_from) throw HttpError.badRequest(`The variable "${decl.key}" doesn't load its options from a URL.`);
    const source = render(decl.options_from, values);
    if (source.include !== undefined) {
      // A long dependency value can push the rendered pattern past the length limit.
      const found = Patterns.problem(source.include);
      if (found) return { options: decl.options ?? [], fetchedAt: null, error: `The rendered include pattern ${found}`, pattern: decl.pattern ?? null };
    }
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
  export async function isAllowed(decl: VariableDecl, value: string, values: Record<string, string> = {}): Promise<boolean> {
    if (decl.options?.includes(value)) return true;
    if (!decl.options_from) return decl.options === undefined;
    const result = await getOptions(decl, values);
    if (result.error === null) return result.options.includes(value);
    return decl.pattern !== undefined && Patterns.matchesWhole(decl.pattern, value);
  }

  /**
   * Checked-in `select` values that come from a fetched list. Only the keys the caller sent (and lists that depend on,
   * or are shown because of, one of them) are looked at, so a stored value that has since left the list doesn't block
   * unrelated changes. A variable hidden by its `when` isn't checked against its list (its dependencies may not fit
   * it), but a value sent for it must still be its default, one of its static options or match its `pattern`.
   * Used by `GameServerService` after `DefinitionEngine.resolveVariables` on create, settings and upgrade.
   * @throws HttpError 400 naming the variable.
   */
  export async function checkValues(decls: VariableDecl[] | undefined, values: Record<string, unknown>, keys: string[], detailed: boolean): Promise<void> {
    for (const decl of decls ?? []) {
      if (!decl.options_from) continue;
      const value = values[decl.key];
      const label = `"${decl.label ?? decl.key}" (${decl.key})`;
      if (!whenHolds(decl.when, values)) {
        if (!keys.includes(decl.key) || typeof value !== "string" || value === decl.default || decl.options?.includes(value)) continue;
        if (decl.pattern !== undefined && Patterns.matchesWhole(decl.pattern, value)) continue;
        const accepted = [decl.options?.length ? `one of: ${decl.options.join(", ")}` : "", decl.pattern !== undefined ? `a value matching ${decl.pattern}` : ""].filter(Boolean).join(", or ");
        throw HttpError.badRequest(`${label} isn't used with these settings, so it can only be ${accepted || "left at its default"}.`);
      }
      // A static option ("latest", "recommended") needs no list, so its dependencies don't matter.
      if (typeof value === "string" && decl.options?.includes(value)) continue;
      const dependencies = optionsDependencies(decl.options_from);
      const triggers = [decl.key, ...dependencies, ...Object.keys(decl.when ?? {})];
      if (!triggers.some((key) => keys.includes(key))) continue;
      const context = await dependencyValues(decl, decls ?? [], values);
      if (typeof value !== "string" || await isAllowed(decl, value, context)) continue;
      const list = await getOptions(decl, context);
      const cause = list.error === null ? "" : detailed ? `the list couldn't be loaded: ${list.error}` : "the list couldn't be loaded right now";
      const hint = cause !== "" && decl.pattern !== undefined ? ` (${cause}; it must match ${decl.pattern})` : cause !== "" ? ` (${cause})` : "";
      const after = dependencies.length > 0 ? ` for the chosen ${dependencies.map((key) => decls?.find((other) => other.key === key)?.label ?? key).join(" and ")}` : "";
      throw HttpError.badRequest(`${label} must be one of the offered values${after}${hint}.`);
    }
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
   * Forget every cached list and response (the allowlist or a definition changed).
   */
  export function clearCache(): void {
    _generation++;
    _cache.clear();
    _bodies.clear();
    _inFlight.clear();
    _bodiesInFlight.clear();
  }

  function escapeRegExp(text: string): string {
    // Only the characters `u`-mode allows (and needs) to be escaped.
    return text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
  }

  function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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
      const generation = _generation;
      const started: Promise<Entry> = refresh(source, cached).then((entry) => {
        if (generation === _generation) remember(_cache, key, entry, MAX_CACHED_LISTS);
        return entry;
      }).finally(() => {
        if (_inFlight.get(key) === started) _inFlight.delete(key);
      });
      pending = started;
      _inFlight.set(key, pending);
    }
    return await pending;
  }

  /**
   * The parsed response at `url`, shared by every list cut from it.
   */
  async function loadBody(url: string): Promise<Body> {
    const cached = _bodies.get(url);
    if (cached && cached.expires > Date.now()) return cached;
    let pending = _bodiesInFlight.get(url);
    if (!pending) {
      const generation = _generation;
      const started: Promise<Body> = fetchJson(url).then(
        (body): Body => ({ body, fetchedAt: new Date(), error: null, expires: Date.now() + Config.OPTIONS_CACHE_MIN * 60_000 }),
        (error: Error): Body => ({ body: undefined, fetchedAt: null, error: error.message, expires: Date.now() + FAILURE_CACHE_MS }),
      ).then((entry) => {
        if (generation === _generation) remember(_bodies, url, entry, MAX_CACHED_BODIES);
        return entry;
      }).finally(() => {
        if (_bodiesInFlight.get(url) === started) _bodiesInFlight.delete(url);
      });
      pending = started;
      _bodiesInFlight.set(url, pending);
    }
    return await pending;
  }

  /**
   * Store `value` under `key`, first dropping expired entries and then the oldest when the map is full.
   */
  function remember<T extends { expires: number }>(map: Map<string, T>, key: string, value: T, max: number): void {
    map.delete(key); // Re-inserting moves it to the newest end.
    if (map.size >= max) {
      const now = Date.now();
      for (const [old, entry] of map) if (entry.expires <= now) map.delete(old);
      for (const old of map.keys()) {
        if (map.size < max) break;
        map.delete(old);
      }
    }
    map.set(key, value);
  }

  async function refresh(source: OptionsSource, previous: Entry | undefined): Promise<Entry> {
    try {
      const response = await loadBody(source.url);
      if (response.error !== null) throw new Error(response.error);
      return { values: select(response.body, source), fetchedAt: response.fetchedAt, error: null, expires: response.expires };
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
