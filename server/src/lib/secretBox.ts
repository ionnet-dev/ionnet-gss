/**
 * Seals secrets the panel has to read back later (the SMTP password, M7) so the database never holds them in plain
 * text. AES-256-GCM with a key derived from `JWT_SECRET` (HKDF-SHA-256, info `"gss-settings-v1"`). WebCrypto only.
 *
 * A box looks like `v1.<iv base64url>.<ciphertext + tag base64url>`. Changing `JWT_SECRET` makes every box unreadable:
 * `open()` then returns null and the value has to be entered again.
 */
import { Config } from "../Config.ts";

const VERSION = "v1";
const HKDF_INFO = "gss-settings-v1";
const IV_BYTES = 12; // The GCM standard nonce size; random per box.
const TAG_BITS = 128;

let _key: Promise<CryptoKey> | null = null;

/**
 * The AES key, derived once per process.
 */
function key(): Promise<CryptoKey> {
  _key ??= (async () => {
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(Config.JWT_SECRET), "HKDF", false, ["deriveKey"]);
    return await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(HKDF_INFO) },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  })();
  _key.catch(() => _key = null); // Don't keep a failed derivation.
  return _key;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * @returns The bytes, or null when `text` isn't base64url.
 */
function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - text.length % 4) % 4);
  try {
    return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * Encrypt `plain` with a fresh random IV.
 * @returns The box to store: `v1.<iv>.<ciphertext>`.
 */
export async function seal(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: TAG_BITS }, await key(), new TextEncoder().encode(plain));
  return `${VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(cipher))}`;
}

/**
 * Decrypt a box made by `seal()`.
 * @returns The plain text, or null when the box is malformed, was tampered with or was sealed under another
 * `JWT_SECRET`.
 */
export async function open(box: string): Promise<string | null> {
  const parts = box.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const iv = fromBase64Url(parts[1]);
  const cipher = fromBase64Url(parts[2]);
  if (!iv || iv.length !== IV_BYTES || !cipher || cipher.length < TAG_BITS / 8) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, tagLength: TAG_BITS }, await key(), cipher);
    return new TextDecoder("utf-8", { fatal: true }).decode(plain);
  } catch {
    return null;
  }
}
