import type { CpuFacts, DiskFacts, DockerFacts, HostFacts, MemoryFacts, OsFacts } from "@shared/protocol/protocol.gen.ts";
import { AgentRequestError } from "../AgentConnection.ts";

/**
 * Largest serialized `facts` object accepted. Real facts are well under 1 KiB.
 */
const MAX_FACTS_CHARS = 16 * 1024;
/**
 * Longest string accepted in facts (hostname, OS name, CPU model, versions…).
 */
const MAX_FACT_STRING = 255;
/**
 * Longest disk path accepted.
 */
const MAX_FACT_PATH = 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Check that a payload is an object, so a handler can read its fields.
 * @throws AgentRequestError `bad_request` otherwise.
 */
export function requireObject<T extends object>(data: unknown, what: string): T {
  if (!isRecord(data)) throw new AgentRequestError("bad_request", `${what} must be an object.`);
  return data as T;
}

function factString(value: unknown, path: string, max = MAX_FACT_STRING): string {
  if (typeof value !== "string") throw new AgentRequestError("bad_request", `facts.${path} must be a string.`);
  if (value.length > max) throw new AgentRequestError("bad_request", `facts.${path} can be at most ${max} characters long.`);
  return value;
}

function factInt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AgentRequestError("bad_request", `facts.${path} must be a whole number of at least 0.`);
  }
  return value;
}

function factNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new AgentRequestError("bad_request", `facts.${path} must be a number of at least 0.`);
  }
  return value;
}

function factObject(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new AgentRequestError("bad_request", `facts.${path} must be an object.`);
  return value;
}

/**
 * Validate host facts field by field (types, string lengths, total size) and return a copy with only the known
 * fields, so what is stored in `hosts.facts` is bounded and well-formed.
 * @throws AgentRequestError `bad_request` naming the first bad field.
 */
export function requireFacts(value: unknown): HostFacts {
  const facts = requireObject<Record<string, unknown>>(value, "facts");
  if (JSON.stringify(facts).length > MAX_FACTS_CHARS) {
    throw new AgentRequestError("bad_request", `facts is larger than ${MAX_FACTS_CHARS / 1024} KiB.`);
  }

  const os = factObject(facts.os, "os");
  const cpu = factObject(facts.cpu, "cpu");
  const memory = factObject(facts.memory, "memory");
  const disk = factObject(facts.disk, "disk");
  let docker: DockerFacts | null = null;
  if (facts.docker !== null) {
    const raw = factObject(facts.docker, "docker");
    docker = { version: factString(raw.version, "docker.version"), apiVersion: factString(raw.apiVersion, "docker.apiVersion") };
  }

  const osFacts: OsFacts = {
    name: factString(os.name, "os.name"),
    id: factString(os.id, "os.id"),
    version: factString(os.version, "os.version"),
    kernel: factString(os.kernel, "os.kernel"),
    arch: factString(os.arch, "os.arch"),
  };
  const cpuFacts: CpuFacts = {
    model: factString(cpu.model, "cpu.model"),
    threads: factInt(cpu.threads, "cpu.threads"),
    load1: factNumber(cpu.load1, "cpu.load1"),
  };
  const memoryFacts: MemoryFacts = {
    totalBytes: factInt(memory.totalBytes, "memory.totalBytes"),
    availableBytes: factInt(memory.availableBytes, "memory.availableBytes"),
  };
  const diskFacts: DiskFacts = {
    path: factString(disk.path, "disk.path", MAX_FACT_PATH),
    totalBytes: factInt(disk.totalBytes, "disk.totalBytes"),
    freeBytes: factInt(disk.freeBytes, "disk.freeBytes"),
  };
  const hostname = factString(facts.hostname, "hostname");
  if (hostname.trim() === "") throw new AgentRequestError("bad_request", "facts.hostname must not be empty.");

  return {
    hostname,
    agentVersion: factString(facts.agentVersion, "agentVersion", 32), // hosts.agent_version is VARCHAR(32).
    uptimeSec: factInt(facts.uptimeSec, "uptimeSec"),
    os: osFacts,
    cpu: cpuFacts,
    memory: memoryFacts,
    disk: diskFacts,
    docker,
  };
}
