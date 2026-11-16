/**
 * The definition engine (M2): game.yml → validated `GameDefinition` → resolved `ServerSpec` for one server.
 * Pure: no database, no agent. `GameServerService` (create, update) and `DefinitionSync` call it.
 */
import { parse as parseYaml } from "@std/yaml";
import {
  CONFIG_FORMAT_VALUES,
  CONSOLE_INPUT_VALUES,
  type ConfigMapping,
  type GameDefinition,
  type InstallStep,
  PORT_PROTO_VALUES,
  type PortBinding,
  type ServerSpec,
  type SpecFile,
  VARIABLE_BIND_VALUES,
  VARIABLE_TYPE_VALUES,
  type VariableDecl,
} from "@shared/protocol/protocol.gen.ts";
import { HttpError } from "../lib/HttpError.ts";
import { sha256Hex } from "../lib/tokens.ts";
import { OptionsFetcher } from "./OptionsFetcher.ts";
import { Patterns } from "./patterns.ts";

export namespace DefinitionEngine {
  export type Value = string | number | boolean;

  /**
   * Values `{{…}}` templates can read: `vars.<key>`, `ports.<name>`, `server.id`, `server.name`.
   */
  export interface TemplateContext {
    vars: Record<string, Value>;
    ports: Record<string, number>;
    server: { id: string; name: string };
  }

  export interface BuildInput {
    serverId: string;
    serverName: string;
    definition: GameDefinition; // Already resolved (`extends` merged).
    files: Record<string, string>; // Definition folder files (hooks, templates).
    source: string;
    commit: string;
    variables: Record<string, Value>; // Every value, defaults and generated secrets applied.
    ports: PortBinding[];
    limits: ServerSpec["limits"];
    autostart: boolean;
    autoRestart: boolean;
    allowPrivateNetwork: boolean; // Part of the spec (and its hash), so a change re-provisions.
    imageRegistry: string; // `IMAGE_REGISTRY`, for `resolveImage`.
  }

  /**
   * Most characters a `string` or `secret` value can have.
   */
  export const MAX_STRING_VALUE = 1024;

  /**
   * Default image of a definition that names none.
   */
  export const DEFAULT_IMAGE = "ionnet-gss-base";

  const SECRET_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
  const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
  const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
  const PLACEHOLDER_PATH = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)+$/;
  const MIN_INSTALL_TIMEOUT_SEC = 60;
  /**
   * Debian package names (policy 5.6.1: lowercase letters, digits, `+ - .`, at least two characters, starting with a
   * letter or digit, not ending in a dash), optionally with the `:i386` architecture. Mirrors the agent's
   * `images.ValidatePackages`.
   */
  const PACKAGE_PATTERN = /^[a-z0-9][a-z0-9+.-]*[a-z0-9+.](:i386)?$/;
  const MAX_PACKAGES = 50;
  const MAX_PACKAGE_LENGTH = 63;
  const MAX_SERVICES = 4;
  const SERVICE_NAME_PATTERN = /^[a-z]([a-z0-9-]{0,29}[a-z0-9])?$/; // A DNS label: no leading digit, no trailing dash.
  const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
  const VOLUME_PATTERN = /^\/[A-Za-z0-9._/-]{1,254}$/;
  /**
   * Most seconds a service healthcheck's `startTimeout` may be (the agent's `stacks.MaxStartTimeout`: a start must
   * answer within the provision timeout).
   */
  export const MAX_SERVICE_START_TIMEOUT = 600;
  const STEAM_BETA_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
  const CFG_KEY_PATTERN = /^[A-Za-z0-9_.+-]{1,64}$/;
  const INI_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
  const PATH_KEY_PATTERN = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
  const MAX_ENV_VARS = 64;
  const MAX_ENV_VALUE = 4096;
  /**
   * Limits a service gets when game.yml sets none (definition.json ServiceLimits).
   */
  export const DEFAULT_SERVICE_LIMITS = { memoryMb: 512, cpuMillis: 500, pids: 256 };

  /**
   * Template filters: `{{vars.motd|sh}}` quotes a value for `/bin/sh` (POSIX single quotes), `{{vars.motd|json}}`
   * writes it as a JSON value.
   */
  export const FILTERS: Record<string, (value: Value) => string> = {
    sh: (value) => `'${String(value).replaceAll("'", "'\\''")}'`,
    json: (value) => JSON.stringify(value),
  };
  const MAX_SECRET_LENGTH = 256;

  /**
   * Keys of a definition whose strings may hold `{{…}}` templates.
   */
  const TEMPLATED_KEYS = ["image", "install", "configs", "hooks", "start", "ready", "stop", "console", "players", "backup", "services"] as const;
  const DEFINITION_KEYS = ["id", "name", "extends", "image", "packages", "variables", "ports", "install_timeout", ...TEMPLATED_KEYS.filter((k) => k !== "image")];
  const VARIABLE_KEYS = ["key", "label", "description", "type", "options", "options_from", "pattern", "default", "unit", "min", "max", "reinstall", "admin_only", "bind", "generate"];
  const PORT_KEYS = ["name", "proto", "default", "internal"];
  const INSTALL_KEYS = ["steamcmd", "download", "extract", "write", "hook"];
  const CONFIG_KEYS = ["file", "format", "set", "template"];

  //#region Parse and validate
  /**
   * Parse and validate one game.yml (structure per protocol/schema/definition.json, plus: unique variable keys and
   * port names, `select` has options or options_from, templates only reference declared vars and ports).
   * A definition that `extends` another is checked structurally here; references and required keys are checked after
   * `resolve()` (which calls `validate()`).
   * @throws Error with a readable message naming the file and the field.
   */
  export function parse(yamlText: string, path: string): GameDefinition {
    let raw: unknown;
    try {
      raw = parseYaml(yamlText);
    } catch (error) {
      throw new Error(`${path}: not valid YAML (${(error as Error).message.split("\n")[0]}).`);
    }
    const def = checkStructure(raw, path);
    if (def.extends === undefined) validate(def, path);
    return def;
  }

  /**
   * Check what only a complete definition can satisfy: a `start` command, internal ports with a default, every
   * `{{…}}` placeholder naming a declared variable, a declared port or `server.id` / `server.name` (with a known
   * filter), no user text (string and secret variables, `options_from` selects, `server.name`) unquoted where a shell
   * runs it (`start`, `stop.command` and hook paths need `|sh`), and no placeholder in an image but a static select.
   * @throws Error naming the file and the problem.
   */
  export function validate(def: GameDefinition, path: string): void {
    if (typeof def.start !== "string" || def.start.trim() === "") {
      throw new Error(`${path}: "start" is required: the command that runs the game, e.g. start: java -jar server.jar nogui.`);
    }
    for (const port of def.ports ?? []) {
      if (port.internal && port.default === undefined) {
        throw new Error(`${path}: the internal port "${port.name}" needs a "default" (internal ports are not allocated).`);
      }
    }
    if ((def.packages ?? []).length > MAX_PACKAGES) throw new Error(`${path}: "packages" lists ${def.packages!.length} packages; at most ${MAX_PACKAGES} are allowed.`);
    if (Object.keys(def.services ?? {}).length > MAX_SERVICES) throw new Error(`${path}: "services" lists ${Object.keys(def.services!).length} services; at most ${MAX_SERVICES} are allowed.`);
    const varKeys = new Set((def.variables ?? []).map((v) => v.key));
    const portNames = new Set((def.ports ?? []).map((p) => p.name));
    for (const key of TEMPLATED_KEYS) {
      visitStrings(def[key], key, (text, where) => {
        for (const match of text.matchAll(PLACEHOLDER)) {
          const problem = placeholderProblem(match[1], varKeys, portNames);
          if (problem) throw new Error(`${path}: ${where}: ${problem}`);
        }
      });
    }

    // Image references choose what runs: only a select with static options (the author's own list) may appear there.
    const imageVars = new Set((def.variables ?? []).filter((v) => v.type === "select" && v.options !== undefined && v.options_from === undefined).map((v) => `vars.${v.key}`));
    const imageStrings: [string, unknown][] = [["image", def.image], ...Object.entries(def.services ?? {}).map(([name, service]) => [`services.${name}.image`, service.image] as [string, unknown])];
    for (const [where, text] of imageStrings) {
      if (typeof text !== "string") continue;
      for (const match of text.matchAll(PLACEHOLDER)) {
        const { path: name } = splitPlaceholder(match[1]);
        if (!imageVars.has(name)) {
          throw new Error(`${path}: ${where}: {{${match[1]}}} can't be used in an image; only a select variable with a static options list can choose the image.`);
        }
      }
    }

    // User text reaching a shell must be quoted. Static select options are the author's own, numbers and booleans are
    // safe; an `options_from` list comes from a remote site, so it counts as user text.
    const userText = new Set(["server.name", ...(def.variables ?? []).filter((v) => v.type === "string" || v.type === "secret" || v.options_from !== undefined).map((v) => `vars.${v.key}`)]);
    const shellStrings: [string, unknown][] = [["start", def.start], ["stop.command", def.stop?.command], ["hooks", def.hooks], ["install", (def.install ?? []).map((step) => step.hook)],
      ["services.command", Object.values(def.services ?? {}).map((service) => service.command)],
      ["services.healthcheck", Object.values(def.services ?? {}).map((service) => service.healthcheck?.command)],
    ];
    for (const [key, value] of shellStrings) {
      visitStrings(value, key, (text, where) => {
        for (const match of text.matchAll(PLACEHOLDER)) {
          const { path: name, filter } = splitPlaceholder(match[1]);
          if (userText.has(name) && filter !== "sh") {
            throw new Error(`${path}: ${where}: {{${match[1]}}} is user text in a shell command; quote it with {{${name}|sh}}.`);
          }
        }
      });
    }
  }

  /**
   * `vars.motd | sh` → { path: "vars.motd", filter: "sh" }; no filter → null.
   */
  function splitPlaceholder(inner: string): { path: string; filter: string | null } {
    const bar = inner.indexOf("|");
    if (bar < 0) return { path: inner.trim(), filter: null };
    return { path: inner.slice(0, bar).trim(), filter: inner.slice(bar + 1).trim() };
  }

  /**
   * Every file in the definition folder the definition points at: install and lifecycle hooks, config templates and
   * `options_from` hooks.
   */
  export function referencedFiles(def: GameDefinition): string[] {
    return [...new Set([...hookPaths(def), ...templatePaths(def), ])];
  }

  function hookPaths(def: GameDefinition): string[] {
    const paths: string[] = [];
    for (const step of def.install ?? []) if (step.hook !== undefined) paths.push(step.hook);
    for (const path of Object.values(def.hooks ?? {})) if (typeof path === "string") paths.push(path);
    return paths;
  }

  function templatePaths(def: GameDefinition): string[] {
    return (def.configs ?? []).flatMap((config) => config.template !== undefined ? [config.template] : []);
  }

  function placeholderProblem(inner: string, varKeys: Set<string>, portNames: Set<string>): string | null {
    const { path, filter } = splitPlaceholder(inner);
    if (filter !== null && !Object.hasOwn(FILTERS, filter)) return `"{{${inner}}}" uses the unknown filter "${filter}". Filters: ${Object.keys(FILTERS).join(", ")}.`;
    if (!PLACEHOLDER_PATH.test(path)) return `"{{${path}}}" is not a placeholder. Use {{vars.<key>}}, {{ports.<name>}}, {{server.id}} or {{server.name}}.`;
    const [root, name] = path.split(".");
    if (path.split(".").length === 2) {
      if (root === "vars" && varKeys.has(name)) return null;
      if (root === "ports" && portNames.has(name)) return null;
      if (root === "server" && (name === "id" || name === "name")) return null;
    }
    if (root === "vars") return `"{{${path}}}" names a variable that is not declared under "variables".`;
    if (root === "ports") return `"{{${path}}}" names a port that is not declared under "ports".`;
    return `"{{${path}}}" is unknown. Use {{vars.<key>}}, {{ports.<name>}}, {{server.id}} or {{server.name}}.`;
  }

  function visitStrings(value: unknown, where: string, visit: (text: string, where: string) => void): void {
    if (typeof value === "string") visit(value, where);
    else if (Array.isArray(value)) value.forEach((item, i) => visitStrings(item, `${where}[${i}]`, visit));
    else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) visitStrings(item, `${where}.${key}`, visit);
    }
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  /**
   * Whether an RE2 / JS pattern holds a capturing group: an unescaped `(` outside a character class that is not
   * `(?:`, a lookaround or a flag group. Named groups (`(?P<n>`, `(?<n>`) count.
   */
  function hasCaptureGroup(pattern: string): boolean {
    let inClass = false;
    for (let i = 0; i < pattern.length; i++) {
      const char = pattern[i];
      if (char === "\\") {
        i++;
      }
      else if (inClass) {
        if (char === "]") inClass = false;
      }
      else if (char === "[") {
        inClass = true;
        if (pattern[i + 1] === "^") i++;
        if (pattern[i + 1] === "]") i++; // A leading `]` is a literal.
      }
      else if (char === "(") {
        if (pattern[i + 1] !== "?") return true;
        if (pattern.startsWith("(?P<", i) || (pattern.startsWith("(?<", i) && pattern[i + 3] !== "=" && pattern[i + 3] !== "!")) return true;
      }
    }
    return false;
  }

  function isSafePath(path: string): boolean {
    return path !== "" && !path.startsWith("/") && !path.includes("\\") && !path.split("/").some((part) => part === ".." || part === "");
  }

  /**
   * Structure checks per protocol/schema/definition.json. Returns the same object, typed.
   */
  function checkStructure(raw: unknown, path: string): GameDefinition {
    const fail = (where: string, message: string): never => {
      throw new Error(`${path}: ${where} ${message}`);
    };
    const checkKeys = (obj: Record<string, unknown>, allowed: string[], where: string) => {
      for (const key of Object.keys(obj)) {
        if (!allowed.includes(key)) fail(where === "" ? `"${key}"` : `${where}.${key}`, `is not a known key. Known keys: ${allowed.join(", ")}.`);
      }
    };
    const str = (value: unknown, where: string, optional = true) => {
      if (value === undefined && optional) return;
      if (typeof value !== "string") fail(where, "must be a string.");
    };
    const safePath = (value: unknown, where: string) => {
      if (typeof value !== "string" || !isSafePath(value)) fail(where, "must be a relative path without \"..\" (e.g. hooks/install.sh).");
    };
    const list = (value: unknown, where: string): unknown[] => {
      if (!Array.isArray(value)) return fail(where, "must be a list.");
      return value;
    };

    if (!isRecord(raw)) return fail("", "must hold a YAML mapping with at least an \"id\".") as never;
    checkKeys(raw, DEFINITION_KEYS, "");
    if (typeof raw.id !== "string" || !ID_PATTERN.test(raw.id)) fail("id", "must be a slug of lowercase letters, digits and dashes (e.g. minecraft-java).");
    str(raw.name, "name");
    if (raw.extends !== undefined && (typeof raw.extends !== "string" || !ID_PATTERN.test(raw.extends))) fail("extends", "must be the id of another definition.");
    str(raw.image, "image");
    str(raw.start, "start");
    if (raw.install_timeout !== undefined && (!Number.isInteger(raw.install_timeout) || (raw.install_timeout as number) < MIN_INSTALL_TIMEOUT_SEC)) {
      fail("install_timeout", `must be a whole number of seconds, at least ${MIN_INSTALL_TIMEOUT_SEC}.`);
    }
    if (raw.packages !== undefined) {
      const packages = list(raw.packages, "packages");
      if (packages.length > MAX_PACKAGES) fail("packages", `lists ${packages.length} packages; at most ${MAX_PACKAGES} are allowed.`);
      packages.forEach((item, i) => {
        if (typeof item !== "string" || item.length > MAX_PACKAGE_LENGTH || !PACKAGE_PATTERN.test(item)) {
          fail(`packages[${i}]`, `must be a Debian package name (lowercase letters, digits and + - . only, not ending in -, optionally with :i386), e.g. libsdl2-2.0-0 or libc6:i386. Got ${JSON.stringify(item)}.`);
        }
      });
    }

    if (raw.variables !== undefined) {
      const keys = new Set<string>();
      list(raw.variables, "variables").forEach((item, i) => {
        const where = `variables[${i}]`;
        if (!isRecord(item)) return fail(where, "must be a mapping with a key and a type.");
        checkKeys(item, VARIABLE_KEYS, where);
        if (typeof item.key !== "string" || !KEY_PATTERN.test(item.key)) fail(`${where}.key`, "must start with a lowercase letter and use only lowercase letters, digits and underscores.");
        const key = item.key as string;
        if (keys.has(key)) fail(where, `declares the key "${key}" twice.`);
        keys.add(key);
        const at = `variable "${key}"`;
        if (!VARIABLE_TYPE_VALUES.includes(item.type as never)) fail(at, `needs a type, one of: ${VARIABLE_TYPE_VALUES.join(", ")}.`);
        str(item.label, `${at} label`);
        str(item.description, `${at} description`);
        str(item.unit, `${at} unit`);
        for (const flag of ["reinstall", "admin_only"] as const) {
          if (item[flag] !== undefined && typeof item[flag] !== "boolean") fail(`${at} ${flag}`, "must be true or false.");
        }
        if (item.options !== undefined) {
          if (item.type !== "select") fail(`${at} options`, "is only for type select.");
          const options = list(item.options, `${at} options`);
          options.forEach((option) => str(option, `${at} options`, false));
          if (options.length === 0) fail(`${at} options`, "needs at least one choice.");
        }
        if (item.options_from !== undefined) {
          if (item.type !== "select") fail(`${at} options_from`, "is only for type select.");
          if (!isRecord(item.options_from)) return fail(`${at} options_from`, "must be a mapping with a url.");
          const problem = OptionsFetcher.problem(item.options_from);
          if (problem) fail(`${at} options_from`, problem);
        }
        if (item.pattern !== undefined) {
          if (item.type !== "string" && item.type !== "select") fail(`${at} pattern`, "is only for type string or select.");
          if (typeof item.pattern !== "string") fail(`${at} pattern`, "must be a regular expression string.");
          const problem = Patterns.problem(item.pattern as string);
          if (problem) fail(`${at} pattern`, problem);
        }
        if (item.type === "select" && item.options === undefined && item.options_from === undefined) {
          fail(at, "is a select, so it needs \"options\" (or \"options_from\").");
        }
        for (const bound of ["min", "max"] as const) {
          if (item[bound] === undefined) continue;
          if (item.type !== "number") fail(`${at} ${bound}`, "is only for type number.");
          if (typeof item[bound] !== "number" || !Number.isFinite(item[bound])) fail(`${at} ${bound}`, "must be a number.");
        }
        if (typeof item.min === "number" && typeof item.max === "number" && item.min > item.max) fail(`${at} min`, `(${item.min}) is larger than max (${item.max}).`);
        if (item.bind !== undefined) {
          if (!VARIABLE_BIND_VALUES.includes(item.bind as never)) fail(`${at} bind`, `must be one of: ${VARIABLE_BIND_VALUES.join(", ")}.`);
          if (item.type !== "number") fail(`${at} bind`, "needs type number.");
        }
        if (item.generate !== undefined) {
          if (item.type !== "secret") fail(`${at} generate`, "is only for type secret.");
          if (!Number.isInteger(item.generate) || (item.generate as number) < 1 || (item.generate as number) > MAX_SECRET_LENGTH) {
            fail(`${at} generate`, `must be a whole number of characters between 1 and ${MAX_SECRET_LENGTH}.`);
          }
        }
        if (item.default !== undefined) {
          const value = item.default;
          const ok = item.type === "number" ? typeof value === "number" && Number.isFinite(value)
            : item.type === "boolean" ? typeof value === "boolean"
            : typeof value === "string";
          if (!ok) fail(`${at} default`, `must be a ${item.type === "select" || item.type === "secret" ? "string" : item.type}.`);
          if (item.type === "select" && Array.isArray(item.options) && item.options_from === undefined && !item.options.includes(value)) {
            fail(`${at} default`, `"${value}" is not one of the options (${item.options.join(", ")}).`);
          }
          if (typeof item.pattern === "string" && typeof value === "string" && item.options_from === undefined && !Patterns.matchesWhole(item.pattern, value)) {
            fail(`${at} default`, `"${value}" doesn't match the pattern ${item.pattern}.`);
          }
          if (typeof value === "number" && ((typeof item.min === "number" && value < item.min) || (typeof item.max === "number" && value > item.max))) {
            fail(`${at} default`, `${value} is outside min/max.`);
          }
        }
      });
    }

    if (raw.ports !== undefined) {
      const names = new Set<string>();
      list(raw.ports, "ports").forEach((item, i) => {
        const where = `ports[${i}]`;
        if (!isRecord(item)) return fail(where, "must be a mapping with a name and a proto.");
        checkKeys(item, PORT_KEYS, where);
        if (typeof item.name !== "string" || !KEY_PATTERN.test(item.name)) fail(`${where}.name`, "must start with a lowercase letter and use only lowercase letters, digits and underscores.");
        if (names.has(item.name as string)) fail(where, `declares the port "${item.name}" twice.`);
        names.add(item.name as string);
        if (!PORT_PROTO_VALUES.includes(item.proto as never)) fail(`port "${item.name}" proto`, "must be tcp or udp.");
        if (item.default !== undefined && (!Number.isInteger(item.default) || (item.default as number) < 1 || (item.default as number) > 65535)) {
          fail(`port "${item.name}" default`, "must be a port number from 1 to 65535.");
        }
        if (item.internal !== undefined && typeof item.internal !== "boolean") fail(`port "${item.name}" internal`, "must be true or false.");
      });
    }

    if (raw.install !== undefined) {
      list(raw.install, "install").forEach((item, i) => {
        const where = `install[${i}]`;
        if (!isRecord(item)) return fail(where, "must be a mapping with one step type, e.g. \"hook: hooks/install.sh\".");
        checkKeys(item, INSTALL_KEYS, where);
        const kinds = Object.keys(item);
        if (kinds.length !== 1) fail(where, `must have exactly one step type (${INSTALL_KEYS.join(", ")}), found ${kinds.length}.`);
        const kind = kinds[0];
        const step = item[kind];
        if (kind === "hook") return safePath(step, `${where}.hook`);
        if (!isRecord(step)) return fail(`${where}.${kind}`, "must be a mapping.");
        if (kind === "download") {
          str(step.url, `${where}.download.url`, false);
          if (typeof step.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(step.sha256)) fail(`${where}.download.sha256`, "must be 64 lowercase hex characters.");
          safePath(step.file, `${where}.download.file`);
        }
        else if (kind === "extract") {
          safePath(step.file, `${where}.extract.file`);
          if (step.to !== undefined) safePath(step.to, `${where}.extract.to`);
        }
        else if (kind === "write") {
          safePath(step.file, `${where}.write.file`);
          str(step.content, `${where}.write.content`, false);
        }
        else if (kind === "steamcmd") {
          checkKeys(step, ["app", "beta", "validate", "dir"], `${where}.steamcmd`);
          if (!Number.isInteger(step.app) || (step.app as number) < 1) fail(`${where}.steamcmd.app`, "must be the Steam app id (a whole number, e.g. 4020).");
          if (step.beta !== undefined && (typeof step.beta !== "string" || !STEAM_BETA_PATTERN.test(step.beta))) fail(`${where}.steamcmd.beta`, "must be a beta branch name (letters, digits, . _ -).");
          if (step.validate !== undefined && typeof step.validate !== "boolean") fail(`${where}.steamcmd.validate`, "must be true or false.");
          if (step.dir !== undefined) safePath(step.dir, `${where}.steamcmd.dir`);
        }
      });
    }

    if (raw.configs !== undefined) {
      list(raw.configs, "configs").forEach((item, i) => {
        const where = `configs[${i}]`;
        if (!isRecord(item)) return fail(where, "must be a mapping with a file and a format.");
        checkKeys(item, CONFIG_KEYS, where);
        safePath(item.file, `${where}.file`);
        if (!CONFIG_FORMAT_VALUES.includes(item.format as never)) fail(`${where}.format`, `must be one of: ${CONFIG_FORMAT_VALUES.join(", ")}.`);
        if (item.format === "template") safePath(item.template, `${where}.template`);
        else if (item.template !== undefined) fail(`${where}.template`, "is only for format template.");
        if (item.set !== undefined) {
          if (!isRecord(item.set)) return fail(`${where}.set`, "must be a mapping of key to string value (quote numbers and booleans).");
          for (const [key, value] of Object.entries(item.set)) {
            if (typeof value !== "string") fail(`${where}.set.${key}`, "must be a string (quote numbers and booleans, e.g. \"true\").");
            const keyPattern = item.format === "cfg" ? CFG_KEY_PATTERN : item.format === "ini" ? INI_KEY_PATTERN : item.format === "json" || item.format === "yaml" ? PATH_KEY_PATTERN : null;
            if (keyPattern && !keyPattern.test(key)) {
              fail(`${where}.set.${key}`, `isn't a valid key for the ${item.format} format${item.format === "json" || item.format === "yaml" ? " (a dotted path like server.motd)" : item.format === "ini" ? " (section.key, or just key)" : ""}.`);
            }
          }
        }
      });
    }

    if (raw.hooks !== undefined) {
      if (!isRecord(raw.hooks)) fail("hooks", "must be a mapping.");
      const hooks = raw.hooks as Record<string, unknown>;
      checkKeys(hooks, ["pre-start", "post-stop", "update"], "hooks");
      for (const [name, hook] of Object.entries(hooks)) safePath(hook, `hooks.${name}`);
    }
    if (raw.ready !== undefined) {
      if (!isRecord(raw.ready)) fail("ready", "must be a mapping with a log pattern.");
      str((raw.ready as Record<string, unknown>).log, "ready.log", false);
    }
    if (raw.stop !== undefined) {
      if (!isRecord(raw.stop)) fail("stop", "must be a mapping.");
      const stop = raw.stop as Record<string, unknown>;
      checkKeys(stop, ["command", "signal", "timeout"], "stop");
      str(stop.command, "stop.command");
      str(stop.signal, "stop.signal");
      if (stop.timeout !== undefined && (!Number.isInteger(stop.timeout) || (stop.timeout as number) < 1)) fail("stop.timeout", "must be a whole number of seconds.");
    }
    if (raw.console !== undefined) {
      if (!isRecord(raw.console)) fail("console", "must be a mapping with an input.");
      const consoleSpec = raw.console as Record<string, unknown>;
      checkKeys(consoleSpec, ["input", "rcon"], "console");
      if (!CONSOLE_INPUT_VALUES.includes(consoleSpec.input as never)) fail("console.input", `must be one of: ${CONSOLE_INPUT_VALUES.join(", ")}.`);
      if (consoleSpec.input === "rcon") {
        if (!isRecord(consoleSpec.rcon)) fail("console.rcon", "is required for input rcon: { port: \"{{ports.rcon}}\", password: \"{{vars.rcon_password}}\" }.");
        const rcon = consoleSpec.rcon as Record<string, unknown>;
        str(rcon.port, "console.rcon.port", false);
        str(rcon.password, "console.rcon.password", false);
      }
    }
    if (raw.players !== undefined) {
      if (!isRecord(raw.players)) fail("players", "must be a mapping with join and leave patterns.");
      const players = raw.players as Record<string, unknown>;
      checkKeys(players, ["join", "leave"], "players");
      str(players.join, "players.join");
      str(players.leave, "players.leave");
      for (const key of ["join", "leave"]) {
        const pattern = players[key];
        if (typeof pattern === "string" && !hasCaptureGroup(pattern)) {
          fail(`players.${key}`, "needs a capture group around the player name, e.g. '(\\w+) joined the game'.");
        }
      }
    }
    if (raw.backup !== undefined) {
      if (!isRecord(raw.backup)) fail("backup", "must be a mapping.");
      const backup = raw.backup as Record<string, unknown>;
      checkKeys(backup, ["before", "after", "exclude"], "backup");
      for (const key of ["before", "after", "exclude"]) {
        if (backup[key] !== undefined) list(backup[key], `backup.${key}`).forEach((item) => str(item, `backup.${key}`, false));
      }
    }
    if (raw.services !== undefined) {
      if (!isRecord(raw.services)) fail("services", "must be a mapping of host name to service.");
      const services = raw.services as Record<string, unknown>;
      if (Object.keys(services).length > MAX_SERVICES) fail("services", `lists ${Object.keys(services).length} services; at most ${MAX_SERVICES} are allowed.`);
      for (const [name, service] of Object.entries(services)) {
        const at = `services.${name}`;
        if (!SERVICE_NAME_PATTERN.test(name)) fail(at, "isn't a usable host name: use lowercase letters, digits and dashes, starting with a letter (e.g. db), at most 31 characters.");
        if (!isRecord(service)) return fail(at, "must be a mapping with an image.");
        checkKeys(service, ["image", "env", "volume", "command", "healthcheck", "limits"], at);
        str(service.image, `${at}.image`, false);
        const image = service.image as string;
        if (image.trim() === "" || image.length > 255 || /\s/.test(image) || image.startsWith("-")) fail(`${at}.image`, "must be an image reference like mariadb:11.4 (no spaces, not starting with a dash).");
        str(service.command, `${at}.command`);
        if (service.volume !== undefined) {
          // The agent wants a clean path (`path.Clean(v) === v`): no trailing slash, no empty, `.` or `..` segments.
          if (typeof service.volume !== "string" || !VOLUME_PATTERN.test(service.volume) || service.volume.slice(1).split("/").some((part) => part === "" || part === "." || part === "..")) {
            fail(`${at}.volume`, "must be a clean absolute path inside the container (no trailing /, // or . and .. parts), e.g. /var/lib/mysql.");
          }
        }
        if (service.env !== undefined) {
          if (!isRecord(service.env)) return fail(`${at}.env`, "must be a mapping of name to string.");
          const env = Object.entries(service.env);
          if (env.length > MAX_ENV_VARS) fail(`${at}.env`, `has ${env.length} variables; at most ${MAX_ENV_VARS} are allowed.`);
          for (const [key, value] of env) {
            if (!ENV_NAME_PATTERN.test(key)) fail(`${at}.env.${key}`, "isn't a valid environment variable name.");
            str(value, `${at}.env.${key}`, false);
            if ((value as string).length > MAX_ENV_VALUE) fail(`${at}.env.${key}`, `is longer than ${MAX_ENV_VALUE} characters.`);
          }
        }
        if (service.healthcheck !== undefined) {
          if (!isRecord(service.healthcheck)) return fail(`${at}.healthcheck`, "must be a mapping with a command.");
          const check = service.healthcheck as Record<string, unknown>;
          checkKeys(check, ["command", "interval", "retries", "startTimeout"], `${at}.healthcheck`);
          str(check.command, `${at}.healthcheck.command`, false);
          if ((check.command as string).trim() === "") fail(`${at}.healthcheck.command`, "can't be empty.");
          for (const [key, min, max] of [["interval", 1, 300], ["retries", 1, 100], ["startTimeout", 1, MAX_SERVICE_START_TIMEOUT]] as const) {
            if (check[key] !== undefined && (!Number.isInteger(check[key]) || (check[key] as number) < min || (check[key] as number) > max)) {
              fail(`${at}.healthcheck.${key}`, `must be a whole number from ${min} to ${max}.`);
            }
          }
        }
        if (service.limits !== undefined) {
          if (!isRecord(service.limits)) return fail(`${at}.limits`, "must be a mapping with memoryMb, cpuMillis and pids.");
          const limits = service.limits as Record<string, unknown>;
          checkKeys(limits, ["memoryMb", "cpuMillis", "pids"], `${at}.limits`);
          for (const [key, min, max] of [["memoryMb", 16, 65536], ["cpuMillis", 50, 64000], ["pids", 16, 32768]] as const) {
            if (limits[key] !== undefined && (!Number.isInteger(limits[key]) || (limits[key] as number) < min || (limits[key] as number) > max)) {
              fail(`${at}.limits.${key}`, `must be a whole number from ${min} to ${max}.`);
            }
          }
        }
      }
    }
    return raw as unknown as GameDefinition;
  }
  //#endregion

  //#region Extends
  /**
   * Merge `extends` chains: lists merge by `key` (variables) / `name` (ports) / `file` (configs) / position (install),
   * scalars override, small mappings (`hooks`, `stop`, `players`, `backup`) merge key by key. The result has no
   * `extends` and is validated like a plain definition.
   * @throws Error on a missing parent or a cycle.
   */
  export function resolve(definitions: Map<string, GameDefinition>, id: string): GameDefinition {
    const chain: GameDefinition[] = [];
    const seen: string[] = [];
    let current: string | undefined = id;
    let child = id;
    while (current !== undefined) {
      if (seen.includes(current)) throw new Error(`${id}/game.yml: the definitions ${[...seen, current].join(" → ")} extend each other in a cycle.`);
      const def = definitions.get(current);
      if (!def) {
        throw new Error(current === id
          ? `There is no definition "${id}" in this source.`
          : `${id}/game.yml: "${child}" extends "${current}", which is not in the same source (or failed validation).`);
      }
      seen.push(current);
      chain.unshift(def);
      child = current;
      current = def.extends;
    }
    let merged: GameDefinition = { id };
    for (const def of chain) merged = mergeDefinitions(merged, def);
    merged.id = id;
    delete merged.extends;
    validate(merged, `${id}/game.yml`);
    return merged;
  }

  function mergeDefinitions(parent: GameDefinition, child: GameDefinition): GameDefinition {
    const merged: GameDefinition = { ...parent, ...child };
    if (parent.packages || child.packages) merged.packages = [...new Set([...(parent.packages ?? []), ...(child.packages ?? [])])];
    if (parent.variables || child.variables) merged.variables = mergeBy(parent.variables, child.variables, (v) => v.key);
    if (parent.ports || child.ports) merged.ports = mergeBy(parent.ports, child.ports, (p) => p.name);
    if (parent.configs || child.configs) {
      merged.configs = mergeBy(parent.configs, child.configs, (c) => c.file, (p, c): ConfigMapping => {
        const config = { ...p, ...c };
        if (p.set || c.set) config.set = { ...p.set, ...c.set };
        return config;
      });
    }
    if (parent.install || child.install) {
      const install: InstallStep[] = [...(parent.install ?? [])];
      (child.install ?? []).forEach((step, i) => {
        install[i] = step;
      });
      merged.install = install;
    }
    for (const key of ["hooks", "stop", "players", "backup"] as const) {
      if (parent[key] || child[key]) (merged as unknown as Record<string, unknown>)[key] = { ...parent[key], ...child[key] };
    }
    if (parent.services || child.services) {
      const services: NonNullable<GameDefinition["services"]> = { ...parent.services };
      for (const [name, service] of Object.entries(child.services ?? {})) {
        const base = services[name];
        // A child that names a service of the parent changes only what it sets (env merges by name).
        services[name] = base === undefined ? service : {
          ...base,
          ...service,
          ...(base.env || service.env ? { env: { ...base.env, ...service.env } } : {}),
          ...(base.healthcheck || service.healthcheck ? { healthcheck: { ...base.healthcheck, ...service.healthcheck } as NonNullable<typeof service.healthcheck> } : {}),
          ...(base.limits || service.limits ? { limits: { ...base.limits, ...service.limits } } : {}),
        };
      }
      merged.services = services;
    }
    return merged;
  }

  function mergeBy<T>(parent: T[] | undefined, child: T[] | undefined, key: (item: T) => string, combine: (p: T, c: T) => T = (p, c) => ({ ...p, ...c })): T[] {
    const result = [...(parent ?? [])];
    for (const item of child ?? []) {
      const index = result.findIndex((existing) => key(existing) === key(item));
      if (index === -1) result.push(item);
      else result[index] = combine(result[index], item);
    }
    return result;
  }
  //#endregion

  //#region Variables and limits
  /**
   * Validate submitted values against the declarations and fill the rest: type checks (`number` finite, `select` in
   * `options`, `boolean`), unknown keys refused, `admin_only` refused for non-admins, defaults applied, `secret` with
   * `generate` created once (kept from `previous` when present; "" regenerates).
   * @param previous The server's stored values (settings change), or null at create.
   * @returns The complete values, and whether a `reinstall` variable changed against `previous`.
   * @throws HttpError 400 naming the variable.
   */
  export function resolveVariables(
    decls: VariableDecl[],
    submitted: Record<string, Value>,
    previous: Record<string, Value> | null,
    isAdmin: boolean,
  ): { values: Record<string, Value>; reinstall: boolean } {
    const byKey = new Map(decls.map((decl) => [decl.key, decl]));
    for (const key of Object.keys(submitted)) {
      if (!byKey.has(key)) throw HttpError.badRequest(`Unknown variable "${key}". This game has: ${decls.map((d) => d.key).join(", ") || "no variables"}.`);
    }

    const values: Record<string, Value> = {};
    let reinstall = false;
    for (const decl of decls) {
      const label = decl.label ?? decl.key;
      const given = Object.hasOwn(submitted, decl.key);
      if (given && decl.admin_only && !isAdmin) throw HttpError.forbidden(`Only administrators can change "${label}".`);

      let value: Value;
      if (given) {
        value = checkValue(decl, submitted[decl.key]);
        if (decl.type === "secret" && value === "" && decl.generate !== undefined) value = generateSecret(decl.generate);
      }
      else if (previous && Object.hasOwn(previous, decl.key)) value = previous[decl.key];
      else if (decl.default !== undefined) value = decl.default;
      else if (decl.type === "secret" && decl.generate !== undefined) value = generateSecret(decl.generate);
      else if (decl.type === "number") throw HttpError.badRequest(`"${label}" (${decl.key}) needs a value.`);
      else if (decl.type === "boolean") value = false;
      else if (decl.type === "select" && decl.options?.length) value = decl.options[0];
      else value = "";
      values[decl.key] = value;

      if (decl.reinstall && previous && Object.hasOwn(previous, decl.key) && previous[decl.key] !== value) reinstall = true;
    }
    return { values, reinstall };
  }

  /**
   * One submitted value as the declared type, or a 400.
   */
  function checkValue(decl: VariableDecl, value: unknown): Value {
    const label = `"${decl.label ?? decl.key}" (${decl.key})`;
    switch (decl.type) {
      case "number": {
        const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
        if (typeof number !== "number" || !Number.isFinite(number)) throw HttpError.badRequest(`${label} must be a number.`);
        if (decl.bind && (!Number.isInteger(number) || number < 1)) throw HttpError.badRequest(`${label} must be a whole number of at least 1.`);
        const unit = decl.unit ? ` ${decl.unit}` : "";
        if (decl.min !== undefined && number < decl.min) throw HttpError.badRequest(`${label} must be at least ${decl.min}${unit}.`);
        if (decl.max !== undefined && number > decl.max) throw HttpError.badRequest(`${label} can be at most ${decl.max}${unit}.`);
        return number;
      }
      case "boolean": {
        if (value === "true" || value === "false") return value === "true";
        if (typeof value !== "boolean") throw HttpError.badRequest(`${label} must be true or false.`);
        return value;
      }
      case "select": {
        if (typeof value !== "string" || value === "") throw HttpError.badRequest(`${label} must be one of its options.`);
        // With `options_from` the list is fetched: `GameServerService` checks it (`OptionsFetcher.isAllowed`).
        if (decl.options && !decl.options_from && !decl.options.includes(value)) throw HttpError.badRequest(`${label} must be one of: ${decl.options.join(", ")}.`);
        checkText(value, label);
        if (decl.pattern !== undefined && !decl.options_from) checkPattern(decl, value, label);
        return value;
      }
      default: // string, secret
        if (typeof value !== "string") throw HttpError.badRequest(`${label} must be text.`);
        // Length first: the pattern runs on a backtracking engine.
        checkText(value, label);
        if (decl.pattern !== undefined) checkPattern(decl, value, label);
        return value;
    }
  }

  function checkPattern(decl: VariableDecl, value: string, label: string): void {
    if (!Patterns.matchesWhole(decl.pattern!, value)) throw HttpError.badRequest(`${label} isn't in the expected format (${decl.pattern}).`);
  }

  function checkText(value: string, label: string): string {
    if (value.length > MAX_STRING_VALUE) throw HttpError.badRequest(`${label} can be at most ${MAX_STRING_VALUE} characters long.`);
    // Values end up in config files and shell commands: no line breaks or control characters.
    // deno-lint-ignore no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(value)) throw HttpError.badRequest(`${label} can't contain line breaks or control characters.`);
    return value;
  }

  /**
   * `length` random characters (letters and digits), from the system's CSPRNG without modulo bias.
   */
  export function generateSecret(length: number): string {
    let secret = "";
    const limit = 256 - (256 % SECRET_CHARS.length);
    while (secret.length < length) {
      for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
        if (byte >= limit) continue;
        secret += SECRET_CHARS[byte % SECRET_CHARS.length];
        if (secret.length === length) break;
      }
    }
    return secret;
  }

  /**
   * The limits implied by `bind` variables (limits.memory → memoryMb, limits.cpu → cpuMillis, limits.disk → diskMb;
   * the value is used as is, so a cpu variable counts in thousandths of a CPU), falling back to `defaults`.
   */
  export function resolveLimits(
    decls: VariableDecl[],
    values: Record<string, Value>,
    defaults: ServerSpec["limits"],
  ): ServerSpec["limits"] {
    const limits = { ...defaults };
    for (const decl of decls) {
      const value = values[decl.key];
      if (!decl.bind || typeof value !== "number") continue;
      if (decl.bind === "limits.memory") limits.memoryMb = value;
      else if (decl.bind === "limits.cpu") limits.cpuMillis = value;
      else limits.diskMb = value;
    }
    return limits;
  }

  /**
   * The memory and CPU a definition's stack services add on top of the game container's limits. Host capacity and
   * quota usage (M5) both count them.
   */
  export function serviceTotals(document: GameDefinition): { memoryMb: number; cpuMillis: number } {
    let memoryMb = 0;
    let cpuMillis = 0;
    for (const service of Object.values(document.services ?? {})) {
      memoryMb += service.limits?.memoryMb ?? DEFAULT_SERVICE_LIMITS.memoryMb;
      cpuMillis += service.limits?.cpuMillis ?? DEFAULT_SERVICE_LIMITS.cpuMillis;
    }
    return { memoryMb, cpuMillis };
  }
  //#endregion

  //#region Images and templates
  /**
   * Bare `ionnet-gss-*` names get IMAGE_REGISTRY (`ionnet-gss-base` → `ghcr.io/ionnet-dev/ionnet-gss-base:latest`);
   * anything with a registry or a slash is left alone. Applied after rendering.
   */
  export function resolveImage(image: string, registry: string): string {
    if (image.includes("/") || !image.startsWith("ionnet-gss-")) return image;
    const tagged = image.includes(":") ? image : `${image}:latest`;
    return `${registry.replace(/\/+$/, "")}/${tagged}`;
  }

  /**
   * Render `{{ path }}` and `{{ path|filter }}` placeholders (FILTERS). Unknown paths and filters throw, so a typo
   * fails at create, not at start.
   * @throws Error naming the placeholder.
   */
  export function render(template: string, ctx: TemplateContext): string {
    return template.replace(PLACEHOLDER, (_whole, inner: string) => {
      const { path, filter } = splitPlaceholder(inner);
      if (filter !== null && !Object.hasOwn(FILTERS, filter)) throw new Error(`"{{${inner}}}" uses the unknown filter "${filter}". Filters: ${Object.keys(FILTERS).join(", ")}.`);
      if (!PLACEHOLDER_PATH.test(path)) throw new Error(`"{{${path}}}" is not a placeholder. Use {{vars.<key>}}, {{ports.<name>}}, {{server.id}} or {{server.name}}.`);
      const [root, name] = path.split(".");
      const scope: Record<string, Value> | undefined = root === "vars" ? ctx.vars : root === "ports" ? ctx.ports : root === "server" ? ctx.server : undefined;
      if (path.split(".").length !== 2 || scope === undefined || !Object.hasOwn(scope, name)) {
        throw new Error(`The placeholder {{${path}}} has no value: ${root === "vars" ? "no such variable" : root === "ports" ? "no such port" : "unknown name"}.`);
      }
      return filter === null ? String(scope[name]) : FILTERS[filter](scope[name]);
    });
  }

  /**
   * `render` over every string inside a value (objects and lists are copied).
   */
  function renderDeep<T>(value: T, ctx: TemplateContext): T {
    if (typeof value === "string") return render(value, ctx) as T;
    if (Array.isArray(value)) return value.map((item) => renderDeep(item, ctx)) as T;
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderDeep(item, ctx)])) as T;
    }
    return value;
  }
  //#endregion

  //#region Spec
  /**
   * The full spec the agent gets in `server.provision`, and its hash (SHA-256 of canonical JSON: sorted keys).
   * @throws Error naming the problem (unknown placeholder, a referenced file missing from `files`, no `start`).
   */
  export async function buildSpec(input: BuildInput): Promise<{ spec: ServerSpec; specHash: string }> {
    const def = input.definition;
    const where = `${def.id}/game.yml`;
    if (typeof def.start !== "string" || def.start.trim() === "") throw new Error(`${where}: "start" is required.`);
    const ctx: TemplateContext = {
      vars: input.variables,
      ports: Object.fromEntries(input.ports.map((port) => [port.name, port.port])),
      server: { id: input.serverId, name: input.serverName },
    };
    const fileContent = (path: string): string => {
      const content = input.files[path];
      if (content === undefined) throw new Error(`${where}: the file "${path}" is referenced but missing from the definition folder.`);
      return content;
    };

    const image = resolveImage(render(def.image ?? DEFAULT_IMAGE, ctx), input.imageRegistry);
    const files: SpecFile[] = [...new Set(hookPaths(def))].sort().map((path) => ({ path, content: fileContent(path), executable: true }));
    const services = renderDeep(def.services ?? {}, ctx);
    for (const service of Object.values(services)) {
      service.image = resolveImage(service.image, input.imageRegistry);
      service.limits = { ...DEFAULT_SERVICE_LIMITS, ...service.limits };
    }

    const configs = (def.configs ?? []).map((config): ConfigMapping => {
      const rendered = renderDeep({ ...config }, ctx);
      if (config.format === "template") {
        delete rendered.template;
        rendered.content = render(fileContent(config.template as string), ctx);
      }
      return rendered;
    });

    const env: Record<string, string> = { GSS_SERVER_ID: input.serverId };
    for (const [key, value] of Object.entries(input.variables)) env[`GSS_VAR_${key.toUpperCase()}`] = String(value);
    for (const port of input.ports) env[`GSS_PORT_${port.name.toUpperCase()}`] = String(port.port);

    const spec: ServerSpec = {
      serverId: input.serverId,
      name: input.serverName,
      definition: { id: def.id, source: input.source, commit: input.commit },
      image,
      packages: def.packages ?? [],
      ports: input.ports,
      limits: input.limits,
      autostart: input.autostart,
      allowPrivateNetwork: input.allowPrivateNetwork,
      files,
      services,
      init: {
        serverId: input.serverId,
        install: renderDeep(def.install ?? [], ctx),
        configs,
        hooks: renderDeep(def.hooks ?? {}, ctx),
        start: render(def.start, ctx),
        ready: def.ready ? renderDeep(def.ready, ctx) : null,
        stop: renderDeep(def.stop ?? {}, ctx),
        console: renderDeep(def.console ?? { input: "stdin" }, ctx),
        players: def.players ? renderDeep(def.players, ctx) : null,
        env,
        autoRestart: { enabled: input.autoRestart, max: 3, windowSec: 600 },
        ...(def.install_timeout !== undefined ? { installTimeoutSec: def.install_timeout } : {}),
      },
    };
    if (def.backup) spec.backup = renderDeep(def.backup, ctx);
    return { spec, specHash: await sha256Hex(canonicalJson(spec)) };
  }

  /**
   * JSON with every object's keys sorted, so equal specs hash equally.
   */
  export function canonicalJson(value: unknown): string {
    return JSON.stringify(sortKeys(value));
  }

  function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sortKeys(item)]));
    }
    return value;
  }
  //#endregion
}

export default DefinitionEngine;
