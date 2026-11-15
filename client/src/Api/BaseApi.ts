/**
 * The fetch wrapper every `XxxApi` builds on: holds the bearer token and the signed-in user in `localStorage`, adds
 * the headers, and turns `{ message }` error bodies into thrown `ApiError`s. Main-session only.
 */
import type { UserDto } from "@shared/api/users.ts";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export namespace BaseApi {
  const TOKEN_KEY = "gss-token";
  const USER_KEY = "gss-user";

  /**
   * Window event fired when a signed-in request gets a 401 (token expired or revoked). `AuthController` signs out.
   */
  export const UNAUTHORIZED_EVENT = "gss:unauthorized";

  export function getToken(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  }

  /**
   * The user stored with the token (may be stale; `AuthController.refresh()` updates it).
   */
  export function getUser(): UserDto | null {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as UserDto;
    } catch {
      return null;
    }
  }

  export function setSession(token: string, user: UserDto): void {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }

  export function setUser(user: UserDto): void {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }

  export function clearSession(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  export function getHeaders(json = false): Record<string, string> {
    const headers: Record<string, string> = { accept: "application/json" };
    const token = getToken();
    if (token) headers.authorization = `Bearer ${token}`;
    if (json) headers["content-type"] = "application/json";
    return headers;
  }

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const sentToken = getToken();
    const res = await fetch(`/api${path}`, {
      method,
      headers: getHeaders(body !== undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      // Only a 401 for the token still stored signs out: a request that raced a fresh session (own role change,
      // password change) carried the old one.
      if (res.status === 401 && sentToken !== null && getToken() === sentToken) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
      const message = (data as { message?: string } | null)?.message || res.statusText;
      throw new ApiError(res.status, message);
    }
    return data as T;
  }

  export function GET<T>(path: string): Promise<T> {
    return request<T>("GET", path);
  }

  export function POST<T>(path: string, body?: unknown): Promise<T> {
    return request<T>("POST", path, body ?? {});
  }

  export function PUT<T>(path: string, body?: unknown): Promise<T> {
    return request<T>("PUT", path, body ?? {});
  }

  export function PATCH<T>(path: string, body?: unknown): Promise<T> {
    return request<T>("PATCH", path, body ?? {});
  }

  export function DELETE<T>(path: string): Promise<T> {
    return request<T>("DELETE", path);
  }
}

export default BaseApi;
