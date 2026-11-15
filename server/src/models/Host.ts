import {
  type CreationOptional,
  DataTypes,
  type ForeignKey,
  type InferAttributes,
  type InferCreationAttributes,
  Model,
  type NonAttribute,
  type Sequelize,
} from "sequelize";
import type { HostDetailResponse, HostDto } from "@shared/api/hosts.ts";
import type { HostFacts } from "@shared/protocol/protocol.gen.ts";
import { TOKEN_PREFIX } from "@shared/constants.ts";
import { Config } from "../Config.ts";
import { HttpError } from "../lib/HttpError.ts";
import { digestEquals, randomToken, sha256Hex, tokenHint } from "../lib/tokens.ts";
import { intFk, jsonColumn, UUID_ID } from "./columns.ts";
import { EnrolToken } from "./EnrolToken.ts";
import type { HostGrant } from "./HostGrant.ts";
import type { User } from "./User.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A machine running `gss-agent`. Created by enrolment; authenticated afterwards by its long-lived credential
 * (`gss_host_…`), of which only the SHA-256 is stored. Online state lives in `AgentGateway`, not here.
 */
export class Host extends Model<InferAttributes<Host>, InferCreationAttributes<Host>> {
  declare id: CreationOptional<string>; // UUID
  declare name: string;
  declare address: string | null; // Address players connect to. null = facts.hostname.
  declare credentialHash: string;
  declare credentialHint: string;
  declare facts: HostFacts | null; // Last facts from enrol, hello or heartbeat.
  declare agentVersion: string | null;
  declare protocolVersion: number | null;
  declare portPool: string; // e.g. "25565-25664,27015-27064"; see lib/portPool.ts.
  declare maxMemoryMb: number | null; // null = facts.memory.totalBytes minus a reserve (M2 decides the reserve).
  declare maxCpuMillis: number | null; // null = facts.cpu.threads × 1000.
  declare maxDiskMb: number | null; // null = facts.disk.totalBytes.
  declare disabled: CreationOptional<boolean>; // Disabled hosts are refused at hello (CLOSE_REVOKED).
  declare enrolledById: ForeignKey<User["id"]> | null;
  declare lastSeenAt: Date | null;
  declare createdAt: CreationOptional<Date>; // = enrolled at
  declare updatedAt: CreationOptional<Date>;

  declare grants?: NonAttribute<HostGrant[]>;

  public static initModel(sequelize: Sequelize): void {
    Host.init({
      id: UUID_ID,
      name: { type: DataTypes.STRING(64), allowNull: false },
      address: { type: DataTypes.STRING(255), allowNull: true },
      credentialHash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
      credentialHint: { type: DataTypes.STRING(16), allowNull: false },
      facts: jsonColumn("facts", true, null),
      agentVersion: { type: DataTypes.STRING(32), allowNull: true },
      protocolVersion: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      portPool: { type: DataTypes.STRING(255), allowNull: false },
      maxMemoryMb: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      maxCpuMillis: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      maxDiskMb: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      disabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      enrolledById: intFk(true),
      lastSeenAt: { type: DataTypes.DATE, allowNull: true },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    }, { sequelize, tableName: "hosts" });
  }

  /**
   * Redeem an enrol token: create the host (name = token name ?? facts.hostname, pool = DEFAULT_PORT_POOL), mark the
   * token used, and return the host with its plain credential. One transaction.
   * @throws HttpError 401 when the token is unknown, used or expired.
   */
  public static async enrol(token: string, facts: HostFacts, protocolVersion: number): Promise<{ host: Host; credential: string }> {
    const enrolToken = await EnrolToken.findUsable(token);
    if (!enrolToken) throw HttpError.unauthorized("The enrol token is unknown, already used or expired. Create a new one in the panel.");

    const credential = randomToken(TOKEN_PREFIX.HOST);
    const credentialHash = await sha256Hex(credential);
    const name = (enrolToken.name ?? facts.hostname).trim().slice(0, 64) || "host";

    const host = await Host.sequelize!.transaction(async (transaction) => {
      // Claim the token first: the conditional update lets exactly one of two racing enrolments through.
      const [claimed] = await EnrolToken.update(
        { usedAt: new Date() },
        { where: { id: enrolToken.id, usedAt: null }, transaction },
      );
      if (claimed === 0) throw HttpError.unauthorized("The enrol token is unknown, already used or expired. Create a new one in the panel.");

      const created = await Host.create({
        name,
        credentialHash,
        credentialHint: tokenHint(credential),
        facts,
        agentVersion: facts.agentVersion,
        protocolVersion,
        portPool: Config.DEFAULT_PORT_POOL,
        enrolledById: enrolToken.createdById,
        lastSeenAt: new Date(),
      }, { transaction });

      await EnrolToken.update({ hostId: created.id }, { where: { id: enrolToken.id }, transaction });
      return created;
    });
    return { host, credential };
  }

  /**
   * The host for an id and credential, or null when either is wrong. Disabled hosts are returned (the caller closes
   * with CLOSE_REVOKED).
   */
  public static async authenticateAgent(hostId: string, credential: string): Promise<Host | null> {
    if (!UUID_PATTERN.test(hostId) || !credential.startsWith(TOKEN_PREFIX.HOST)) return null;
    const host = await Host.findByPk(hostId);
    if (!host) return null;
    return digestEquals(host.credentialHash, await sha256Hex(credential)) ? host : null;
  }

  /**
   * Store new facts and `lastSeenAt` (heartbeat, hello). Saves.
   * @returns Whether the facts the host list shows changed (see `materialFacts()`); usage figures alone don't count.
   */
  public async recordFacts(facts: HostFacts): Promise<boolean> {
    const changed = this.facts === null || Host.materialFacts(this.facts) !== Host.materialFacts(facts);
    this.facts = facts;
    this.agentVersion = facts.agentVersion;
    this.lastSeenAt = new Date();
    await this.save();
    return changed;
  }

  /**
   * The facts that only change on an upgrade or hardware change (hostname, versions, OS, CPU, totals), as a string to
   * compare. Load, available memory, free disk and uptime are left out.
   */
  public static materialFacts(facts: HostFacts): string {
    return JSON.stringify([
      facts.hostname,
      facts.agentVersion,
      facts.os,
      facts.cpu.model,
      facts.cpu.threads,
      facts.memory.totalBytes,
      facts.disk.path,
      facts.disk.totalBytes,
      facts.docker,
    ]);
  }

  /**
   * @param online From `AgentGateway.isOnline(this.id)`.
   * @param serverCount Game servers on this host (0 in M1).
   */
  public toClientJSON(online: boolean, serverCount: number): HostDto {
    return {
      id: this.id,
      name: this.name,
      address: this.address,
      online,
      disabled: this.disabled,
      agentVersion: this.agentVersion,
      lastSeenAt: this.lastSeenAt?.toISOString() ?? null,
      enrolledAt: this.createdAt.toISOString(),
      portPool: this.portPool,
      capacity: { maxMemoryMb: this.maxMemoryMb, maxCpuMillis: this.maxCpuMillis, maxDiskMb: this.maxDiskMb },
      serverCount,
      facts: this.facts,
    };
  }

  /**
   * Needs `grants` (with `user`) loaded when `includeGrants`.
   */
  public toDetailJSON(online: boolean, serverCount: number, includeGrants: boolean): HostDetailResponse {
    return {
      ...this.toClientJSON(online, serverCount),
      grants: includeGrants
        ? (this.grants ?? []).map((grant) => ({
          userId: grant.userId,
          username: grant.user?.username ?? "",
          createdAt: grant.createdAt.toISOString(),
        }))
        : [],
    };
  }
}

export type HostAttributes = InferAttributes<Host>;
export default Host;
