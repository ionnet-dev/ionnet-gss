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
    const newest = this._samples[this._samples.length - 1];
    if (newest && at.getTime() < Date.parse(newest.at)) return null;
    let rx = 0;
    let tx = 0;
    const last = this._last;
    if (last && at.getTime() > last.at && stats.netRxBytes >= last.rx && stats.netTxBytes >= last.tx) {
      const seconds = (at.getTime() - last.at) / 1000;
      rx = (stats.netRxBytes - last.rx) / seconds;
      tx = (stats.netTxBytes - last.tx) / seconds; // A decrease (container restarted) keeps both rates 0.
    }
    this._last = { at: at.getTime(), rx: stats.netRxBytes, tx: stats.netTxBytes };
    const sample: MetricSampleDto = {
      at: at.toISOString(),
      cpuPercent: stats.cpuPercent,
      memoryBytes: stats.memoryBytes,
      memoryLimitBytes: stats.memoryLimitBytes,
      netRxBytesPerSec: Math.round(rx),
      netTxBytesPerSec: Math.round(tx),
      pids: stats.pids,
    };
    this._samples.push(sample);
    if (this._samples.length > this.capacity) this._samples.splice(0, this._samples.length - this.capacity);
    return sample;
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
