import { Config } from "../Config.ts";

/**
 * Whether PUBLIC_URL is plain http:// on a non-loopback host: the agent refuses that without `--insecure`, and the
 * install script and agent download can be altered in transit.
 */
export function isInsecurePanelUrl(): boolean {
  const url = new URL(Config.PUBLIC_URL);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || host === "::1";
  return url.protocol === "http:" && !loopback;
}
