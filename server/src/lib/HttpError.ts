/**
 * An error with an HTTP status. Models and controllers throw it; `App.ts` turns it into `{ message }` with the status.
 * Anything else that escapes a handler is logged and answered with a generic 500.
 */
export class HttpError extends Error {
  /**
   * Seconds until a 429 lifts, or null.
   */
  public retryAfterSec: number | null = null;

  constructor(
    /** HTTP status code (400, 401, 403, 404, 409, 501…). */
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }

  public static badRequest(message: string): HttpError {
    return new HttpError(400, message);
  }

  public static unauthorized(message = "Sign in to continue."): HttpError {
    return new HttpError(401, message);
  }

  public static forbidden(message = "You don't have permission to do that."): HttpError {
    return new HttpError(403, message);
  }

  public static notFound(message: string): HttpError {
    return new HttpError(404, message);
  }

  public static conflict(message: string): HttpError {
    return new HttpError(409, message);
  }

  /**
   * 413 for a request body over `BODY_LIMIT_KB`.
   */
  public static tooLarge(message: string): HttpError {
    return new HttpError(413, message);
  }

  /**
   * 429 from a rate limiter. `App.ts` adds a `Retry-After` header from `retryAfterSec`.
   * @param retryAfterSec Seconds until the limit lifts.
   */
  public static tooManyRequests(message: string, retryAfterSec: number): HttpError {
    const error = new HttpError(429, message);
    error.retryAfterSec = retryAfterSec;
    return error;
  }

  /**
   * For skeleton stubs. `what` names the route or method, e.g. `POST /api/auth/login`.
   */
  public static notImplemented(what: string): HttpError {
    return new HttpError(501, `${what} is not implemented yet.`);
  }
}

export default HttpError;
