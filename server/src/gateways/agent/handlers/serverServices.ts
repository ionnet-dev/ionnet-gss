import { SERVICE_STATE_VALUES, type ServicesChange, type ServiceStatus } from "@shared/protocol/protocol.gen.ts";
import { GameServerService } from "../../../servers/GameServerService.ts";
import { AgentRequestError, type AgentConnection } from "../AgentConnection.ts";
import { requireObject } from "./guards.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERVICE_NAME_PATTERN = /^[a-z]([a-z0-9-]{0,29}[a-z0-9])?$/;
const MAX_SERVICES = 4;
const MAX_IMAGE_CHARS = 255;

/**
 * A stack's service list as an agent reports it (in `hello` and in `server.services`): at most 4 services, DNS-label
 * names, an image string of at most 255 characters, a state from SERVICE_STATE_VALUES, an exit code that is a whole
 * number or null. An absent list (an agent without stacks) is empty.
 * @param what Where the list came from, for the error message.
 * @throws AgentRequestError `bad_request` naming the first bad entry.
 */
export function parseServices(value: unknown, what: string): ServiceStatus[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new AgentRequestError("bad_request", `${what} services must be a list.`);
  if (value.length > MAX_SERVICES) throw new AgentRequestError("bad_request", `${what} can list at most ${MAX_SERVICES} services.`);
  const seen = new Set<string>();
  return value.map((raw, i): ServiceStatus => {
    const service = requireObject<Partial<ServiceStatus>>(raw, `${what} services[${i}]`);
    const bad = (problem: string) => new AgentRequestError("bad_request", `${what} services[${i}]: ${problem}`);
    if (typeof service.name !== "string" || !SERVICE_NAME_PATTERN.test(service.name)) throw bad("name must be a host name like db.");
    if (seen.has(service.name)) throw bad(`the service "${service.name}" is listed twice.`);
    seen.add(service.name);
    if (typeof service.image !== "string" || service.image.length > MAX_IMAGE_CHARS) throw bad(`image must be a string of at most ${MAX_IMAGE_CHARS} characters.`);
    if (!SERVICE_STATE_VALUES.includes(service.state as never)) throw bad(`unknown state "${String(service.state)}".`);
    if (service.exitCode !== null && service.exitCode !== undefined && !Number.isSafeInteger(service.exitCode)) throw bad("exitCode must be a whole number or null.");
    return { name: service.name, image: service.image, state: service.state!, exitCode: service.exitCode ?? null };
  });
}

/**
 * `server.services` (M3): shape-check (serverId UUID, ≤ 4 services, name/image strings ≤ 255, state in
 * SERVICE_STATE_VALUES), then `GameServerService.applyServicesChange`.
 */
export async function handleServerServices(conn: AgentConnection, data: ServicesChange): Promise<void> {
  if (!conn.hostId) return;
  const event = requireObject<Partial<ServicesChange>>(data, "server.services");
  if (typeof event.serverId !== "string" || !UUID_PATTERN.test(event.serverId)) throw new AgentRequestError("bad_request", "server.services needs a serverId (UUID).");
  await GameServerService.applyServicesChange(conn.hostId, {
    serverId: event.serverId.toLowerCase(),
    services: parseServices(event.services, "server.services"),
  });
}
