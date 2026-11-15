/**
 * A small history-API router driven by a route table (`routes.tsx`): regex paths, lazily imported pages, and
 * requirement guards. No dependency. Main-session only.
 */
import { type AnchorHTMLAttributes, type MouseEvent, type ReactElement, useEffect, useState, useSyncExternalStore } from "react";

export interface RouteMatch {
  /**
   * The pathname, e.g. `/hosts/1f0e…`.
   */
  path: string;
  /**
   * Capture groups of the route's regex, in order.
   */
  params: string[];
  query: URLSearchParams;
}

export interface RouteDef {
  /**
   * Matched against the whole pathname (anchor it: `/^\/hosts\/([0-9a-f-]{36})$/`).
   */
  path: RegExp;
  /**
   * Lazily loads and renders the page (with its layout).
   */
  render: (match: RouteMatch) => Promise<ReactElement>;
  /**
   * Return a path to redirect to instead of rendering, or null to render. Set by `requirement()` in routes.tsx.
   */
  guard?: (match: RouteMatch) => string | null;
}

const NAVIGATE_EVENT = "gss:navigate";

/**
 * Go to `to` (path + optional query) without a page load.
 */
export function navigate(to: string, replace = false): void {
  if (to === location.pathname + location.search) return;
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

function subscribeLocation(listener: () => void): () => void {
  window.addEventListener("popstate", listener);
  window.addEventListener(NAVIGATE_EVENT, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(NAVIGATE_EVENT, listener);
  };
}

/**
 * The current `pathname + search`; re-renders on navigation.
 */
export function useLocation(): string {
  return useSyncExternalStore(subscribeLocation, () => location.pathname + location.search);
}

export interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  to: string;
}

/**
 * An `<a>` that navigates client-side (works as Iontronic's `render={<Link to="…" />}`).
 */
export function Link(props: LinkProps) {
  const { to, onClick, ...rest } = props;
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    navigate(to);
  };
  return <a {...rest} href={to} onClick={handleClick} />;
}

export interface RouterProps {
  routes: RouteDef[];
  /**
   * Rendered when no route matches.
   */
  notFound: (match: RouteMatch) => Promise<ReactElement>;
  /**
   * Shown while a page module loads.
   */
  loading?: ReactElement;
  /**
   * Bump to re-run guards (e.g. the auth controller's version), so sign-in/out redirects immediately.
   */
  guardKey?: unknown;
}

/**
 * Renders the first route whose regex matches the pathname.
 */
export function Router(props: RouterProps) {
  const { routes, notFound, loading = null, guardKey } = props;
  const current = useLocation();
  const [element, setElement] = useState<ReactElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const url = new URL(current, location.origin);
    let route: RouteDef | undefined;
    let params: string[] = [];
    for (const candidate of routes) {
      const result = candidate.path.exec(url.pathname);
      if (result) {
        route = candidate;
        params = result.slice(1).map((p) => decodeURIComponent(p ?? ""));
        break;
      }
    }
    const match: RouteMatch = { path: url.pathname, params, query: url.searchParams };
    const redirect = route?.guard?.(match) ?? null;
    if (redirect) {
      navigate(redirect, true);
      return;
    }
    (route ? route.render(match) : notFound(match)).then((rendered) => {
      if (!cancelled) setElement(rendered);
    });
    return () => {
      cancelled = true;
    };
  }, [current, routes, notFound, guardKey]);

  return element ?? loading;
}

export default Router;
