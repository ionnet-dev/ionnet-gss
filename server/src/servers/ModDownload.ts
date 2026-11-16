/**
 * Byte streams the Mods tab relays to a host (`ModService`, `ModPackService`): catalog downloads, browser uploads and
 * files from a pack, never written to the panel's disk on the way. The panel only fetches https URLs on
 * MOD_CATALOG_HOSTS (`ModCatalog.fetchAllowed`), follows at most MAX_REDIRECTS redirects by hand (each target checked
 * again; the catalog's `headers`, e.g. CurseForge's key, only to the original host and hosts of the same site), asks for the raw bytes (`Accept-Encoding: identity`, so sizes and hashes
 * are the file's), and refuses files over UPLOAD_MAX_MB or of another size than the catalog announced.
 *
 * Every stream runs through `verify()`, which hashes it on the way (SHA-1 and SHA-512) and errors the stream at its
 * end when the size or an expected hash differs, when the source breaks, or when no data arrives for IDLE_MS.
 * `TransferRelay.upload` reads the body to its end before `transfer.commit`, so an erroring body closes the transfer
 * instead (the agent drops its temporary file): a bad file is never committed.
 */
import { createHash } from "node:crypto";
import { Config } from "../Config.ts";
import { HttpError } from "../lib/HttpError.ts";
import { ModCatalog } from "../mods/ModCatalog.ts";

export namespace ModDownload {
  /**
   * Most redirects followed for one download.
   */
  export const MAX_REDIRECTS = 3;
  /**
   * How long a whole download may take, headers and body.
   */
  export const TIMEOUT_MS = 10 * 60 * 1000;
  /**
   * How long a stream may go without data before it is given up.
   */
  export const IDLE_MS = 60 * 1000;

  /**
   * What the bytes must be. A null hash or size isn't checked (the digests are still computed).
   */
  export interface Expected {
    name: string;
    size: number | null;
    sha1: string | null;
    sha512: string | null;
  }

  export interface Digests {
    size: number;
    sha1: string; // Lowercase hex.
    sha512: string;
  }

  /**
   * A checked stream: hand `stream` to the consumer, then look at `failure()` when the consumer reports an error and
   * at `digests()` once it finished.
   */
  export interface Verified {
    stream: ReadableStream<Uint8Array>;
    /**
     * The check's own error once the stream failed it, else null. The consumer's error (the relay's "the upload
     * stopped") hides the reason, so callers rethrow this one instead.
     */
    failure(): HttpError | null;
    /**
     * Size and hashes once the stream ended cleanly, else null.
     */
    digests(): Digests | null;
  }

  /**
   * Fetch a catalog file and return its body behind `verify()`, with the size the relay must announce.
   * @throws HttpError 502 when the URL isn't allowed, a redirect leaves the allowed hosts, the answer isn't 200 or its
   * Content-Length differs from the catalog's size; 413 over UPLOAD_MAX_MB.
   */
  export async function open(file: { url: string; name: string; size: number; sha1: string; sha512: string | null; headers?: Record<string, string> }): Promise<Verified & { size: number }> {
    const maxBytes = Config.UPLOAD_MAX_MB * 1048576;
    if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new HttpError(502, `The catalog didn't say how large "${file.name}" is, so it can't be installed.`);
    if (file.size > maxBytes) throw HttpError.tooLarge(`"${file.name}" is ${Math.ceil(file.size / 1048576)} MB; files are limited to ${Config.UPLOAD_MAX_MB} MB (UPLOAD_MAX_MB).`);

    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const origin = hostname(file.url);
    let url = file.url;
    let res: Response | null = null;
    for (let redirects = 0; ; redirects++) {
      if (!ModCatalog.fetchAllowed(url)) {
        throw new HttpError(502, isPlainHttps(url)
          ? `The download of "${file.name}" points to ${hostOf(url)}, which isn't on MOD_CATALOG_HOSTS. Add the host there if you trust it.`
          : `The download of "${file.name}" isn't a plain https link (${hostOf(url)}), so the panel won't fetch it.`);
      }
      try {
        // The catalog's headers (CurseForge's key) only go to the original host or its sibling hosts.
        const headers = { ...(sameSite(origin, hostname(url)) ? file.headers : {}), "accept-encoding": "identity" };
        res = await fetch(url, { redirect: "manual", signal, headers });
      } catch (error) {
        throw new HttpError(502, `The download of "${file.name}" failed: ${signal.aborted ? "it took too long" : (error as Error).message}. Try again later.`);
      }
      if (res.status < 300 || res.status >= 400) break;
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => { });
      if (location === null) throw new HttpError(502, `The download of "${file.name}" was redirected without a target.`);
      if (redirects === MAX_REDIRECTS) throw new HttpError(502, `The download of "${file.name}" was redirected more than ${MAX_REDIRECTS} times.`);
      url = new URL(location, url).href; // Checked against the allowed hosts at the top of the loop.
    }
    if (res.status !== 200 || res.body === null) {
      await res.body?.cancel().catch(() => { });
      throw new HttpError(502, `The download of "${file.name}" failed: the catalog answered ${res.status}. Try again later.`);
    }
    const length = res.headers.get("content-length");
    if (length !== null && Number(length) !== file.size) {
      await res.body.cancel().catch(() => { });
      throw new HttpError(502, `The download of "${file.name}" is ${length} bytes, but the catalog said ${file.size}. Try again later.`);
    }
    return { ...verify(res.body, { name: file.name, size: file.size, sha1: file.sha1, sha512: file.sha512 }, "download"), size: file.size };
  }

  /**
   * The source's bytes as a new stream that hashes them on the way and errors (instead of closing) when the source
   * fails or stalls for IDLE_MS, when more bytes than `size` arrive, or at the end when the size or a hash differs.
   * @param what `download` (catalog files, 502) or `upload` (a browser's body, 400), for the messages.
   */
  export function verify(source: ReadableStream<Uint8Array>, expected: Expected, what: "download" | "upload" = "download"): Verified {
    const reader = source.getReader();
    const sha1 = createHash("sha1");
    const sha512 = createHash("sha512");
    let received = 0;
    let failure: HttpError | null = null;
    let digests: Digests | null = null;
    const fail = (reason: string): HttpError => {
      failure = what === "download"
        ? new HttpError(502, `The download of "${expected.name}" ${reason}, so it wasn't installed. Try again later.`)
        : HttpError.badRequest(`The upload of "${expected.name}" ${reason}. Try again.`);
      return failure;
    };
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          const idle = new Promise<never>((_, reject) => timer = setTimeout(() => reject(new Error("idle")), IDLE_MS));
          result = await Promise.race([reader.read(), idle]);
        } catch (error) {
          const stalled = (error as Error).message === "idle";
          reader.cancel().catch(() => { });
          controller.error(fail(stalled ? `stalled (no data for ${IDLE_MS / 1000} seconds)` : `was interrupted (${(error as Error).message})`));
          return;
        } finally {
          clearTimeout(timer);
        }
        if (result.done) {
          const sha1Hex = sha1.digest("hex");
          const sha512Hex = sha512.digest("hex");
          if (expected.size !== null && received !== expected.size) controller.error(fail(`stopped after ${received} of ${expected.size} bytes`));
          else if ((expected.sha512 !== null && sha512Hex !== expected.sha512.toLowerCase()) || (expected.sha1 !== null && sha1Hex !== expected.sha1.toLowerCase())) controller.error(fail("doesn't match the catalog's checksum"));
          else {
            digests = { size: received, sha1: sha1Hex, sha512: sha512Hex };
            controller.close();
          }
          return;
        }
        received += result.value.length;
        if (expected.size !== null && received > expected.size) {
          reader.cancel().catch(() => { });
          controller.error(fail(`is larger than the ${expected.size} bytes ${what === "download" ? "the catalog announced" : "its Content-Length says"}`));
          return;
        }
        sha1.update(result.value);
        sha512.update(result.value);
        controller.enqueue(result.value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return { stream, failure: () => failure, digests: () => digests };
  }

  /**
   * Whether two host names are the same, or share their last two labels (`edge.forgecdn.net` and
   * `mediafilez.forgecdn.net`).
   */
  export function sameSite(a: string, b: string): boolean {
    if (a === "" || b === "") return false;
    if (a === b) return true;
    const site = (host: string) => host.split(".").slice(-2).join(".");
    return a.includes(".") && b.includes(".") && site(a) === site(b);
  }

  function hostname(url: string): string {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return "";
    }
  }

  function isPlainHttps(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
    } catch {
      return false;
    }
  }

  function hostOf(url: string): string {
    try {
      return new URL(url).host || url;
    } catch {
      return `"${url}"`;
    }
  }
}

export default ModDownload;
