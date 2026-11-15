/**
 * In-memory fixed-window rate limiting for the public auth endpoints. One panel process, so memory is enough; a
 * restart resets the counters.
 */
import { HttpError } from "./HttpError.ts";

/**
 * Entries beyond this many trigger an early sweep, so a flood of distinct keys can't grow the map without bound.
 */
const MAX_KEYS = 50_000;

/**
 * Counts hits per key (an IP, a username) in fixed windows of `windowSec`. A key over `limit` is refused until its
 * window ends. A limit of 0 turns the limiter off.
 */
export class RateLimiter {
  private _windows = new Map<string, RateLimiter.Window>();
  private _sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    /** Hits allowed per key and window. 0 = unlimited. */
    public readonly limit: number,
    /** Window length in seconds. */
    public readonly windowSec: number,
    /** Shown in the 429 message, e.g. "sign-in attempts". */
    public readonly what: string,
  ) {}

  /**
   * Count one hit for `key`.
   * @throws HttpError 429 (with `retryAfterSec`) when the key is already at its limit; the refused hit isn't counted.
   */
  public hit(key: string): void {
    if (this.limit === 0) return;
    this.check(key);
    const window = this._current(key);
    if (window) window.count++;
    else this._windows.set(key, { count: 1, resetAt: Date.now() + this.windowSec * 1000 });
    this._ensureSweep();
  }

  /**
   * Like `hit()`, but without counting: for limits that only count failures.
   * @throws HttpError 429 when the key is at its limit.
   */
  public check(key: string): void {
    if (this.limit === 0) return;
    const window = this._current(key);
    if (window && window.count >= this.limit) {
      const retryAfterSec = Math.max(1, Math.ceil((window.resetAt - Date.now()) / 1000));
      throw HttpError.tooManyRequests(`Too many ${this.what}. Try again in ${RateLimiter.describe(retryAfterSec)}.`, retryAfterSec);
    }
  }

  /**
   * Forget `key`, e.g. a username's failures after a successful sign-in.
   */
  public reset(key: string): void {
    this._windows.delete(key);
  }

  /**
   * Stop the sweep timer (shutdown, scripts).
   */
  public stop(): void {
    if (this._sweepTimer !== null) clearInterval(this._sweepTimer);
    this._sweepTimer = null;
  }

  private _current(key: string): RateLimiter.Window | null {
    const window = this._windows.get(key);
    if (!window) return null;
    if (window.resetAt <= Date.now()) {
      this._windows.delete(key);
      return null;
    }
    return window;
  }

  private _ensureSweep(): void {
    if (this._windows.size > MAX_KEYS) this._sweep();
    if (this._sweepTimer !== null) return;
    const timer = setInterval(() => this._sweep(), 60_000);
    Deno.unrefTimer(timer); // Never keeps the process alive.
    this._sweepTimer = timer;
  }

  private _sweep(): void {
    const now = Date.now();
    for (const [key, window] of this._windows) {
      if (window.resetAt <= now) this._windows.delete(key);
    }
    // Still full of live windows: drop the oldest (a Map iterates in insertion order).
    for (const key of this._windows.keys()) {
      if (this._windows.size <= MAX_KEYS) break;
      this._windows.delete(key);
    }
  }

  private static describe(seconds: number): string {
    if (seconds < 90) return `${seconds} second${seconds === 1 ? "" : "s"}`;
    const minutes = Math.ceil(seconds / 60);
    return `${minutes} minutes`;
  }
}

export namespace RateLimiter {
  export interface Window {
    count: number;
    resetAt: number; // Unix ms.
  }
}

export default RateLimiter;
