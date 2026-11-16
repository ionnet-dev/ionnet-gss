import { useEffect, useMemo, useRef, useState } from "react";
import "./MetricChart.scss";

export interface MetricSeries {
  label: string;
  color: string; // Any CSS colour; use `var(--io-color-…)`.
  values: number[]; // One per entry of `times`.
  dashed?: boolean; // Reference line (a limit): no area, thinner.
}

export interface MetricChartProps {
  title: string;
  /**
   * Sample times in ms, oldest first (same length as every series).
   */
  times: number[];
  series: MetricSeries[];
  /**
   * Text for an axis tick or a value (`"512 MiB"`, `"12.5%"`).
   */
  format: (value: number) => string;
  /**
   * Smallest top of the y axis (100 for CPU %). The axis grows to the next 1-2-5 step above the data.
   */
  minMax?: number;
  /**
   * The longest span of the x axis in ms, ending at the newest sample; a shorter history gets a shorter axis (at least
   * 5 minutes). Default is one hour.
   */
  windowMs?: number;
  /**
   * Put the top of the y axis at the data's peak (plus 5%) instead of the next 1-2-5 step: for byte sizes, where
   * 1-2-5 steps read oddly.
   */
  exactTop?: boolean;
  /**
   * A gap longer than this between two samples breaks the line (the game was stopped). Default is 15 s.
   */
  gapMs?: number;
  height?: number;
}

const HEIGHT = 150;
const MARGIN = { top: 8, right: 8, bottom: 20, left: 54 };
const TICKS = 4;
const MIN_WINDOW_MS = 5 * 60_000;
const TIME_STEPS_MIN = [1, 2, 5, 10, 15, 30];

/**
 * The next 1-2-5 step at or above `value` (a readable axis maximum).
 */
function niceMax(value: number): number {
  if (!(value > 0)) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  for (const step of [1, 2, 5, 10]) {
    if (step * base >= value) return step * base;
  }
  return 10 * base;
}

/**
 * A small SVG line chart (no chart library): filled lines per series, a 0-based y axis with grid lines, "N min ago"
 * ticks, and a hover read-out with each series' value at the nearest sample. It follows the theme through `--io-*`
 * variables only. Candidate for Iontronic.
 */
export default function MetricChart(props: MetricChartProps) {
  const { title, times, series, format, minMax = 0, windowMs: maxWindowMs = 3_600_000, exactTop = false, gapMs = 15_000, height = HEIGHT } = props;
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(Math.max(200, Math.round(element.clientWidth))));
    observer.observe(element);
    setWidth(Math.max(200, Math.round(element.clientWidth)));
    return () => observer.disconnect();
  }, []);

  const geometry = useMemo(() => {
    const end = times.length > 0 ? times[times.length - 1] : Date.now();
    const span = times.length > 0 ? end - times[0] : 0;
    const windowMs = Math.min(maxWindowMs, Math.max(MIN_WINDOW_MS, span));
    const start = end - windowMs;
    const peak = Math.max(0, ...series.flatMap((one) => one.values));
    const wanted = Math.max(peak * 1.05, minMax);
    const top = exactTop ? Math.max(wanted, 1) : niceMax(wanted);
    const innerWidth = width - MARGIN.left - MARGIN.right;
    const innerHeight = height - MARGIN.top - MARGIN.bottom;
    const x = (time: number) => MARGIN.left + ((time - start) / windowMs) * innerWidth;
    const y = (value: number) => MARGIN.top + innerHeight - (value / top) * innerHeight;
    return { end, start, top, x, y, windowMs };
  }, [times, series, minMax, maxWindowMs, exactTop, width, height]);

  const { x, y, top } = geometry;
  const baseline = y(0);

  /**
   * Runs of sample indexes without a gap between them.
   */
  const runs = useMemo(() => {
    const result: number[][] = [];
    let current: number[] = [];
    times.forEach((time, index) => {
      if (current.length > 0 && time - times[index - 1] > gapMs) {
        result.push(current);
        current = [];
      }
      current.push(index);
    });
    if (current.length > 0) result.push(current);
    return result;
  }, [times, gapMs]);

  const onMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (times.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    let nearest = 0;
    let best = Infinity;
    times.forEach((time, index) => {
      const distance = Math.abs(x(time) - px);
      if (distance < best) {
        best = distance;
        nearest = index;
      }
    });
    setHover(best < 40 ? nearest : null);
  };

  const shown = hover ?? (times.length > 0 ? times.length - 1 : null);
  const ticks = Array.from({ length: TICKS + 1 }, (_, index) => (top / TICKS) * index);
  const windowMin = geometry.windowMs / 60_000;
  const stepMin = TIME_STEPS_MIN.find((step) => windowMin / step <= 5) ?? 30;
  const xTicks = Array.from({ length: Math.floor(windowMin / stepMin) + 1 }, (_, index) => index * stepMin).map((minutes) => ({ minutes, at: geometry.end - minutes * 60_000 }));

  return (
    <figure className="metric-chart" aria-label={title}>
      <figcaption className="metric-chart__head">
        <span className="metric-chart__title">{title}</span>
        <span className="metric-chart__legend">
          {series.map((one) => (
            <span key={one.label} className="metric-chart__key">
              <i className={`metric-chart__swatch${one.dashed ? " metric-chart__swatch--dashed" : ""}`} style={{ color: one.color }} />
              {one.label}
              <b className="io-mono">{shown === null ? "-" : format(one.values[shown])}</b>
            </span>
          ))}
        </span>
      </figcaption>
      <div ref={frame} className="metric-chart__frame">
        <svg width={width} height={height} role="img" aria-label={`${title} history`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          {ticks.map((tick) => (
            <g key={tick}>
              <line className="metric-chart__grid" x1={MARGIN.left} x2={width - MARGIN.right} y1={y(tick)} y2={y(tick)} />
              <text className="metric-chart__tick" x={MARGIN.left - 6} y={y(tick)} textAnchor="end" dominantBaseline="middle">{format(tick)}</text>
            </g>
          ))}
          {xTicks.map((tick) => (
            <text key={tick.minutes} className="metric-chart__tick" x={Math.min(Math.max(x(tick.at), MARGIN.left + 14), width - MARGIN.right - 14)} y={height - 4} textAnchor="middle">
              {tick.minutes === 0 ? "now" : `${tick.minutes} min ago`}
            </text>
          ))}
          {series.map((one) => runs.map((run) => {
            const points = run.map((index) => `${x(times[index]).toFixed(1)},${y(one.values[index]).toFixed(1)}`);
            if (run.length === 1) return <circle key={`${one.label}-${run[0]}`} cx={x(times[run[0]])} cy={y(one.values[run[0]])} r={2} fill={one.color} />;
            if (one.dashed) {
              return <polyline key={`${one.label}-${run[0]}`} className="metric-chart__limit" points={points.join(" ")} fill="none" stroke={one.color} />;
            }
            const area = `${x(times[run[0]]).toFixed(1)},${baseline} ${points.join(" ")} ${x(times[run[run.length - 1]]).toFixed(1)},${baseline}`;
            return (
              <g key={`${one.label}-${run[0]}`}>
                <polygon points={area} fill={one.color} opacity={0.14} />
                <polyline className="metric-chart__line" points={points.join(" ")} fill="none" stroke={one.color} />
              </g>
            );
          }))}
          {hover !== null && (
            <g>
              <line className="metric-chart__cursor" x1={x(times[hover])} x2={x(times[hover])} y1={MARGIN.top} y2={baseline} />
              {series.filter((one) => !one.dashed).map((one) => (
                <circle key={one.label} cx={x(times[hover])} cy={y(one.values[hover])} r={3.5} fill={one.color} />
              ))}
            </g>
          )}
        </svg>
        {hover !== null && (
          <span className="metric-chart__time io-mono">{new Date(times[hover]).toLocaleTimeString()}</span>
        )}
      </div>
    </figure>
  );
}
