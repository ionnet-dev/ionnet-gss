import { HttpError } from "../../lib/HttpError.ts";
import type { Source } from "../../models/Source.ts";
import type { DefinitionLoader, LoadResult } from "./DefinitionLoader.ts";

/**
 * A git source (M3): shallow clone/fetch into `AppSystem.sourcesDir/<source id>` with the `git` CLI, then read the
 * folders below `source.path` like `LocalLoader`. Safety rules (all required):
 * - URL: `https://` only, no credentials in it, no `--`-leading or whitespace values; branch `^[A-Za-z0-9._/-]{1,128}$`
 *   without `..`; path is relative without `..`.
 * - `git -c protocol.allow=never -c protocol.https.allow=always -c core.hooksPath=/dev/null -c core.symlinks=false
 *   -c submodule.recurse=false -c http.followRedirects=false clone --depth 1 --single-branch --no-tags
 *   --branch <branch> -- <url> <dir>` (fetch + `reset --hard FETCH_HEAD` on later syncs); never `--recurse-submodules`.
 * - Env: `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `HOME` = a temp dir.
 * - Token: `-c http.extraHeader=Authorization: Bearer <token>` per command; never written to .git/config or logs.
 * - Kill after SOURCE_GIT_TIMEOUT_SEC; reject (and delete the clone) above SOURCE_MAX_MB or SOURCE_MAX_FILES.
 * - Reading: skip symlinks, dotfiles, files over 1 MiB; commit = `git rev-parse HEAD`.
 * Errors are readable sentences (they show on the Sources page), with the token redacted.
 */
export class GitLoader implements DefinitionLoader {
  public async load(source: Source): Promise<LoadResult> {
    throw HttpError.notImplemented("GitLoader.load"); // TODO(builder): C
  }
}

export default GitLoader;
