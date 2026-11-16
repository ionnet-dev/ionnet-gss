/**
 * Modpack files for the Mods tab's import (pure apart from reading the one local file): a Modrinth `.mrpack`, a
 * CurseForge profile or modpack export (`manifest.json`, alone or inside its `.zip`), or any `.zip` of mod files (a
 * server pack). The service streams the upload to a temporary file first; `parse` reads it with random access (zip
 * central directory), never loads the whole archive into memory, and refuses anything unsafe or oversized with
 * `HttpError` 400 / 413 and a readable message.
 *
 * Paths are relative to the game's folder (`/data`), `/`-separated, cleaned: no absolute paths, `..`, `.` or empty
 * segments, backslashes, NUL, drive letters, or more than 512 bytes; such entries are dropped and named in `warnings`.
 * Limits: at most MAX_ENTRIES archive entries, MAX_UNPACKED_BYTES uncompressed in total, MAX_RATIO compression ratio
 * per entry (zip bombs), MAX_JSON_BYTES for an index or manifest. Zip64, encryption and compression other than
 * stored/deflate are refused.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import { pipeline } from "node:stream";
import zlib from "node:zlib";
import type { ModPackFormat } from "@shared/protocol/protocol.gen.ts";
import { HttpError } from "../lib/HttpError.ts";

export namespace ModPack {
  export const MAX_ENTRIES = 20000;
  export const MAX_UNPACKED_BYTES = 4 * 1024 * 1024 * 1024;
  export const MAX_RATIO = 200;
  export const MAX_JSON_BYTES = 8 * 1024 * 1024;

  export interface Parsed {
    format: ModPackFormat;
    name: string; // From the index/manifest, else the uploaded file's name without extension.
    version: string | null;
    gameVersion: string | null; // mrpack `dependencies.minecraft`, CurseForge `minecraft.version`.
    /**
     * Loader ids as the pack names them, e.g. mrpack `neoforge 21.1.77` (key + version), CurseForge `neoforge-21.1.77`.
     */
    loaders: string[];
    /**
     * The mods. For `zip`: every `.jar` (or other file) directly in a `mods/` folder, or at the archive root when the
     * archive has no `mods/` folder at all; the service then checks names against the folder's `match`.
     */
    mods: ModEntry[];
    /**
     * Every other file the pack would write: mrpack `overrides/` and `server-overrides/` (server wins), CurseForge
     * `overrides/` (or the folder its manifest names) and a plain zip's other files. Every mrpack `files[]` entry is a
     * `ModrinthMod` in `mods`, wherever its path points (it is downloaded, so it has no `open()`); the service routes
     * those by path.
     * The service keeps only those below the definition's `packs.overrides` folders.
     */
    files: FileEntry[];
    warnings: string[]; // e.g. "Skipped 2 entries with unsafe paths: ../x, /etc/y."
  }

  export type ModEntry = IncludedMod | ModrinthMod | CurseForgeMod;

  /**
   * A file inside the archive (a server pack's jar, or a jar a pack ships in its overrides' `mods/`).
   */
  export interface IncludedMod {
    kind: "included";
    path: string; // e.g. "mods/jei-1.21.1.jar"
    name: string; // The last segment.
    size: number;
    open(): ReadableStream<Uint8Array>; // Inflated contents; errors on a CRC or size mismatch.
  }

  /**
   * An mrpack `files[]` entry.
   */
  export interface ModrinthMod {
    kind: "modrinth";
    path: string; // e.g. "mods/sodium.jar" (mrpack paths may also be resourcepacks/… or config/…).
    name: string;
    size: number;
    sha1: string; // Lowercase hex (required by the format).
    sha512: string;
    urls: string[]; // `downloads`, in order; the service fetches only allowed hosts.
    side: "server" | "client" | "both" | null; // From `env`: server unsupported → client, client unsupported → server.
  }

  /**
   * A CurseForge manifest `files[]` entry: only ids, the file itself comes from the API with the operator's key.
   */
  export interface CurseForgeMod {
    kind: "curseforge";
    projectId: string; // `projectID`
    fileId: string; // `fileID`
    required: boolean;
  }

  export interface FileEntry {
    path: string;
    size: number;
    open(): ReadableStream<Uint8Array>;
  }

  /**
   * Parse the pack at `file` (a local temporary file) that was uploaded as `name`. The format comes from the content
   * (`modrinth.index.json` → mrpack, `manifest.json` with `manifestType: "minecraftModpack"` → curseforge, a bare JSON
   * file that is such a manifest → curseforge, other zips → zip), not the extension. `formats` are the folder's allowed
   * ones; another format is a 400 naming what the file is and what the folder takes.
   */
  export async function parse(file: string, name: string, formats: ModPackFormat[]): Promise<Parsed> {
    const warnings = new Warnings();
    const fallbackName = nameFromUpload(name);

    const handle = await fsp.open(file, "r");
    let archive: ZipArchive;
    try {
      const { size } = await handle.stat();
      const head = await readAt(handle, 0, Math.min(size, 4));
      if (!isZipSignature(head)) {
        const manifest = await readBareJson(handle, size, head);
        requireFormat("curseforge", formats);
        return parseCurseForge(manifest, null, "", fallbackName, warnings);
      }
      archive = await ZipArchive.read(handle, file, size, warnings);
    } finally {
      await handle.close();
    }

    // modrinth.index.json at the root → mrpack
    const index = archive.lookup(MRPACK_INDEX, "modrinth.index.json");
    if (index) {
      requireFormat("mrpack", formats);
      return parseMrpack(await archive.readJson(index, "modrinth.index.json"), archive, fallbackName, warnings);
    }

    // manifest.json at the root, or inside a single folder the export was zipped in → curseforge
    const top = commonTopFolder([...archive.entries.keys()]);
    for (const prefix of top === null ? [""] : ["", `${top}/`]) {
      const entry = archive.lookup(`${prefix}${CURSEFORGE_MANIFEST}`, "manifest.json");
      if (!entry) continue;
      const manifest = await archive.readJson(entry, "manifest.json");
      if (!isCurseForgeManifest(manifest)) continue;
      requireFormat("curseforge", formats);
      return parseCurseForge(manifest, archive, prefix, fallbackName, warnings);
    }

    requireFormat("zip", formats);
    return parseZip(archive, fallbackName, warnings);
  }
}

//#region Limits and constants

const MAX_PATH_BYTES = 512;
const MAX_TEXT_CHARS = 200; // Pack names and versions.
const MAX_PACK_FILES = 5000; // mrpack and CurseForge `files[]`.
const MAX_WARNING_NAMES = 10;
const MAX_URLS = 10;
const MAX_URL_CHARS = 2048;
const MAX_LOADERS = 16;
/**
 * Entries up to this size skip the ratio check: a small file that compresses very well (a blank lang file, a config
 * of zeros) is no bomb, and the total and per-entry declared sizes are still enforced while inflating.
 */
const RATIO_EXEMPT_BYTES = 1024 * 1024;
const MAX_CENTRAL_DIRECTORY_BYTES = 32 * 1024 * 1024;
/**
 * Compressed bytes read per step. Deflate tops out near 1032:1, so one step inflates at most ~16 MiB before the size
 * check sees it.
 */
const READ_CHUNK_BYTES = 16 * 1024;

const MRPACK_INDEX = "modrinth.index.json";
const CURSEFORGE_MANIFEST = "manifest.json";
const MRPACK_LOADERS = ["forge", "neoforge", "fabric-loader", "quilt-loader"];
const JUNK_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const HEX_SHA1 = /^[0-9a-f]{40}$/;
const HEX_SHA512 = /^[0-9a-f]{128}$/;
const VERSION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

// Zip record signatures
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const EOCD_BYTES = 22;
const CENTRAL_BYTES = 46;
const LOCAL_BYTES = 30;

// General purpose flags
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8 = 0x0800;
const FLAG_MASKED_HEADERS = 0x2000;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

const ENCODER = new TextEncoder();

const FORMAT_LABELS: Record<ModPackFormat, string> = {
  mrpack: "a Modrinth modpack (.mrpack)",
  curseforge: "a CurseForge modpack (manifest.json or its export zip)",
  zip: "a plain zip of mods (a server pack)",
};

//#endregion

//#region Zip reading

/**
 * One usable file in the archive, from the central directory (whose sizes and CRC are authoritative).
 */
interface ZipEntry {
  name: string; // The cleaned path.
  method: number;
  crc: number;
  compressedSize: number;
  size: number; // Declared uncompressed size.
  localOffset: number;
}

/**
 * A zip read through its central directory. Entries are opened lazily: each `open()` opens the file itself, so the
 * streams stay valid after `parse` returns, as long as the temporary file exists.
 */
class ZipArchive {
  private constructor(
    /** Path of the archive on disk. */
    public readonly file: string,
    /** Where the central directory starts; every entry's data must end before it. */
    public readonly dataEnd: number,
    /** Usable entries by path (directories, junk and unsafe paths removed; the last duplicate wins). */
    public readonly entries: Map<string, ZipEntry>,
    /** Entries refused for their compression ratio, by path. */
    public readonly refused: Map<string, ZipEntry>,
  ) { }

  /**
   * Read the End Of Central Directory record and the central directory of the zip open in `handle`.
   * @throws HttpError 400 for a corrupt, multi-disk, zip64, encrypted or unsupported archive, 413 over the limits.
   */
  public static async read(handle: fsp.FileHandle, file: string, fileSize: number, warnings: Warnings): Promise<ZipArchive> {
    if (fileSize < EOCD_BYTES) throw corrupt("it's too short to be a zip file");

    // The EOCD sits at the very end, after a comment of up to 65535 bytes.
    const tailLength = Math.min(fileSize, 0xFFFF + EOCD_BYTES);
    const tailStart = fileSize - tailLength;
    const tail = await readAt(handle, tailStart, tailLength);
    const tailView = view(tail);
    const eocd = findEocd(tailView);
    if (eocd < 0) throw corrupt("its end of central directory record is missing");
    const eocdPosition = tailStart + eocd;

    const disk = tailView.getUint16(eocd + 4, true);
    const centralDisk = tailView.getUint16(eocd + 6, true);
    const diskEntries = tailView.getUint16(eocd + 8, true);
    const totalEntries = tailView.getUint16(eocd + 10, true);
    const centralSize = tailView.getUint32(eocd + 12, true);
    const centralOffset = tailView.getUint32(eocd + 16, true);

    if (eocdPosition >= 20) {
      const locator = view(await readAt(handle, eocdPosition - 20, 4));
      if (locator.getUint32(0, true) === SIG_ZIP64_LOCATOR) throw zip64();
    }
    if (diskEntries === 0xFFFF || totalEntries === 0xFFFF || centralSize === 0xFFFFFFFF || centralOffset === 0xFFFFFFFF) {
      throw zip64();
    }
    if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
      throw HttpError.badRequest("This archive is split across several files (a multi-disk zip). Re-create it as a single zip file.");
    }
    if (totalEntries > ModPack.MAX_ENTRIES) {
      throw HttpError.tooLarge(`This archive has ${totalEntries} entries, more than the ${ModPack.MAX_ENTRIES} a modpack may have.`);
    }
    if (centralOffset + centralSize > eocdPosition) throw corrupt("its central directory points outside the file");
    if (centralSize > MAX_CENTRAL_DIRECTORY_BYTES) {
      throw HttpError.tooLarge(`This archive's file list is larger than ${formatBytes(MAX_CENTRAL_DIRECTORY_BYTES)}.`);
    }

    const central = await readAt(handle, centralOffset, centralSize);
    const centralView = view(central);
    const entries = new Map<string, ZipEntry>();
    const refused = new Map<string, ZipEntry>();
    let totalSize = 0;
    let position = 0;
    for (let i = 0; i < totalEntries; i++) {
      if (position + CENTRAL_BYTES > central.length || centralView.getUint32(position, true) !== SIG_CENTRAL) {
        throw corrupt("its central directory is damaged");
      }
      const flags = centralView.getUint16(position + 8, true);
      const method = centralView.getUint16(position + 10, true);
      const crc = centralView.getUint32(position + 16, true);
      const compressedSize = centralView.getUint32(position + 20, true);
      const size = centralView.getUint32(position + 24, true);
      const nameLength = centralView.getUint16(position + 28, true);
      const extraLength = centralView.getUint16(position + 30, true);
      const commentLength = centralView.getUint16(position + 32, true);
      const diskStart = centralView.getUint16(position + 34, true);
      const localOffset = centralView.getUint32(position + 42, true);
      const nameStart = position + CENTRAL_BYTES;
      position = nameStart + nameLength + extraLength + commentLength;
      if (position > central.length) throw corrupt("its central directory is damaged");

      if (compressedSize === 0xFFFFFFFF || size === 0xFFFFFFFF || localOffset === 0xFFFFFFFF || diskStart === 0xFFFF) {
        throw zip64();
      }
      if (diskStart !== 0) {
        throw HttpError.badRequest("This archive is split across several files (a multi-disk zip). Re-create it as a single zip file.");
      }

      const rawName = central.subarray(nameStart, nameStart + nameLength);
      const name = decodeName(rawName, flags);
      if (name === null) {
        warnings.add("encoding", latin1(rawName));
        continue;
      }
      if (name.endsWith("/")) continue; // Directory
      if (!isSafePath(name)) {
        warnings.add("unsafe", name);
        continue;
      }
      if (isJunk(name)) continue;

      if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION | FLAG_MASKED_HEADERS)) {
        throw HttpError.badRequest(`This archive is password-protected (${displayName(name)} is encrypted). Upload an unencrypted zip.`);
      }
      if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
        throw HttpError.badRequest(
          `${displayName(name)} in this archive uses ${methodName(method)} compression; only stored and deflate are supported. Re-create the zip with standard (deflate) compression.`,
        );
      }
      if ((flags & FLAG_DATA_DESCRIPTOR) && method === METHOD_DEFLATE && compressedSize === 0) {
        throw HttpError.badRequest(
          `This archive doesn't list the size of ${displayName(name)} in its central directory (it was written by a streaming zip tool). Re-create it with a standard zip tool.`,
        );
      }
      if (localOffset + LOCAL_BYTES + compressedSize > centralOffset) {
        throw corrupt(`${displayName(name)} points outside the archive's data`);
      }

      totalSize += size;
      if (totalSize > ModPack.MAX_UNPACKED_BYTES) {
        throw HttpError.tooLarge(`This archive unpacks to more than ${formatBytes(ModPack.MAX_UNPACKED_BYTES)}, the most a modpack may hold.`);
      }

      const entry: ZipEntry = { name, method, crc, compressedSize, size, localOffset };
      if (entries.delete(name) || refused.delete(name)) warnings.add("duplicate", name);
      if (size > RATIO_EXEMPT_BYTES && size / Math.max(compressedSize, 1) > ModPack.MAX_RATIO) {
        warnings.add("ratio", name);
        refused.set(name, entry);
      }
      else {
        entries.set(name, entry);
      }
    }

    return new ZipArchive(file, centralOffset, entries, refused);
  }

  /**
   * The usable entry at `path`, or null when there's none.
   * @param label What the entry is, for the error.
   * @throws HttpError 400 when that entry was refused as a possible zip bomb, since the pack can't be read without it.
   */
  public lookup(path: string, label: string): ZipEntry | null {
    if (this.refused.has(path)) {
      throw HttpError.badRequest(`This archive's ${label} unpacks to over ${ModPack.MAX_RATIO}× its compressed size, which looks like a zip bomb; refusing the archive.`);
    }
    return this.entries.get(path) ?? null;
  }

  /**
   * Read and parse a small JSON entry (an index or manifest), checking its CRC and size like any other entry.
   * @throws HttpError 413 over `MAX_JSON_BYTES`, 400 for a damaged entry or invalid JSON.
   */
  public async readJson(entry: ZipEntry, label: string): Promise<unknown> {
    if (entry.size > ModPack.MAX_JSON_BYTES) {
      throw HttpError.tooLarge(`${label} is ${formatBytes(entry.size)}, more than the ${formatBytes(ModPack.MAX_JSON_BYTES)} allowed.`);
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    const reader = this.open(entry).getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.byteLength;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return parseJsonText(new TextDecoder().decode(bytes), label);
  }

  /**
   * Stream an entry's contents: read the compressed range in chunks, inflate, and error the stream with an
   * `HttpError` 400 on a CRC mismatch, a length other than the declared size, or as soon as the output passes the
   * declared size (inflating stops right there). Nothing is opened until the first read.
   */
  public open(entry: ZipEntry): ReadableStream<Uint8Array> {
    let source: EntrySource | null = null;
    let crc = CRC_START;
    let produced = 0;
    const stop = () => source?.destroy();

    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          source ??= await this._openSource(entry);
          while (true) {
            const next = await source.iterator.next();
            if (next.done) {
              stop();
              if (produced !== entry.size) {
                throw HttpError.badRequest(`${displayName(entry.name)} in the archive is ${produced} bytes, not the ${entry.size} it declares; the archive is damaged.`);
              }
              if (crcFinish(crc) !== entry.crc) {
                throw HttpError.badRequest(`${displayName(entry.name)} in the archive is damaged (its CRC-32 checksum doesn't match).`);
              }
              controller.close();
              return;
            }
            const chunk = toBytes(next.value);
            if (chunk.byteLength === 0) continue;
            produced += chunk.byteLength;
            if (produced > entry.size) {
              throw HttpError.badRequest(
                `${displayName(entry.name)} in the archive unpacks to more than the ${entry.size} bytes it declares; refusing it as a possible zip bomb.`,
              );
            }
            crc = crcUpdate(crc, chunk);
            controller.enqueue(chunk);
            return;
          }
        } catch (error) {
          stop();
          controller.error(error instanceof Error ? error : new Error(String(error)));
        }
      },
      cancel: () => stop(),
    }, { highWaterMark: 0 });
  }

  /**
   * Find the entry's data after its local header and start reading (and inflating) its compressed range.
   */
  private async _openSource(entry: ZipEntry): Promise<EntrySource> {
    const handle = await fsp.open(this.file, "r");
    let header: DataView;
    try {
      header = view(await readAt(handle, entry.localOffset, LOCAL_BYTES));
    } finally {
      await handle.close();
    }
    if (header.getUint32(0, true) !== SIG_LOCAL) throw corrupt(`the local header of ${displayName(entry.name)} is missing`);
    const dataStart = entry.localOffset + LOCAL_BYTES + header.getUint16(26, true) + header.getUint16(28, true);
    if (dataStart + entry.compressedSize > this.dataEnd) throw corrupt(`${displayName(entry.name)} points outside the archive's data`);

    if (entry.compressedSize === 0) {
      if (entry.method === METHOD_DEFLATE) throw corrupt(`${displayName(entry.name)} has no compressed data`);
      return { iterator: emptyIterator(), destroy: () => { } };
    }

    const raw = fs.createReadStream(this.file, {
      start: dataStart,
      end: dataStart + entry.compressedSize - 1,
      highWaterMark: READ_CHUNK_BYTES,
    });
    if (entry.method === METHOD_STORED) {
      return { iterator: raw[Symbol.asyncIterator](), destroy: () => raw.destroy() };
    }

    const inflate = zlib.createInflateRaw();
    // Errors on either side destroy both; the inflate iterator then throws them.
    pipeline(raw, inflate, (error) => {
      if (error) inflate.destroy(error);
    });
    return {
      iterator: inflate[Symbol.asyncIterator](),
      destroy: () => {
        raw.destroy();
        inflate.destroy();
      },
    };
  }
}

/**
 * The raw chunks of one entry being read, and how to stop reading them.
 */
interface EntrySource {
  iterator: AsyncIterator<Uint8Array>;
  destroy(): void;
}

/**
 * Position of the EOCD record in `tail`, or -1. Prefers a record whose comment ends exactly at the end of the file,
 * so a signature inside the comment can't be mistaken for it.
 */
function findEocd(tail: DataView): number {
  for (const exact of [true, false]) {
    for (let i = tail.byteLength - EOCD_BYTES; i >= 0; i--) {
      if (tail.getUint32(i, true) !== SIG_EOCD) continue;
      const end = i + EOCD_BYTES + tail.getUint16(i + 20, true);
      if (exact ? end === tail.byteLength : end <= tail.byteLength) return i;
    }
  }
  return -1;
}

/**
 * Read exactly `length` bytes at `position`.
 * @throws HttpError 400 when the file ends first.
 */
async function readAt(handle: fsp.FileHandle, position: number, length: number): Promise<Uint8Array> {
  const buffer = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) throw corrupt("it ends unexpectedly");
    offset += bytesRead;
  }
  return buffer;
}

/**
 * The entry name as text: UTF-8 when flag bit 11 says so, else plain ASCII. Null for invalid UTF-8, or for non-ASCII
 * bytes without the flag (CP437 or a local code page, which can't be decoded reliably).
 */
function decodeName(raw: Uint8Array, flags: number): string | null {
  if (flags & FLAG_UTF8) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      return null;
    }
  }
  if (raw.some((byte) => byte >= 0x80)) return null;
  return latin1(raw);
}

function isZipSignature(head: Uint8Array): boolean {
  if (head.length < 4 || head[0] !== 0x50 || head[1] !== 0x4B) return false;
  return (head[2] === 0x03 && head[3] === 0x04) || (head[2] === 0x05 && head[3] === 0x06);
}

function methodName(method: number): string {
  switch (method) {
    case 12: return "bzip2";
    case 14: return "LZMA";
    case 93: return "Zstandard";
    case 95: return "XZ";
    case 98: return "PPMd";
    case 9: return "Deflate64";
    default: return `an unsupported (method ${method})`;
  }
}

function corrupt(reason: string): HttpError {
  return HttpError.badRequest(`This archive is damaged: ${reason}.`);
}

function zip64(): HttpError {
  return HttpError.badRequest("This archive uses zip64 (for zips over 4 GiB or 65535 entries), which isn't supported. Upload a smaller pack.");
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function toBytes(chunk: Uint8Array): Uint8Array {
  return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

function latin1(raw: Uint8Array): string {
  return new TextDecoder("latin1").decode(raw);
}

async function* emptyIterator(): AsyncGenerator<Uint8Array> { }

//#endregion

//#region CRC-32

const CRC_START = 0xFFFFFFFF;
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * Feed `data` into a running CRC-32 (IEEE, as zip uses) that started at `CRC_START`.
 */
function crcUpdate(crc: number, data: Uint8Array): number {
  let c = crc;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
  return c;
}

function crcFinish(crc: number): number {
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

//#endregion

//#region Formats

/**
 * Parse an mrpack: its `modrinth.index.json` gives the downloads, `overrides/` and `server-overrides/` the files.
 */
function parseMrpack(index: unknown, archive: ZipArchive, fallbackName: string, warnings: Warnings): ModPack.Parsed {
  if (!isObject(index)) throw HttpError.badRequest("modrinth.index.json isn't a JSON object.");
  if (index.formatVersion !== 1) {
    throw HttpError.badRequest(`This .mrpack uses format version ${displayValue(index.formatVersion)}, but only version 1 is supported.`);
  }
  if (index.game !== "minecraft") {
    throw HttpError.badRequest(`This .mrpack is for ${displayValue(index.game)}, not Minecraft.`);
  }

  // Dependencies
  let gameVersion: string | null = null;
  const loaders: string[] = [];
  if (isObject(index.dependencies)) {
    const dependencies = index.dependencies;
    if (dependencies.minecraft !== undefined) {
      gameVersion = versionToken(dependencies.minecraft);
      if (gameVersion === null) warnings.add("loader", `minecraft ${displayValue(dependencies.minecraft)}`);
    }
    for (const key of MRPACK_LOADERS) {
      if (dependencies[key] === undefined) continue;
      const version = versionToken(dependencies[key]);
      if (version === null) warnings.add("loader", `${key} ${displayValue(dependencies[key])}`);
      else loaders.push(`${key} ${version}`);
    }
  }

  // Downloads
  if (!Array.isArray(index.files)) throw HttpError.badRequest("modrinth.index.json has no `files` list.");
  if (index.files.length > MAX_PACK_FILES) {
    throw HttpError.tooLarge(`modrinth.index.json lists ${index.files.length} files, more than the ${MAX_PACK_FILES} a modpack may have.`);
  }
  const downloads = new Map<string, ModPack.ModrinthMod>();
  index.files.forEach((raw: unknown, i: number) => {
    const mod = parseMrpackFile(raw, i, warnings);
    if (!mod) return;
    if (downloads.delete(mod.path)) warnings.add("packDuplicate", mod.path);
    downloads.set(mod.path, mod);
  });

  // Overrides: server-overrides/ wins over overrides/ on the same path; client-overrides/ is for clients only.
  const overrides = new Map<string, ZipEntry>();
  for (const prefix of ["overrides/", "server-overrides/"]) {
    for (const [path, entry] of archive.entries) {
      if (path.startsWith(prefix)) overrides.set(path.slice(prefix.length), entry);
    }
  }

  const mods: ModPack.ModEntry[] = [];
  const files: ModPack.FileEntry[] = [];
  // Overrides are extracted after the downloads, so a file in them replaces a download on the same path.
  for (const mod of downloads.values()) {
    if (!overrides.has(mod.path)) mods.push(mod);
  }
  for (const [path, entry] of overrides) addArchiveFile(archive, path, entry, mods, files);

  return {
    format: "mrpack",
    name: cleanText(index.name) || fallbackName,
    version: cleanText(index.versionId),
    gameVersion,
    loaders,
    mods,
    files,
    warnings: warnings.toArray(),
  };
}

/**
 * One validated mrpack `files[]` entry, or null (with a warning) when it can't be used.
 */
function parseMrpackFile(raw: unknown, i: number, warnings: Warnings): ModPack.ModrinthMod | null {
  if (!isObject(raw) || typeof raw.path !== "string") {
    warnings.add("packEntry", `#${i + 1}`);
    return null;
  }
  const path = raw.path;
  if (!isSafePath(path)) {
    warnings.add("unsafe", path);
    return null;
  }

  const hashes = isObject(raw.hashes) ? raw.hashes : {};
  const sha1 = hashes.sha1;
  const sha512 = hashes.sha512;
  if (typeof sha1 !== "string" || !HEX_SHA1.test(sha1) || typeof sha512 !== "string" || !HEX_SHA512.test(sha512)) {
    warnings.add("packHash", path);
    return null;
  }

  const size = raw.fileSize;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > ModPack.MAX_UNPACKED_BYTES) {
    warnings.add("packSize", path);
    return null;
  }

  const urls: string[] = [];
  if (Array.isArray(raw.downloads)) {
    for (const url of raw.downloads) {
      if (urls.length >= MAX_URLS) break;
      if (isDownloadUrl(url)) urls.push(url);
    }
  }
  if (urls.length === 0) {
    warnings.add("packDownload", path);
    return null;
  }

  let side: ModPack.ModrinthMod["side"] = null;
  if (isObject(raw.env)) {
    if (raw.env.server === "unsupported") side = "client";
    else if (raw.env.client === "unsupported") side = "server";
    else side = "both";
  }

  return { kind: "modrinth", path, name: lastSegment(path), size, sha1, sha512, urls, side };
}

function isCurseForgeManifest(value: unknown): value is JsonObject {
  return isObject(value) && value.manifestType === "minecraftModpack";
}

/**
 * Parse a CurseForge manifest, plus its overrides folder from `archive` (null for a bare `manifest.json`).
 * @param prefix Where the manifest sits in the archive: "" or a wrapping folder like `MyPack/`.
 */
function parseCurseForge(manifest: JsonObject, archive: ZipArchive | null, prefix: string, fallbackName: string, warnings: Warnings): ModPack.Parsed {
  if (manifest.manifestVersion !== 1) {
    throw HttpError.badRequest(`This CurseForge manifest has version ${displayValue(manifest.manifestVersion)}, but only version 1 is supported.`);
  }

  // Minecraft and loaders
  let gameVersion: string | null = null;
  const loaders: string[] = [];
  if (isObject(manifest.minecraft)) {
    const minecraft = manifest.minecraft;
    if (minecraft.version !== undefined) {
      gameVersion = versionToken(minecraft.version);
      if (gameVersion === null) warnings.add("loader", `minecraft ${displayValue(minecraft.version)}`);
    }
    if (Array.isArray(minecraft.modLoaders)) {
      const primary: string[] = [];
      for (const loader of minecraft.modLoaders.slice(0, MAX_LOADERS)) {
        const id = isObject(loader) ? versionToken(loader.id) : null;
        if (id === null) {
          warnings.add("loader", isObject(loader) ? displayValue(loader.id) : displayValue(loader));
          continue;
        }
        if (loaders.includes(id) || primary.includes(id)) continue;
        if (isObject(loader) && loader.primary === true) primary.push(id);
        else loaders.push(id);
      }
      loaders.unshift(...primary);
    }
  }

  // Files
  if (manifest.files !== undefined && !Array.isArray(manifest.files)) throw HttpError.badRequest("manifest.json's `files` isn't a list.");
  const list: unknown[] = Array.isArray(manifest.files) ? manifest.files : [];
  if (list.length > MAX_PACK_FILES) {
    throw HttpError.tooLarge(`manifest.json lists ${list.length} files, more than the ${MAX_PACK_FILES} a modpack may have.`);
  }
  const byProject = new Map<string, ModPack.CurseForgeMod>();
  list.forEach((raw, i) => {
    const projectId = isObject(raw) ? curseForgeId(raw.projectID) : null;
    const fileId = isObject(raw) ? curseForgeId(raw.fileID) : null;
    if (!isObject(raw) || projectId === null || fileId === null) {
      warnings.add("curseforgeIds", `#${i + 1}`);
      return;
    }
    if (byProject.delete(projectId)) warnings.add("curseforgeDuplicate", projectId);
    byProject.set(projectId, { kind: "curseforge", projectId, fileId, required: raw.required !== false });
  });
  const mods: ModPack.ModEntry[] = [...byProject.values()];
  const files: ModPack.FileEntry[] = [];

  // Overrides
  if (archive) {
    const folder = manifest.overrides === undefined ? "overrides" : manifest.overrides;
    if (typeof folder !== "string" || !isSafePath(folder)) {
      throw HttpError.badRequest(`manifest.json names an unsafe overrides folder (${displayValue(folder)}).`);
    }
    const overridesPrefix = `${prefix}${folder}/`;
    for (const [path, entry] of archive.entries) {
      if (path.startsWith(overridesPrefix)) addArchiveFile(archive, path.slice(overridesPrefix.length), entry, mods, files);
    }
  }

  return {
    format: "curseforge",
    name: cleanText(manifest.name) || fallbackName,
    version: cleanText(manifest.version),
    gameVersion,
    loaders,
    mods,
    files,
    warnings: warnings.toArray(),
  };
}

/**
 * Parse any other zip: mods in a `mods/` folder (at the root or in the one folder that wraps the pack), or the files
 * at the root when there is no `mods/` folder; everything else as files.
 */
function parseZip(archive: ZipArchive, fallbackName: string, warnings: Warnings): ModPack.Parsed {
  const paths = [...archive.entries.keys()];
  let prefix = "";
  if (!paths.some((path) => isDirectMod(path))) {
    // A wrapping folder with a mods/ inside (`MyPack-Server-1.2/mods/…`); files outside it are dropped.
    const wrappers = new Set(paths.filter((path) => isDirectMod(path.slice(path.indexOf("/") + 1)) && path.indexOf("/") > 0)
      .map((path) => path.slice(0, path.indexOf("/") + 1)));
    if (wrappers.size === 1) {
      prefix = [...wrappers][0];
    }
    else {
      // A single folder of loose files (`MyMods/a.jar`, `MyMods/b.jar`).
      const top = commonTopFolder(paths);
      if (top !== null && top !== "mods" && paths.every((path) => !path.slice(top.length + 1).includes("/"))) prefix = `${top}/`;
    }
  }

  const inside = paths.filter((path) => path.startsWith(prefix));
  for (const path of paths) {
    if (!path.startsWith(prefix)) warnings.add("outside", path);
  }
  const relative = inside.map((path) => path.slice(prefix.length));
  const hasModsFolder = relative.some((path) => isDirectMod(path));

  const mods: ModPack.ModEntry[] = [];
  const files: ModPack.FileEntry[] = [];
  inside.forEach((path, i) => {
    const rel = relative[i];
    const entry = archive.entries.get(path)!;
    const isMod = hasModsFolder ? isDirectMod(rel) : !rel.includes("/");
    if (isMod) mods.push(includedMod(archive, rel, entry));
    else files.push({ path: rel, size: entry.size, open: () => archive.open(entry) });
  });

  if (mods.length === 0 && files.length === 0) {
    throw HttpError.badRequest(
      warnings.has("unsafe")
        ? "This archive has no files with safe paths (zips made with backslash separators, like old PowerShell `Compress-Archive`, can't be used; re-create it with 7-Zip or Explorer)."
        : "This archive has no files in it.",
    );
  }

  return { format: "zip", name: fallbackName, version: null, gameVersion: null, loaders: [], mods, files, warnings: warnings.toArray() };
}

/**
 * Sort one override file into `mods` (directly in `mods/`) or `files`.
 */
function addArchiveFile(archive: ZipArchive, path: string, entry: ZipEntry, mods: ModPack.ModEntry[], files: ModPack.FileEntry[]): void {
  if (isDirectMod(path)) mods.push(includedMod(archive, path, entry));
  else files.push({ path, size: entry.size, open: () => archive.open(entry) });
}

function includedMod(archive: ZipArchive, path: string, entry: ZipEntry): ModPack.IncludedMod {
  return { kind: "included", path, name: lastSegment(path), size: entry.size, open: () => archive.open(entry) };
}

/**
 * Read a non-zip upload as a bare CurseForge `manifest.json`.
 * @throws HttpError 400 "This isn't a modpack: …" for anything else, 413 for JSON over `MAX_JSON_BYTES`.
 */
async function readBareJson(handle: fsp.FileHandle, size: number, head: Uint8Array): Promise<JsonObject> {
  const kind = sniffNonZip(head);
  if (kind) throw HttpError.badRequest(`This isn't a modpack: it's ${kind}. Upload a .mrpack, a .zip or a CurseForge manifest.json.`);

  const probe = await readAt(handle, 0, Math.min(size, 64));
  const text = new TextDecoder().decode(probe).replace(/^﻿/, "").trimStart();
  if (!text.startsWith("{")) {
    throw HttpError.badRequest("This isn't a modpack: it's neither a zip archive (.mrpack or .zip) nor a CurseForge manifest.json.");
  }
  if (size > ModPack.MAX_JSON_BYTES) {
    throw HttpError.tooLarge(`This JSON file is ${formatBytes(size)}, more than the ${formatBytes(ModPack.MAX_JSON_BYTES)} a manifest may be.`);
  }

  const json = parseJsonText(new TextDecoder().decode(await readAt(handle, 0, size)), "The uploaded JSON file");
  if (isCurseForgeManifest(json)) return json;
  if (isObject(json) && "formatVersion" in json && "files" in json) {
    throw HttpError.badRequest("This is a Modrinth modrinth.index.json on its own. Upload the whole .mrpack file instead.");
  }
  throw HttpError.badRequest("This isn't a modpack: the JSON file isn't a CurseForge manifest.json (it has no `manifestType: \"minecraftModpack\"`).");
}

/**
 * Name a common non-zip archive by its magic bytes, for a clearer refusal.
 */
function sniffNonZip(head: Uint8Array): string | null {
  if (head[0] === 0x1F && head[1] === 0x8B) return "a gzip file (.gz or .tar.gz)";
  if (head[0] === 0x52 && head[1] === 0x61 && head[2] === 0x72 && head[3] === 0x21) return "a RAR archive";
  if (head[0] === 0x37 && head[1] === 0x7A && head[2] === 0xBC && head[3] === 0xAF) return "a 7-Zip archive";
  if (head[0] === 0x50 && head[1] === 0x4B) return "a damaged or self-extracting zip";
  return null;
}

/**
 * @throws HttpError 400 when `format` isn't one the folder accepts, naming both.
 */
function requireFormat(format: ModPackFormat, formats: ModPackFormat[]): void {
  if (formats.includes(format)) return;
  if (formats.length === 0) throw HttpError.badRequest(`This is ${FORMAT_LABELS[format]}, but this folder doesn't accept modpacks.`);
  const accepted = formats.map((f) => FORMAT_LABELS[f]);
  const list = accepted.length === 1 ? accepted[0] : `${accepted.slice(0, -1).join(", ")} or ${accepted[accepted.length - 1]}`;
  throw HttpError.badRequest(`This is ${FORMAT_LABELS[format]}, but this folder only accepts ${list}.`);
}

//#endregion

//#region Values and paths

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonText(text: string, label: string): unknown {
  try {
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw HttpError.badRequest(`${label} isn't valid JSON.`);
  }
}

/**
 * Whether `path` is a clean relative path: no absolute path, drive letter, `..`, `.` or empty segment, backslash,
 * NUL or other control character (C0, DEL, C1), bidirectional override or isolate (U+202A–U+202E, U+2066–U+2069, which
 * make a name read differently from what it is), and at most 512 bytes.
 */
function isSafePath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH_BYTES || ENCODER.encode(path).length > MAX_PATH_BYTES) return false;
  if (path.startsWith("/") || hasControlOrBackslash(path)) return false;
  const segments = path.split("/");
  if (/^[A-Za-z]:/.test(segments[0])) return false;
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function hasControlOrBackslash(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7F && code <= 0x9F) || code === 0x5C) return true;
    if ((code >= 0x202A && code <= 0x202E) || (code >= 0x2066 && code <= 0x2069)) return true;
  }
  return false;
}

/**
 * OS clutter that never belongs in a pack: macOS resource forks and Finder/Explorer metadata.
 */
function isJunk(path: string): boolean {
  const segments = path.split("/");
  return segments.includes("__MACOSX") || JUNK_NAMES.has(segments[segments.length - 1]);
}

/**
 * Whether `path` is a file directly in `mods/`.
 */
function isDirectMod(path: string): boolean {
  return path.startsWith("mods/") && path.indexOf("/", 5) === -1;
}

/**
 * The first segment every path shares, when each is below it; else null.
 */
function commonTopFolder(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const slash = paths[0].indexOf("/");
  if (slash <= 0) return null;
  const top = paths[0].slice(0, slash + 1);
  return paths.every((path) => path.startsWith(top)) ? top.slice(0, -1) : null;
}

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Untrusted text for a name or version: control characters become spaces, trimmed, at most 200 characters. Null when
 * it isn't a string or is empty.
 */
function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let text = "";
  for (const char of value.slice(0, MAX_TEXT_CHARS * 2)) {
    const code = char.charCodeAt(0);
    text += code < 0x20 || code === 0x7F ? " " : char;
  }
  text = Array.from(text.trim()).slice(0, MAX_TEXT_CHARS).join("").trim();
  return text.length > 0 ? text : null;
}

/**
 * A game or loader version like `1.21.1`, `neoforge-21.1.77` or `0.16.5+build.1`, or null when it isn't one.
 */
function versionToken(value: unknown): string | null {
  return typeof value === "string" && VERSION_TOKEN.test(value) ? value : null;
}

/**
 * A CurseForge project or file id (a positive integer) as a string, or null.
 */
function curseForgeId(value: unknown): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : null;
}

function isDownloadUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_URL_CHARS) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * The upload's file name without folders and extension, for packs whose index has no name.
 */
function nameFromUpload(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return cleanText(dot > 0 ? base.slice(0, dot) : base) ?? "Modpack";
}

/**
 * A short, printable form of an untrusted path or value for messages.
 */
function displayName(text: string): string {
  let safe = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    safe += code < 0x20 || code === 0x7F ? "?" : char;
  }
  return safe.length > 120 ? `${safe.slice(0, 117)}...` : safe;
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return `"${displayName(value)}"`;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  return value === undefined ? "none" : typeof value;
}

function formatBytes(bytes: number): string {
  const units = ["bytes", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[unit]}`;
}

//#endregion

//#region Warnings

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Each kind of dropped or ignored item, and its sentence from the count and the listed names.
 */
const WARNING_GROUPS = {
  unsafe: (n: number, list: string) => `Skipped ${plural(n, "entry", "entries")} with unsafe paths: ${list}.`,
  encoding: (n: number, list: string) =>
    `Skipped ${plural(n, "entry", "entries")} whose names aren't valid UTF-8 (or use non-ASCII characters without the zip's UTF-8 flag): ${list}.`,
  duplicate: (n: number, list: string) =>
    `${plural(n, "path appears", "paths appear")} more than once in the archive, so the last copy is used: ${list}.`,
  ratio: (n: number, list: string) =>
    `Skipped ${plural(n, "entry", "entries")} as possible zip bombs (over ${ModPack.MAX_RATIO}× the compressed size): ${list}.`,
  outside: (n: number, list: string) => `Skipped ${plural(n, "file", "files")} outside the pack's main folder: ${list}.`,
  packEntry: (n: number, list: string) => `Skipped ${plural(n, "files[] entry", "files[] entries")} in modrinth.index.json without a path: ${list}.`,
  packHash: (n: number, list: string) => `Skipped ${plural(n, "pack file", "pack files")} with missing or malformed SHA-1/SHA-512 hashes: ${list}.`,
  packSize: (n: number, list: string) => `Skipped ${plural(n, "pack file", "pack files")} with an invalid fileSize: ${list}.`,
  packDownload: (n: number, list: string) => `Skipped ${plural(n, "pack file", "pack files")} without a usable download URL: ${list}.`,
  packDuplicate: (n: number, list: string) =>
    `${plural(n, "pack file is", "pack files are")} listed more than once in modrinth.index.json, so the last entry is used: ${list}.`,
  curseforgeIds: (n: number, list: string) => `Skipped ${plural(n, "manifest file", "manifest files")} with invalid project or file ids: ${list}.`,
  curseforgeDuplicate: (n: number, list: string) =>
    `${plural(n, "CurseForge project is", "CurseForge projects are")} listed more than once in manifest.json, so the last file is used: ${list}.`,
  loader: (n: number, list: string) => `Ignored ${plural(n, "invalid game or loader version", "invalid game or loader versions")}: ${list}.`,
};

type WarningGroup = keyof typeof WARNING_GROUPS;

/**
 * Collects dropped items by kind, then words each kind as one sentence naming at most 10 of them.
 */
class Warnings {
  private _groups = new Map<WarningGroup, string[]>();

  public add(group: WarningGroup, name: string): void {
    const names = this._groups.get(group) ?? [];
    names.push(name);
    this._groups.set(group, names);
  }

  public has(group: WarningGroup): boolean {
    return this._groups.has(group);
  }

  public toArray(): string[] {
    return [...this._groups].map(([group, names]) => {
      let list = names.slice(0, MAX_WARNING_NAMES).map(displayName).join(", ");
      if (names.length > MAX_WARNING_NAMES) list += ` and ${names.length - MAX_WARNING_NAMES} more`;
      return WARNING_GROUPS[group](names.length, list);
    });
  }
}

//#endregion

export default ModPack;
