/**
 * The route table. A new page: a folder in `pages/`, one entry here, and (for app pages) a nav item in
 * `components/AppLayout`. Main-session only.
 */
import type { ReactElement } from "react";
import type { Permission } from "@shared/permissions.ts";
import { authController } from "@/controllers/AuthController.ts";
import AppLayout from "@/components/AppLayout/AppLayout.tsx";
import AuthLayout from "@/components/AuthLayout/AuthLayout.tsx";
import type { RouteDef, RouteMatch } from "@/router/Router.tsx";

export interface Requirement {
  signedIn?: boolean; // Redirect to /login?redirect=… when signed out.
  signedOut?: boolean; // Redirect to homePath() when signed in (login, register).
  setup?: boolean; // Only while the panel has no user yet.
  permission?: Permission; // Redirect to homePath() without it.
}

/**
 * Where a signed-in user lands: the host list with HOSTS_VIEW, otherwise their account page, which every signed-in
 * user can open (so a guard never redirects to a page that redirects again).
 */
export function homePath(): string {
  return authController.has("HOSTS_VIEW") ? "/" : "/account";
}

/**
 * Wrap a route with an access guard. While `setupRequired`, every route but /setup redirects there.
 */
export function requirement(req: Requirement, route: RouteDef): RouteDef {
  return {
    ...route,
    guard: (match) => {
      const auth = authController;
      if (auth.setupRequired && !req.setup) return "/setup";
      if (req.setup && auth.setupRequired === false) return "/login";
      if (req.signedOut && auth.isSignedIn()) return homePath();
      if ((req.signedIn || req.permission) && !auth.isSignedIn()) {
        return `/login?redirect=${encodeURIComponent(match.path)}`;
      }
      if (req.permission && !auth.has(req.permission)) return homePath();
      return null;
    },
  };
}

type PageModule = { default: (props: { match: RouteMatch }) => ReactElement };

/**
 * A signed-in page inside the sidebar shell.
 */
function appPage(load: () => Promise<PageModule>) {
  return async (match: RouteMatch) => {
    const Page = (await load()).default;
    return <AppLayout><Page match={match} /></AppLayout>;
  };
}

/**
 * A signed-out page in the centered card layout.
 */
function authPage(load: () => Promise<PageModule>) {
  return async (match: RouteMatch) => {
    const Page = (await load()).default;
    return <AuthLayout><Page match={match} /></AuthLayout>;
  };
}

export const routes: RouteDef[] = [
  requirement({ setup: true }, { path: /^\/setup$/, render: authPage(() => import("./pages/Setup/Setup.tsx")) }),
  requirement({ signedOut: true }, { path: /^\/login$/, render: authPage(() => import("./pages/Login/Login.tsx")) }),
  requirement({ signedOut: true }, { path: /^\/register$/, render: authPage(() => import("./pages/Register/Register.tsx")) }),
  requirement({ permission: "HOSTS_VIEW" }, { path: /^\/(?:hosts)?$/, render: appPage(() => import("./pages/Hosts/Hosts.tsx")) }),
  requirement({ permission: "HOSTS_VIEW" }, { path: /^\/hosts\/([0-9a-f-]{36})$/, render: appPage(() => import("./pages/HostDetail/HostDetail.tsx")) }),
  requirement({ permission: "USERS_MANAGE" }, { path: /^\/users$/, render: appPage(() => import("./pages/Users/Users.tsx")) }),
  requirement({ permission: "INVITES_MANAGE" }, { path: /^\/invites$/, render: appPage(() => import("./pages/Invites/Invites.tsx")) }),
  requirement({ signedIn: true }, { path: /^\/account$/, render: appPage(() => import("./pages/Account/Account.tsx")) }),
  // M2: /servers, /servers/<uuid> (console, settings); M3: /sources; M4: /servers/<uuid>/files, /backups.
];

export const notFound = authPage(() => import("./pages/NotFound/NotFound.tsx"));
