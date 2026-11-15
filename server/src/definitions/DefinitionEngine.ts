/**
 * The definition engine (M2): game.yml → validated `GameDefinition` → resolved `ServerSpec` for one server.
 * Pure: no database, no agent. `ServerController` (M2) and the source sync (M3) call it.
 */
import { parse as parseYaml } from "@std/yaml";
import type { GameDefinition, PortBinding, ServerSpec } from "@shared/protocol/protocol.gen.ts";
import { HttpError } from "../lib/HttpError.ts";

export namespace DefinitionEngine {
  /**
   * Values `{{…}}` templates can read: `vars.<key>`, `ports.<name>`, `server.id`, `server.name`.
   */
  export interface TemplateContext {
    vars: Record<string, string | number | boolean>;
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
    variables: Record<string, string | number | boolean>; // Every value, defaults and generated secrets applied.
    ports: PortBinding[];
    limits: ServerSpec["limits"];
    autostart: boolean;
    autoRestart: boolean;
  }

  /**
   * Parse and validate one game.yml (structure per protocol/schema/definition.json, plus: unique variable keys and
   * port names, `select` has options or options_from, templates only reference declared vars and ports).
   * @throws Error with a readable message naming the file and the field.
   */
  export function parse(yamlText: string, path: string): GameDefinition {
    const raw = parseYaml(yamlText);
    throw HttpError.notImplemented("DefinitionEngine.parse"); // TODO(builder): M2
  }

  /**
   * Merge `extends` chains: lists merge by `key` (variables) / `name` (ports) / position (install), scalars override.
   * @throws Error on a missing parent or a cycle.
   */
  export function resolve(definitions: Map<string, GameDefinition>, id: string): GameDefinition {
    throw HttpError.notImplemented("DefinitionEngine.resolve"); // TODO(builder): M2
  }

  /**
   * Render `{{ path }}` placeholders. Unknown paths throw, so a typo fails at create, not at start.
   */
  export function render(template: string, ctx: TemplateContext): string {
    throw HttpError.notImplemented("DefinitionEngine.render"); // TODO(builder): M2
  }

  /**
   * The full spec the agent gets in `server.provision`, and its hash (SHA-256 of canonical JSON).
   */
  export async function buildSpec(input: BuildInput): Promise<{ spec: ServerSpec; specHash: string }> {
    throw HttpError.notImplemented("DefinitionEngine.buildSpec"); // TODO(builder): M2
  }
}

export default DefinitionEngine;
