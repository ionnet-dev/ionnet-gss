/**
 * The operator's mod catalog credentials (Settings → Mod catalogs, `Setting` key `catalogs`): only CurseForge needs
 * one, the operator's own API key, stored sealed by `lib/secretBox.ts` like the SMTP password. The key reaches a
 * catalog only through `ModCatalog.Context.apiKey`; it is never sent to a browser, a host or the audit log.
 */
import type { ModCatalogProvider } from "@shared/protocol/protocol.gen.ts";
import { HttpError } from "../lib/HttpError.ts";
import * as secretBox from "../lib/secretBox.ts";
import { Setting } from "../models/index.ts";
import { isKeyRefusal } from "../mods/catalogs/CurseForge.ts";
import { ModCatalog } from "../mods/ModCatalog.ts";

export namespace ModCatalogKeys {
  /**
   * Longest key accepted (CurseForge keys are a 60-character bcrypt-like string).
   */
  export const MAX_KEY_CHARS = 256;
  /**
   * The game the key test searches (432 = Minecraft).
   */
  export const TEST_GAME_ID = 432;

  /**
   * Why a stored key can't be used: it can't be decrypted.
   */
  export const UNREADABLE = "The stored CurseForge key can't be read (the panel's secret changed); an administrator must enter it again under Settings → Mod catalogs.";

  /**
   * The decrypted key for `provider`, or null when none is stored or it can't be decrypted (JWT_SECRET changed).
   */
  export async function apiKey(provider: ModCatalogProvider): Promise<string | null> {
    return (await keyState(provider)).key;
  }

  /**
   * The decrypted key, and whether one is stored but unreadable.
   */
  export async function keyState(provider: ModCatalogProvider): Promise<{ key: string | null; unreadable: boolean }> {
    if (provider !== "curseforge") return { key: null, unreadable: false };
    const box = Setting.get("catalogs").curseforgeKeyBox;
    if (box === null) return { key: null, unreadable: false };
    const key = await secretBox.open(box);
    return { key, unreadable: key === null };
  }

  /**
   * A submitted key, trimmed: a printable single-line string of at most MAX_KEY_CHARS.
   * @throws HttpError 400.
   */
  export function cleanKey(value: unknown): string {
    if (typeof value !== "string") throw HttpError.badRequest("curseforgeApiKey must be a string, or null to remove the key.");
    const key = value.trim();
    // deno-lint-ignore no-control-regex
    if (key.length > MAX_KEY_CHARS || /[\s\u0000-\u001f\u007f]/.test(key)) {
      throw HttpError.badRequest(`curseforgeApiKey must be the key from console.curseforge.com: one line without spaces, at most ${MAX_KEY_CHARS} characters.`);
    }
    return key;
  }

  /**
   * Try a CurseForge key with one small search. `refused`: CurseForge said no (the key is wrong); `ok` false without
   * `refused`: CurseForge couldn't be asked (down, rate limited), which says nothing about the key.
   */
  export async function testCurseForge(key: string): Promise<{ ok: boolean; refused: boolean; message: string }> {
    const ctx: ModCatalog.Context = { projectType: "mc-mods", loaders: [], gameVersion: "", gameId: TEST_GAME_ID, apiKey: key };
    try {
      await ModCatalog.CATALOGS.curseforge.search(ctx, "", 0, 1);
      return { ok: true, refused: false, message: "CurseForge accepted the key." };
    } catch (error) {
      if (isKeyRefusal(error) || (error instanceof HttpError && (error.status === 401 || error.status === 403))) {
        return { ok: false, refused: true, message: "CurseForge refused the key. Copy it again from console.curseforge.com (API keys)." };
      }
      if (error instanceof HttpError) return { ok: false, refused: false, message: `CurseForge couldn't be reached to check the key: ${error.message}` };
      console.error("catalogs: the CurseForge key test failed", error);
      return { ok: false, refused: false, message: "CurseForge couldn't be reached to check the key. Check the panel's log for details." };
    }
  }
}

export default ModCatalogKeys;
