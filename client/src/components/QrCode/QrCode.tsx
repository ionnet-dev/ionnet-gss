import { useEffect, useState } from "react";

interface Props {
  value: string;
  label: string; // Accessible name, e.g. "QR code for your authenticator app".
  size?: number; // CSS pixels. Default 192.
}

/**
 * A QR code drawn as SVG rects (no innerHTML). `qrcode-generator` is imported lazily, so it is only downloaded when a
 * code is shown (the TOTP setup dialog). Error correction M; dark modules use `currentColor` on a white quiet zone,
 * which scanners need in dark mode too.
 */
export default function QrCode(props: Props) {
  const { value, label } = props;
  const size = props.size ?? 192;
  const [modules, setModules] = useState<boolean[][] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void import("qrcode-generator").then((mod) => {
      const qr = mod.default(0, "M");
      qr.addData(value);
      qr.make();
      const count = qr.getModuleCount();
      const rows = Array.from({ length: count }, (_, row) => Array.from({ length: count }, (_, col) => qr.isDark(row, col)));
      if (!cancelled) setModules(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [value]);

  if (!modules) return <div style={{ width: size, height: size }} aria-busy="true" aria-label={label} />;
  const margin = 4; // Quiet zone, in modules.
  const extent = modules.length + margin * 2;
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${extent} ${extent}`} shapeRendering="crispEdges" style={{ color: "#000", background: "#fff" }}>
      {modules.flatMap((row, y) => row.map((dark, x) => dark ? <rect key={`${x}-${y}`} x={x + margin} y={y + margin} width={1} height={1} fill="currentColor" /> : null))}
    </svg>
  );
}
