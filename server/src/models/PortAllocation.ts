import {
  type CreationOptional,
  DataTypes,
  type ForeignKey,
  type InferAttributes,
  type InferCreationAttributes,
  Model,
  type Sequelize,
  type Transaction,
} from "sequelize";
import { PORT_PROTO_VALUES, type PortDecl, type PortProto } from "@shared/protocol/protocol.gen.ts";
import { HttpError } from "../lib/HttpError.ts";
import { isInPool, parsePortPool } from "../lib/portPool.ts";
import { ID, uuidFk } from "./columns.ts";
import type { GameServer } from "./GameServer.ts";
import { Host } from "./Host.ts";

/**
 * A published port taken from a host's pool (M2). The same number is used on the host and inside the container.
 * Internal ports (`internal: true` in game.yml) need no allocation: each server has its own network.
 */
export class PortAllocation extends Model<InferAttributes<PortAllocation>, InferCreationAttributes<PortAllocation>> {
  declare id: CreationOptional<number>;
  declare hostId: ForeignKey<Host["id"]>;
  declare serverId: ForeignKey<GameServer["id"]>;
  declare name: string; // Port name from the definition, e.g. "game".
  declare proto: PortProto;
  declare port: number;
  declare pinned: CreationOptional<boolean>; // Chosen by an admin (PORTS_OVERRIDE) rather than allocated.
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  public static initModel(sequelize: Sequelize): void {
    PortAllocation.init({
      id: ID,
      hostId: uuidFk(false),
      serverId: uuidFk(false),
      name: { type: DataTypes.STRING(32), allowNull: false },
      proto: { type: DataTypes.ENUM(...PORT_PROTO_VALUES), allowNull: false },
      port: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      pinned: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    }, {
      sequelize,
      tableName: "port_allocations",
      indexes: [{ unique: true, fields: ["host_id", "proto", "port"] }],
    });
  }

  /**
   * Allocate every published port of a definition for a new server: the declared `default` when free and in the
   * pool, else the lowest free port in the pool. Internal ports are skipped. A port is free when no allocation holds
   * it and the host's last facts don't report it bound by other software (`facts.boundPorts`). The host row is locked
   * for the transaction, so two creates on one host take turns (and the unique index backs that up).
   * @param pinned PORTS_OVERRIDE: port name → number, taken as is (any number 1-65535) when free on the host.
   * @param exclude `proto/port` keys to skip as well, e.g. `udp/27015` after the agent answered `port_in_use`.
   * @throws HttpError 409 naming the pool when it is exhausted or a pinned port is taken; 400 for a bad pinned port.
   */
  public static async allocate(
    host: Host,
    serverId: string,
    ports: PortDecl[],
    transaction: Transaction,
    pinned?: Record<string, number>,
    exclude?: Iterable<string>,
  ): Promise<PortAllocation[]> {
    const published = ports.filter((port) => !port.internal);
    for (const name of Object.keys(pinned ?? {})) {
      if (!published.some((port) => port.name === name)) {
        throw HttpError.badRequest(`There is no published port "${name}" to pin. This game has: ${published.map((p) => p.name).join(", ") || "none"}.`);
      }
    }
    if (published.length === 0) return [];

    const locked = await Host.findByPk(host.id, { transaction, lock: transaction.LOCK.UPDATE });
    const ranges = parsePortPool(host.portPool);
    const taken = await PortAllocation.findAll({ where: { hostId: host.id }, attributes: ["proto", "port"], transaction });
    const used = new Set(taken.map((row) => `${row.proto}/${row.port}`));
    // Ports other software on the host holds (as of the last heartbeat) and ports the caller found taken.
    const bound = new Set([...PortAllocation.boundOn(locked ?? host), ...(exclude ?? [])]);

    const created: PortAllocation[] = [];
    for (const decl of published) {
      const key = (port: number) => `${decl.proto}/${port}`;
      let port: number | null = null;
      const wanted = pinned?.[decl.name];
      if (wanted !== undefined) {
        if (!Number.isInteger(wanted) || wanted < 1 || wanted > 65535) throw HttpError.badRequest(`The port for "${decl.name}" must be a number from 1 to 65535.`);
        if (used.has(key(wanted))) throw HttpError.conflict(`${decl.proto.toUpperCase()} port ${wanted} is already in use on ${host.name}.`);
        if (bound.has(key(wanted))) throw HttpError.conflict(`${decl.proto.toUpperCase()} port ${wanted} is already bound by other software on ${host.name}.`);
        port = wanted;
      }
      else if (decl.default !== undefined && isInPool(ranges, decl.default) && !used.has(key(decl.default)) && !bound.has(key(decl.default))) {
        port = decl.default;
      }
      else {
        search: for (const range of ranges) {
          for (let candidate = range.start; candidate <= range.end; candidate++) {
            if (!used.has(key(candidate)) && !bound.has(key(candidate))) {
              port = candidate;
              break search;
            }
          }
        }
      }
      if (port === null) {
        throw HttpError.conflict(`${host.name} has no free ${decl.proto.toUpperCase()} port left in its pool (${host.portPool}). Ask an administrator to widen the pool.`);
      }
      used.add(key(port));
      created.push(await PortAllocation.create({
        hostId: host.id,
        serverId,
        name: decl.name,
        proto: decl.proto,
        port,
        pinned: wanted !== undefined,
      }, { transaction }));
    }
    return created;
  }

  /**
   * `proto/port` keys the host's last facts report as bound (none from an agent that doesn't send `boundPorts`).
   */
  public static boundOn(host: Host): Set<string> {
    const ports = host.facts?.boundPorts ?? null;
    if (!ports) return new Set();
    return new Set([...ports.tcp.map((port) => `tcp/${port}`), ...ports.udp.map((port) => `udp/${port}`)]);
  }
}

export type PortAllocationAttributes = InferAttributes<PortAllocation>;
export default PortAllocation;
