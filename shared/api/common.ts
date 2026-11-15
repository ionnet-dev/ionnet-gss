/**
 * Shapes every route shares.
 */

/**
 * Body of every error response (400/401/403/404/409/500/501).
 */
export interface ErrorResponse {
  message: string;
}

/**
 * Body of a successful response with nothing else to say.
 */
export interface OkResponse {
  ok: true;
}

/**
 * Dates travel as ISO 8601 strings.
 */
export type IsoDate = string;
