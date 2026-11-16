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

  /**
   * PUT a raw text body (`text/plain; charset=utf-8`), e.g. the file editor's save (M4).
   */
  export async function PUT_TEXT<T>(path: string, text: string): Promise<T> {
    const sentToken = getToken();
    const res = await fetch(`/api${path}`, {
      method: "PUT",
      headers: { ...getHeaders(), "content-type": "text/plain; charset=utf-8" },
      body: text,
    });
    const raw = await res.text();
    let data: unknown = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      if (res.status === 401 && sentToken !== null && getToken() === sentToken) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
      throw new ApiError(res.status, (data as { message?: string } | null)?.message || res.statusText);
    }
    return data as T;
  }

  /**
   * PUT a file as the raw body with upload progress (M4). Uses XMLHttpRequest, because fetch can't report upload
   * progress. Same error handling as `request()` (`ApiError`, 401 event).
   * @param onProgress Bytes sent so far and the total.
   * @param signal Aborts the upload (the panel then discards the partial file).
   */
  export function UPLOAD<T>(path: string, file: Blob, onProgress?: (sent: number, total: number) => void, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("The upload was cancelled.", "AbortError"));
        return;
      }
      const sentToken = getToken();
      const xhr = new XMLHttpRequest();
      const onAbort = () => xhr.abort();
      xhr.open("PUT", `/api${path}`);
      for (const [name, value] of Object.entries(getHeaders())) xhr.setRequestHeader(name, value);
      xhr.setRequestHeader("content-type", "application/octet-stream");
      if (onProgress) xhr.upload.onprogress = (event) => onProgress(event.loaded, event.lengthComputable ? event.total : file.size);
      xhr.onload = () => {
        signal?.removeEventListener("abort", onAbort);
        let data: unknown = null;
        try {
          data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        } catch {
          data = null;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data as T);
          return;
        }
        if (xhr.status === 401 && sentToken !== null && getToken() === sentToken) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
        reject(new ApiError(xhr.status, (data as { message?: string } | null)?.message || xhr.statusText));
      };
      xhr.onerror = () => {
        signal?.removeEventListener("abort", onAbort);
        reject(new ApiError(0, "The upload failed: the connection to the panel was lost."));
      };
      xhr.onabort = () => {
        signal?.removeEventListener("abort", onAbort);
        reject(new DOMException("The upload was cancelled.", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      xhr.send(file);
    });
  }
}

export default BaseApi;
