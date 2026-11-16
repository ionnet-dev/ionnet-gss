/**
 * Single-use download links. A browser download can't send `Authorization`, so an authorised `POST …/download` issues
 * a ticket (32 random bytes, base64url) and the browser opens `/api/downloads/<ticket>` itself, which streams through
 * the browser's download manager instead of a Blob in page memory. In memory only (one panel process); a panel
 * restart invalidates every ticket. `FileService` and `BackupService` issue them; `DownloadController` consumes them.
 */
import type { DownloadTicketResponse } from "@shared/api/files.ts";
import type { TransferRelay } from "./TransferRelay.ts";

export class DownloadTickets {
  private constructor() { }

  /**
   * Seconds a ticket stays valid.
   */
  public static readonly TTL_SEC = 60;

  private static _tickets = new Map<string, DownloadTickets.Grant>();

  /**
   * Store a grant and return its link. Sweeps expired tickets on the way.
   */
  public static issue(grant: Omit<DownloadTickets.Grant, "expiresAt">): DownloadTicketResponse {
    DownloadTickets._sweep();
    const ticket = crypto.getRandomValues(new Uint8Array(32)).toBase64({ alphabet: "base64url", omitPadding: true });
    const expiresAt = Date.now() + DownloadTickets.TTL_SEC * 1000;
    DownloadTickets._tickets.set(ticket, { ...grant, expiresAt });
    return { url: `/api/downloads/${ticket}`, expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * Take a ticket out (single use). null when unknown or expired.
   */
  public static consume(ticket: string): DownloadTickets.Grant | null {
    const grant = DownloadTickets._tickets.get(ticket);
    if (!grant) return null;
    DownloadTickets._tickets.delete(ticket);
    return grant.expiresAt > Date.now() ? grant : null;
  }

  /**
   * Drop expired tickets, so links nobody opened don't pile up.
   */
  private static _sweep(): void {
    const now = Date.now();
    for (const [ticket, grant] of DownloadTickets._tickets) {
      if (grant.expiresAt <= now) DownloadTickets._tickets.delete(ticket);
    }
  }
}

export namespace DownloadTickets {
  /**
   * What a ticket allows. Access was checked when it was issued.
   */
  export interface Grant {
    userId: number;
    hostId: string;
    source: TransferRelay.DownloadSource;
    fileName: string; // Content-Disposition name, e.g. `server.properties` or `My server-12.tar.zst`.
    expiresAt: number; // Unix ms.
  }
}

export default DownloadTickets;
