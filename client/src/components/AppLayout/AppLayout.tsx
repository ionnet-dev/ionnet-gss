import type { ReactNode } from "react";
import { AppShell, Icon, NavItem, NavSection, Sidebar, TabBar, TabBarItem } from "@ionnet/iontronic/react";
import { Gamepad2, Server, Ticket, UserRound, Users } from "@ionnet/iontronic/icons";
import { APP_NAME } from "@shared/constants.ts";
import { useAuth } from "@/hooks/useAuth.ts";
import { Link, useLocation } from "@/router/Router.tsx";

export interface AppLayoutProps {
  children: ReactNode;
}

/**
 * The signed-in shell: Sidebar on desktop, TabBar on phones (AppShell switches below 48rem).
 * Nav: Hosts; Manage (Users, Invites) by permission; Account in the footer. M2 adds Servers above Hosts.
 */
export default function AppLayout(props: AppLayoutProps) {
  const { children } = props;
  const auth = useAuth();
  const path = useLocation().split("?")[0];
  const onHosts = path.startsWith("/hosts");
  const onServers = path === "/" || path.startsWith("/servers");

  return (
    <AppShell
      sidebar={
        <Sidebar
          brand={APP_NAME}
          logo={<Icon icon={Gamepad2} size="md" />}
          footer={<NavItem icon={UserRound} label={auth.user?.username ?? "Account"} active={path === "/account"} href="/account" render={<Link to="/account" />} />}
        >
          <NavItem icon={Gamepad2} label="Servers" active={onServers} href="/servers" render={<Link to="/servers" />} />
          {auth.has("HOSTS_VIEW") && <NavItem icon={Server} label="Hosts" active={onHosts} href="/hosts" render={<Link to="/hosts" />} />}
          {(auth.has("USERS_MANAGE") || auth.has("INVITES_MANAGE")) && (
            <NavSection label="Manage">
              {auth.has("USERS_MANAGE") && <NavItem icon={Users} label="Users" active={path === "/users"} href="/users" render={<Link to="/users" />} />}
              {auth.has("INVITES_MANAGE") && <NavItem icon={Ticket} label="Invites" active={path === "/invites"} href="/invites" render={<Link to="/invites" />} />}
            </NavSection>
          )}
        </Sidebar>
      }
      tabBar={
        <TabBar aria-label="Main">
          <TabBarItem icon={Gamepad2} label="Servers" active={onServers} render={<Link to="/servers" />} />
          {auth.has("HOSTS_VIEW") && <TabBarItem icon={Server} label="Hosts" active={onHosts} render={<Link to="/hosts" />} />}
          {auth.has("USERS_MANAGE") && <TabBarItem icon={Users} label="Users" active={path === "/users"} render={<Link to="/users" />} />}
          {auth.has("INVITES_MANAGE") && <TabBarItem icon={Ticket} label="Invites" active={path === "/invites"} render={<Link to="/invites" />} />}
          <TabBarItem icon={UserRound} label="Account" active={path === "/account"} render={<Link to="/account" />} />
        </TabBar>
      }
    >
      {children}
    </AppShell>
  );
}
