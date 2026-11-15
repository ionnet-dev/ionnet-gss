/**
 * Permission keys and the built-in roles. Roles hold keys; `admin` passes every check. More roles can be added as
 * rows later (a role may inherit another's keys).
 */

/**
 * Every permission key, with what it allows.
 */
export const PERMISSIONS = {
  HOSTS_VIEW: "See the hosts you are granted.",
  HOSTS_MANAGE: "Enrol, edit and remove hosts; manage port pools and host grants.",
  USERS_MANAGE: "Create, edit and disable users; set roles and quotas.",
  INVITES_MANAGE: "Create and revoke invites.",
  SOURCES_MANAGE: "Add, edit and sync definition sources.",
  SERVERS_CREATE: "Create game servers on granted hosts, within quota.",
  SERVERS_MANAGE_ALL: "See and operate every game server.",
  PORTS_OVERRIDE: "Pick a server's ports instead of the automatic allocation.",
  SERVERS_PRIVATE_NETWORK: "Let a game server open connections to private networks and the host (off by default).",
  AUDIT_VIEW: "Read the audit log.",
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as Permission[];

/**
 * Whether `value` is a known permission key.
 */
export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && value in PERMISSIONS;
}

/**
 * Names of the built-in roles, seeded by the first migration.
 */
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
} as const;

export type RoleName = typeof ROLES[keyof typeof ROLES];

/**
 * Permissions the seeded `user` role starts with. `admin` needs none: it passes every check.
 */
export const DEFAULT_USER_PERMISSIONS: readonly Permission[] = ["HOSTS_VIEW", "SERVERS_CREATE"];
