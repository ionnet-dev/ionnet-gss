import { useCallback, useEffect, useState } from "react";

export interface Countdown {
  /**
   * Whole seconds left; 0 when it isn't running.
   */
  left: number;
  /**
   * Run it for `seconds`, from now.
   */
  start: (seconds: number) => void;
}

/**
 * A visible countdown for "Send again" buttons. Ticks once a second while it runs and stops by itself.
 */
export function useCountdown(): Countdown {
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (until <= Date.now()) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= until) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [until]);

  const start = useCallback((seconds: number) => setUntil(Date.now() + seconds * 1000), []);
  return { left: Math.max(0, Math.ceil((until - now) / 1000)), start };
}

export default useCountdown;
