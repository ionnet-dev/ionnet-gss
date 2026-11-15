import type { MetricSampleDto } from "@shared/api/metrics.ts";
import type { ServerStats } from "@shared/protocol/protocol.gen.ts";

/**
 * A fixed-size history of one server's samples (pure, no I/O). Turns the agent's cumulative network counters into
 * rates: the first sample, and any sample whose counter went down (the game container restarted), gets rate 0.
 */
export class MetricRing {
  private _samples: MetricSampleDto[] = [];
  private _last: { at: number; rx: number; tx: number } | null = null;

  constructor(
    /** Most samples kept (LIMITS.METRICS_HISTORY_SAMPLES). */
    public readonly capacity: number,
  ) { }

  /**
   * Add a sample and return it as stored (with rates). Samples older than the newest are dropped (null).
   */
  public push(stats: ServerStats, at: Date): MetricSampleDto | null {
    throw new Error("Not implemented."); // TODO(builder)
  }

  /**
   * Oldest first.
   */
  public samples(): MetricSampleDto[] {
    return [...this._samples];
  }

  /**
   * Forget the rate baseline (game stopped), keeping the history.
   */
  public resetRates(): void {
    this._last = null;
  }
}

export default MetricRing;
