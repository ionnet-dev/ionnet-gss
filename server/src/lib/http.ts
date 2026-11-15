/**
 * Small helpers for Hono handlers: the app's context type, body parsing and path params.
 */
import type { Context } from "hono";
import type { User } from "../models/User.ts";
import { Config } from "../Config.ts";
import { HttpError } from "./HttpError.ts";

/**
 * Hono environment of every `/api` route. `user` is set by `User.$middleware()`.
 */
export interface AppEnv {
  Variables: {
    user: User;
  };
}

/**
 * Parse the JSON body as an object, or throw a 400. Validation of the fields is the handler's job.
 */
export async function readBody<T extends object>(c: Context): Promise<Partial<T>> {
  const body = await c.req.json().catch(() => null);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw HttpError.badRequest("The request body must be a JSON object.");
  }
  return body as Partial<T>;
}

/**
 * Like `readBody`, but an empty body counts as `{}`. For actions whose body only holds optional flags.
 */
export async function readOptionalBody<T extends object>(c: Context): Promise<Partial<T>> {
  const text = await c.req.text();
  if (text.trim() === "") return {};
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw HttpError.badRequest("The request body must be a JSON object.");
  }
  return body as Partial<T>;
}

/**
 * A positive integer path parameter, or a 400.
 */
export function paramInt(c: Context, name: string): number {
  const value = Number(c.req.param(name));
  if (!Number.isInteger(value) || value < 1) throw HttpError.badRequest(`"${name}" must be a positive whole number.`);
  return value;
}

/**
 * A UUID path parameter (hosts, game servers), or a 400.
 */
export function paramUuid(c: Context, name: string): string {
  const value = c.req.param(name) ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw HttpError.badRequest(`"${name}" must be a UUID.`);
  }
  return value.toLowerCase();
}

/**
 * The token of an `Authorization: Bearer <token>` header, or null.
 */
export function bearerToken(c: Context): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
  return match ? match[1] : null;
}

/**
 * The client's IP for the audit log. Honours X-Forwarded-For only with `TRUST_PROXY=true`.
 */
export function clientIp(c: Context): string | null {
  if (Config.TRUST_PROXY) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
    if (forwarded) return forwarded;
  }
  const info = (c.env as { remoteAddr?: { hostname?: string } } | undefined)?.remoteAddr;
  return info?.hostname ?? null;
}
