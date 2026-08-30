import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

const MARQUEE_SPEED_EMS_PER_SECOND = 2;

export interface OverflowMarqueeMetrics {
  distance: number;
  durationMs: number;
  overflowing: boolean;
}

export function overflowMarqueeMetrics(
  availableWidth: number,
  contentWidth: number,
  fontSize: number,
): OverflowMarqueeMetrics {
  const measuredOverflow = Math.max(0, contentWidth - availableWidth);
  const overflowing = measuredOverflow > 1;
  const distance = overflowing ? measuredOverflow : 0;
  const pixelsPerSecond = Math.max(1, fontSize * MARQUEE_SPEED_EMS_PER_SECOND);

  return {
    distance,
    durationMs: (distance / pixelsPerSecond) * 1_000,
    overflowing,
  };
}

export function OverflowMarqueeText({
  text,
  className = "",
  title,
}: {
  text: string;
  className?: string;
  title?: string;
}) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const [metrics, setMetrics] = useState<OverflowMarqueeMetrics>({ distance: 0, durationMs: 0, overflowing: false });

  const measure = useCallback(() => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!viewport || !track) return;

    const next = overflowMarqueeMetrics(viewport.clientWidth, track.scrollWidth, Number.parseFloat(getComputedStyle(track).fontSize));
    setMetrics((current) => (
      current.distance === next.distance
      && current.durationMs === next.durationMs
      && current.overflowing === next.overflowing
        ? current
        : next
    ));
  }, []);

  useLayoutEffect(() => {
    measure();

    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (viewportRef.current) observer?.observe(viewportRef.current);
    if (trackRef.current) observer?.observe(trackRef.current);

    let active = true;
    void document.fonts?.ready.then(() => {
      if (active) measure();
    });

    return () => {
      active = false;
      observer?.disconnect();
    };
  }, [measure, text]);

  const style = {
    "--overflow-marquee-distance": `${metrics.distance}px`,
    "--overflow-marquee-duration": `${metrics.durationMs}ms`,
  } as CSSProperties;

  return (
    <span
      ref={viewportRef}
      className={`overflow-marquee-text ${className}`.trim()}
      data-overflow={metrics.overflowing ? "true" : undefined}
      style={style}
      title={title}
    >
      <span ref={trackRef} className="overflow-marquee-text-track">{text}</span>
    </span>
  );
}
