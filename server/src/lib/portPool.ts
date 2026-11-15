/**
 * Port pool strings (`25565-25664,27015-27064`): parsing and validation. Allocation itself is
 * `PortAllocation.allocate()` (M2), which uses these.
 */

export interface PortRange {
  start: number;
  end: number; // Inclusive.
}

/**
 * Parse a pool string into sorted, non-overlapping ranges.
 * @throws Error with a readable message when a range is malformed, outside 1024–65535, or overlaps another.
 */
export function parsePortPool(pool: string): PortRange[] {
  const ranges: PortRange[] = [];
  for (const part of pool.split(",").map((p) => p.trim()).filter(Boolean)) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) throw new Error(`"${part}" is not a port or a range. Use e.g. "25565-25664,27015".`);
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (start < 1024 || end > 65535 || start > end) {
      throw new Error(`"${part}" must lie within 1024–65535, with the start before the end.`);
    }
    ranges.push({ start, end });
  }
  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].start <= ranges[i - 1].end) {
      throw new Error(`Port ranges ${ranges[i - 1].start}-${ranges[i - 1].end} and ${ranges[i].start}-${ranges[i].end} overlap.`);
    }
  }
  return ranges;
}

/**
 * Whether `port` lies in one of `ranges`.
 */
export function isInPool(ranges: PortRange[], port: number): boolean {
  return ranges.some((r) => port >= r.start && port <= r.end);
}
