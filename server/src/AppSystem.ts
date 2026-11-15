/**
 * App identity and data folders. Folders are created by `init()` at startup; under Docker `DATA_DIR` is a volume.
 */
import fsp from "node:fs/promises";
import Path from "node:path";
import { APP_NAME } from "@shared/constants.ts";
import { Config } from "./Config.ts";

export namespace AppSystem {
  export const name = APP_NAME;

  /**
   * Panel version, reported in `/api/meta` and the agent hello response.
   */
  export const version = "0.1.0";

  /**
   * Root data folder (`DATA_DIR`), absolute.
   */
  export const dataDir = Path.resolve(Config.DATA_DIR);

  /**
   * Clones of definition sources, one folder per source id (M3).
   */
  export const sourcesDir = Path.join(dataDir, "sources");

  /**
   * Create every data folder. Call once at startup.
   */
  export async function init(): Promise<void> {
    for (const dir of [dataDir, sourcesDir]) {
      await fsp.mkdir(dir, { recursive: true });
    }
  }
}

export default AppSystem;
