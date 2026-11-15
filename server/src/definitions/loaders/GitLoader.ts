import fsp from "node:fs/promises";
import Path from "node:path";
import { AppSystem } from "../../AppSystem.ts";
import { Config } from "../../Config.ts";
import type { Source } from "../../models/Source.ts";
import type { DefinitionLoader, LoadResult, RawDefinitionFolder } from "./DefinitionLoader.ts";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES_PER_GAME = 200;
const MAX_DEPTH = 8;
const MAX_LISTING_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const BRANCH_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,127}$/;
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._ +@=-]+$/;
const SHA_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * Flags every git command runs with: https is the only transport, nothing in the repository can run code on the
 * panel (no hooks, no filters, no fsmonitor, no credential helpers, no submodules, no redirects to other hosts).
 */
const SAFE_FLAGS = [
  "-c", "protocol.allow=never",
  "-c", "protocol.https.allow=always",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.symlinks=false",
  "-c", "core.fsmonitor=false",
  "-c", "core.askPass=",
  "-c", "credential.helper=",
  "-c", "submodule.recurse=false",
  "-c", "http.followRedirects=false",
  "-c", "gc.autoDetach=false",
  "-c", "filter.lfs.smudge=",
  "-c", "filter.lfs.process=",
  "-c", "filter.lfs.required=false",
];

/**
 * One entry of `git ls-tree -r -l`.
 */
interface TreeEntry {
  mode: string;
  sha: string;
  size: number;
  path: string;
}

/**
 * A git source (M3): shallow, single-branch, no-checkout clone/fetch into `AppSystem.sourcesDir/<source id>` with the
 * `git` CLI. The working tree is never materialised: the definition files are read straight from the commit's objects
 * (`ls-tree` + `cat-file --batch`), so nothing in the repository (symlinks, attributes, filters, LFS, hooks) can act on
 * the panel host. Safety rules (all required):
 * - URL: `https://` only, no credentials in it, no whitespace or control characters; branch `^[A-Za-z0-9._/-]{1,128}$`
 *   without `..`, not starting with `-` or `/`; path is relative without `..`.
 * - Every command: `-c protocol.allow=never -c protocol.https.allow=always -c core.hooksPath=/dev/null …` (see
 *   `SAFE_FLAGS`), `--` before the URL and the branch; never `--recurse-submodules`. A repository with submodules is refused.
 * - Env: cleared, then `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `HOME` = a temp dir.
 * - Token: `http.extraHeader: Authorization: Basic base64("git:" + token)` through `GIT_CONFIG_*` environment
 *   variables (not argv, so other users can't read it from `/proc`), never written to `.git/config`, logs or errors.
 * - After a fetch, every ref points at the fetched commit and `gc --prune=now` drops earlier objects.
 * - Kill after SOURCE_GIT_TIMEOUT_SEC, and while it runs when the clone grows past twice SOURCE_MAX_MB; reject (and
 *   delete the clone) above SOURCE_MAX_MB or SOURCE_MAX_FILES in the commit's tree.
 * - Reading: skips symlinks, dotfiles and folders, files over 1 MiB and files that aren't UTF-8 text; commit = the
 *   fetched commit's hash.
 * Errors are readable sentences (they show on the Sources page), with the token redacted.
 */
export class GitLoader implements DefinitionLoader {
  public async load(source: Source): Promise<LoadResult> {
    const url = GitLoader.checkUrl(source.url);
    const branch = GitLoader.checkBranch(source.branch);
    const path = GitLoader.checkPath(source.path);
    const token = source.authToken ?? null;
    const dir = Path.join(AppSystem.sourcesDir, String(source.id));
    const home = await Deno.makeTempDir({ prefix: "gss-git-" });
    const git = new GitRunner(dir, home, token);
    try {
      let commit: string;
      try {
        commit = await GitLoader.update(git, dir, url, branch);
      } catch (error) {
        await fsp.rm(dir, { recursive: true, force: true });
        throw error;
      }
      const entries = await GitLoader.listTree(git, dir, commit);
      try {
        GitLoader.checkLimits(entries);
      } catch (error) {
        await fsp.rm(dir, { recursive: true, force: true });
        throw error;
      }
      const result = await GitLoader.readFolders(git, dir, entries, path);
      return { commit, ...result };
    } finally {
      await fsp.rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Delete a source's clone (the source was removed or its URL changed). Never throws.
   */
  public static async removeClone(sourceId: number): Promise<void> {
    await fsp.rm(Path.join(AppSystem.sourcesDir, String(sourceId)), { recursive: true, force: true }).catch(() => undefined);
  }

  //#region Validation
  /**
   * The URL as a git remote: `https://host[:port]/path`, nothing that git could read as an option, a user name or
   * another transport.
   * @throws Error saying what to change.
   */
  public static checkUrl(value: string): string {
    const url = typeof value === "string" ? value.trim() : "";
    // deno-lint-ignore no-control-regex
    if (url === "" || url.length > 512 || /[\s\u0000-\u001f\u007f\\]/.test(url)) {
      throw new Error("The repository URL must be one line without spaces, e.g. https://github.com/owner/repo.git.");
    }
    if (!url.startsWith("https://")) throw new Error("Only https:// repository URLs are supported (not http://, ssh://, file:// or git@host:path).");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("The repository URL isn't a valid URL. Use the form https://github.com/owner/repo.git.");
    }
    if (parsed.protocol !== "https:" || parsed.hostname === "") throw new Error("Only https:// repository URLs are supported.");
    if (parsed.username !== "" || parsed.password !== "" || url.slice(8).split("/")[0].includes("@")) {
      throw new Error("Don't put credentials in the repository URL. Use the token field for private repositories.");
    }
    if (parsed.hash !== "") throw new Error("The repository URL can't have a #fragment.");
    return url;
  }

  /**
   * A branch or tag name git accepts and that can't be read as an option or a path trick.
   * @throws Error saying what to change.
   */
  public static checkBranch(value: string): string {
    const branch = typeof value === "string" ? value.trim() : "";
    if (!BRANCH_PATTERN.test(branch) || branch.includes("..") || branch.includes("//") || branch.endsWith("/") || branch.endsWith(".lock") || branch.endsWith(".")) {
      throw new Error("The branch must be a plain name like main or releases/v1 (letters, digits, . _ - and /).");
    }
    return branch;
  }

  /**
   * The folder inside the repo that holds the game folders: "" or relative segments of safe characters.
   * @returns The path without leading or trailing slashes.
   * @throws Error saying what to change.
   */
  public static checkPath(value: string): string {
    const path = typeof value === "string" ? value.trim().replace(/^\/+|\/+$/g, "") : "";
    if (path === "") return "";
    if (path.length > 255 || path.includes("\\")) throw new Error("The subfolder must be a relative path like games or definitions/games.");
    for (const segment of path.split("/")) {
      if (segment === "" || segment === "." || segment === ".." || segment.startsWith(".") || !PATH_SEGMENT_PATTERN.test(segment)) {
        throw new Error("The subfolder must be a relative path like games or definitions/games (no \"..\", no hidden folders).");
      }
    }
    return path;
  }
  //#endregion

  //#region Clone and fetch
  /**
   * Clone the branch (shallow) or fetch it into the existing clone. Returns the commit hash of the branch's tip.
   */
  private static async update(git: GitRunner, dir: string, url: string, branch: string): Promise<string> {
    const exists = await fsp.stat(Path.join(dir, "HEAD")).then(() => true).catch(() => false);
    if (exists) {
      const current = (await git.run(["config", "--get", "remote.origin.url"]).catch(() => "")).trim();
      if (current === url) {
        await git.run(["fetch", "--depth", "1", "--no-tags", "--no-recurse-submodules", "--force", "--", "origin", branch]);
        const commit = await GitLoader.resolve(git, "FETCH_HEAD");
        await GitLoader.prune(git, commit);
        return commit;
      }
      await fsp.rm(dir, { recursive: true, force: true });
    }
    else {
      await fsp.rm(dir, { recursive: true, force: true });
    }
    await fsp.mkdir(Path.dirname(dir), { recursive: true });
    await git.run(["clone", "--bare", "--depth", "1", "--single-branch", "--no-tags", `--branch=${branch}`, "--", url, dir], false);
    return await GitLoader.resolve(git, "HEAD");
  }

  /**
   * Keep only the fetched commit: point every ref at it and drop the objects of earlier fetches, so the shallow clone
   * stays about one tree big instead of growing with each sync until the size kill.
   */
  private static async prune(git: GitRunner, commit: string): Promise<void> {
    const refs = (await git.run(["for-each-ref", "--format=%(refname)"])).split("\n").filter((ref) => ref !== "");
    const head = (await git.run(["symbolic-ref", "--quiet", "HEAD"]).catch(() => "")).trim();
    for (const ref of refs) {
      if (ref !== head) await git.run(["update-ref", "-d", "--", ref]);
    }
    if (head !== "") await git.run(["update-ref", "--no-deref", "--", head, commit]);
    else await git.run(["update-ref", "--no-deref", "--", "HEAD", commit]);
    await git.run(["reflog", "expire", "--expire=now", "--all"]);
    await git.run(["gc", "--prune=now", "--quiet"]);
  }

  private static async resolve(git: GitRunner, ref: string): Promise<string> {
    const sha = (await git.run(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
    if (!SHA_PATTERN.test(sha)) throw new Error("git didn't return a commit for the branch.");
    return sha;
  }
  //#endregion

  //#region Reading
  private static async listTree(git: GitRunner, _dir: string, commit: string): Promise<TreeEntry[]> {
    const out = await git.run(["ls-tree", "-r", "-l", "-z", "--full-tree", commit], true, MAX_LISTING_BYTES);
    const entries: TreeEntry[] = [];
    for (const record of out.split("\0")) {
      if (record === "") continue;
      const tab = record.indexOf("\t");
      if (tab < 0) continue;
      const [mode, type, sha, size] = record.slice(0, tab).trim().split(/\s+/);
      if (type === undefined || sha === undefined) continue;
      entries.push({ mode, sha, size: size === "-" ? 0 : Number(size), path: record.slice(tab + 1) });
    }
    return entries;
  }

  /**
   * @throws Error when the commit has submodules, or more files or bytes than SOURCE_MAX_FILES / SOURCE_MAX_MB.
   */
  private static checkLimits(entries: TreeEntry[]): void {
    if (entries.some((entry) => entry.mode === "160000" || entry.path === ".gitmodules")) {
      throw new Error("The repository uses submodules, which aren't supported (they would pull in code from other repositories). Copy the definitions into the repository.");
    }
    if (entries.length > Config.SOURCE_MAX_FILES) {
      throw new Error(`The repository has ${entries.length} files; the limit is ${Config.SOURCE_MAX_FILES} (SOURCE_MAX_FILES). Point the source at a repository that only holds definitions.`);
    }
    const bytes = entries.reduce((sum, entry) => sum + (Number.isFinite(entry.size) ? entry.size : 0), 0);
    if (bytes > Config.SOURCE_MAX_MB * 1024 * 1024) {
      throw new Error(`The repository holds ${Math.ceil(bytes / 1024 / 1024)} MB of files; the limit is ${Config.SOURCE_MAX_MB} MB (SOURCE_MAX_MB). Point the source at a repository that only holds definitions.`);
    }
  }

  /**
   * The game folders below `path`: one level of folders, each with a `game.yml`. Folders that break a per-game limit
   * are reported in `errors` instead of failing the whole source.
   */
  private static async readFolders(git: GitRunner, _dir: string, entries: TreeEntry[], path: string): Promise<{ folders: RawDefinitionFolder[]; errors: Record<string, string> }> {
    const prefix = path === "" ? "" : `${path}/`;
    const byGame = new Map<string, TreeEntry[]>();
    for (const entry of entries) {
      if (!entry.path.startsWith(prefix)) continue;
      const parts = entry.path.slice(prefix.length).split("/");
      if (parts.length < 2) continue; // A file next to the game folders.
      const [gameId, ...rest] = parts;
      if (gameId.startsWith(".") || rest.some((part) => part.startsWith("."))) continue;
      if (entry.mode === "120000") continue; // Symlinks are skipped.
      if (!entry.mode.startsWith("100")) continue;
      const list = byGame.get(gameId) ?? [];
      list.push(entry);
      byGame.set(gameId, list);
    }

    const folders: RawDefinitionFolder[] = [];
    const errors: Record<string, string> = {};
    const wanted: { gameId: string; relative: string; entry: TreeEntry }[] = [];
    for (const [gameId, list] of [...byGame].sort(([a], [b]) => a < b ? -1 : 1)) {
      if (!list.some((entry) => entry.path === `${prefix}${gameId}/game.yml`)) continue; // Not a game folder.
      const files = list.filter((entry) => entry.size <= MAX_FILE_BYTES);
      if (files.length > MAX_FILES_PER_GAME) {
        errors[gameId] = `${gameId}: the folder has more than ${MAX_FILES_PER_GAME} files.`;
        continue;
      }
      const tooDeep = files.find((entry) => entry.path.slice(prefix.length).split("/").length - 1 > MAX_DEPTH);
      if (tooDeep) {
        errors[gameId] = `${gameId}: "${tooDeep.path}" is nested deeper than ${MAX_DEPTH} folders.`;
        continue;
      }
      for (const entry of files) wanted.push({ gameId, relative: entry.path.slice(prefix.length + gameId.length + 1), entry });
    }

    const contents = await GitLoaderBatch.read(git, wanted.map((item) => item.entry));
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const filesByGame = new Map<string, Record<string, string>>();
    for (const item of wanted) {
      const bytes = contents.get(item.entry.sha);
      if (bytes === undefined) continue;
      let text: string;
      try {
        text = decoder.decode(bytes);
      } catch {
        continue; // Binary file.
      }
      const files = filesByGame.get(item.gameId) ?? {};
      files[item.relative] = text;
      filesByGame.set(item.gameId, files);
    }
    for (const [gameId, files] of filesByGame) {
      const gameYml = files["game.yml"];
      if (gameYml === undefined) {
        errors[gameId] = `${gameId}/game.yml is larger than 1 MiB or isn't UTF-8 text.`;
        continue;
      }
      delete files["game.yml"];
      folders.push({ gameId, gameYml, files });
    }
    return { folders, errors };
  }
  //#endregion

  //#region Errors
  /**
   * Turn git's stderr into a sentence for the Sources page.
   */
  public static explain(stderr: string, timedOut: boolean, tooBig: boolean): string {
    if (timedOut) return `git didn't finish within ${Config.SOURCE_GIT_TIMEOUT_SEC} seconds (SOURCE_GIT_TIMEOUT_SEC), so it was stopped. Is the repository very large or the host slow?`;
    if (tooBig) return `The repository download passed ${Config.SOURCE_MAX_MB * 2} MB, so it was stopped. Point the source at a repository that only holds definitions.`;
    const text = stderr.trim();
    if (/could not read (Username|Password)|Authentication failed|HTTP Basic: Access denied|401|403|terminal prompts disabled/i.test(text)) {
      return "The repository refused the request. It is private or the token is wrong or lacks read access: set a token on the source.";
    }
    if (/Repository not found|not found|404/i.test(text) && !/Remote branch/i.test(text)) return "The repository wasn't found. Check the URL (and add a token if it is private).";
    const branch = /Remote branch (\S+) not found/i.exec(text) ?? /couldn't find remote ref (\S+)/i.exec(text);
    if (branch) return `The branch "${branch[1]}" doesn't exist in the repository.`;
    if (/redirect|error: 30\d/i.test(text)) return "The repository answered with a redirect, which isn't followed. Use the repository's exact clone URL.";
    if (/Could not resolve host|unable to access|Failed to connect|SSL|certificate/i.test(text)) {
      return `The panel couldn't reach the repository: ${GitLoader.lastLine(text)}`;
    }
    return `git failed: ${GitLoader.lastLine(text) || "no details"}`;
  }

  private static lastLine(text: string): string {
    const lines = text.split("\n").map((line) => line.replace(/^(fatal|error):\s*/i, "").trim()).filter((line) => line !== "");
    return (lines.at(-1) ?? "").slice(0, 300);
  }
  //#endregion
}

/**
 * Reads blobs through one `git cat-file --batch`.
 */
namespace GitLoaderBatch {
  export async function read(git: GitRunner, entries: TreeEntry[]): Promise<Map<string, Uint8Array>> {
    const result = new Map<string, Uint8Array>();
    const shas = [...new Set(entries.map((entry) => entry.sha))];
    if (shas.length === 0) return result;
    const stdout = await git.pipe(["cat-file", "--batch"], shas.map((sha) => `${sha}\n`).join(""), Config.SOURCE_MAX_MB * 1024 * 1024 + shas.length * 128);
    let offset = 0;
    const decoder = new TextDecoder();
    for (const sha of shas) {
      const newline = stdout.indexOf(10, offset);
      if (newline < 0) break;
      const header = decoder.decode(stdout.subarray(offset, newline)).split(" ");
      offset = newline + 1;
      if (header[1] !== "blob") continue; // "missing"
      const size = Number(header[2]);
      if (!Number.isSafeInteger(size) || offset + size > stdout.length) break;
      result.set(sha, stdout.subarray(offset, offset + size));
      offset += size + 1;
    }
    return result;
  }
}

/**
 * Runs `git` with the safety flags and a clean environment; kills it at the timeout.
 */
class GitRunner {
  private static readonly _hasSetsid = Deno.build.os === "linux" && ["/usr/bin/setsid", "/bin/setsid"].some((path) => {
    try {
      return Deno.statSync(path).isFile;
    } catch {
      return false;
    }
  });

  constructor(private readonly _dir: string, private readonly _home: string, private readonly _token: string | null) { }

  /**
   * Run `git <SAFE_FLAGS> [-C dir] <args>` and return stdout as text.
   * @param inRepo Run inside the clone (`--git-dir`); false for `clone`, which creates it.
   */
  public async run(args: string[], inRepo = true, maxBytes = 1024 * 1024): Promise<string> {
    return new TextDecoder().decode(await this.pipe(args, "", maxBytes, inRepo));
  }

  /**
   * Like `run`, with stdin text, and stdout as bytes.
   */
  public async pipe(args: string[], stdin: string, maxBytes: number, inRepo = true): Promise<Uint8Array> {
    const full = [...SAFE_FLAGS, ...(inRepo ? ["--git-dir", this._dir] : []), ...args];
    const env: Record<string, string> = {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      HOME: this._home,
      LC_ALL: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_ALLOW_PROTOCOL: "https",
      GIT_PROTOCOL_FROM_USER: "0",
      GIT_LFS_SKIP_SMUDGE: "1",
      GIT_ASKPASS: "/bin/false",
    };
    for (const name of ["SSL_CERT_FILE", "SSL_CERT_DIR", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"]) {
      const value = Deno.env.get(name);
      if (value !== undefined) env[name] = value;
    }
    // libcurl ignores SSL_CERT_FILE; git reads its own variables. An operator with a private CA sets one of them.
    const caFile = Deno.env.get("GIT_SSL_CAINFO") ?? Deno.env.get("SSL_CERT_FILE");
    if (caFile !== undefined) env.GIT_SSL_CAINFO = caFile;
    const caDir = Deno.env.get("GIT_SSL_CAPATH") ?? Deno.env.get("SSL_CERT_DIR");
    if (caDir !== undefined) env.GIT_SSL_CAPATH = caDir;
    if (this._token !== null) {
      env.GIT_CONFIG_COUNT = "1";
      env.GIT_CONFIG_KEY_0 = "http.extraHeader";
      // HTTP Basic with the token as the password: what GitHub, GitLab, Gitea and Bitbucket accept for a PAT over
      // https (Bearer isn't universal for git-over-https).
      env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${btoa(`git:${this._token}`)}`;
    }

    let child: Deno.ChildProcess;
    try {
      // `setsid` gives git (and the helper process it starts) its own process group, so a timeout can kill them all.
      const grouped = GitRunner._hasSetsid;
      child = new Deno.Command(grouped ? "setsid" : "git", { args: grouped ? ["-w", "git", ...full] : full, env, clearEnv: true, stdin: "piped", stdout: "piped", stderr: "piped", cwd: this._home }).spawn();
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new Error("git isn't installed on the panel host. Install it (pacman -S git, or apt install git) and sync again.");
      }
      throw error;
    }

    let timedOut = false;
    let tooBig = false;
    let stop: (error: Error) => void = () => undefined;
    const stopped = new Promise<never>((_, reject) => {
      stop = reject;
    });
    stopped.catch(() => undefined);
    const killTree = () => {
      for (const target of [-child.pid, child.pid]) {
        try {
          Deno.kill(target, "SIGKILL");
        } catch { /* Already exited, or not a group. */ }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      stop(new Error(this._redact(GitLoader.explain("", true, false))));
    }, Config.SOURCE_GIT_TIMEOUT_SEC * 1000);
    // A clone can't be bounded by git itself: watch its folder while it runs.
    const watcher = args[0] === "clone" || args[0] === "fetch"
      ? setInterval(async () => {
        const size = await folderSize(this._dir);
        if (size > Config.SOURCE_MAX_MB * 2 * 1024 * 1024) {
          tooBig = true;
          killTree();
          stop(new Error(GitLoader.explain("", false, true)));
        }
      }, 500)
      : null;

    try {
      const writer = child.stdin.getWriter();
      const writing = (async () => {
        try {
          if (stdin !== "") await writer.write(new TextEncoder().encode(stdin));
          await writer.close();
        } catch { /* The process ended before reading everything. */ }
      })();
      const [out, err] = await Promise.race([Promise.all([collect(child.stdout, maxBytes), collect(child.stderr, MAX_STDERR_BYTES), writing]), stopped]);
      const status = await child.status;
      if (!status.success || out.truncated) {
        const stderr = new TextDecoder().decode(err.bytes);
        throw new Error(this._redact(out.truncated && !timedOut && !tooBig ? "git printed more than the panel accepts." : GitLoader.explain(stderr, timedOut, tooBig)));
      }
      return out.bytes;
    } finally {
      clearTimeout(timer);
      if (watcher !== null) clearInterval(watcher);
    }
  }

  private _redact(message: string): string {
    if (!this._token) return message;
    return message.replaceAll(this._token, "***").replaceAll(btoa(`git:${this._token}`), "***");
  }
}

/**
 * Read a stream up to `max` bytes; more sets `truncated` (and the rest is dropped).
 */
async function collect(stream: ReadableStream<Uint8Array>, max: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of stream) {
    if (total + chunk.length > max) {
      truncated = true;
      continue;
    }
    chunks.push(chunk);
    total += chunk.length;
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return { bytes, truncated };
}

/**
 * Total size of the files below `dir`; 0 when it doesn't exist (yet).
 */
async function folderSize(dir: string): Promise<number> {
  let total = 0;
  try {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const path = Path.join(dir, entry.name);
      if (entry.isDirectory()) total += await folderSize(path);
      else if (entry.isFile()) total += (await fsp.stat(path)).size;
    }
  } catch { /* Changing while git writes. */ }
  return total;
}

export default GitLoader;
