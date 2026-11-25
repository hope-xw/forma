import { useLayoutEffect, useRef, useState } from "react";

type Side = "left" | "right";
export function PanelDivider({
  side,
  visible,
}: {
  side: Side;
  visible: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number; previous: string } | null>(
    null,
  );
  const minimum = side === "left" ? 200 : 256;
  const maximum = side === "left" ? 360 : 400;
  const property = "--preferred-" + side;
  const key = "forma.editor.panel." + side;
  const [width, setWidth] = useState(minimum);
  function resize(value: number, persist: boolean) {
    const size = Math.max(minimum, Math.min(maximum, Math.round(value)));
    ref.current?.parentElement?.style.setProperty(property, size + "px");
    setWidth(size);
    if (persist)
      try {
        localStorage.setItem(key, String(size));
      } catch {
        /* Storage may be unavailable in a private session. */
      }
  }
  useLayoutEffect(() => {
    const handle = ref.current!;
    const host = handle.parentElement!;
    try {
      const saved = Number(localStorage.getItem(key));
      if (saved >= minimum && saved <= maximum)
        host.style.setProperty(property, saved + "px");
    } catch {
      /* Use the responsive default. */
    }
    const panel = document.getElementById(side + "-panel")!;
    const observer = new ResizeObserver(() => {
      if (panel.offsetWidth) setWidth(panel.offsetWidth);
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [key, maximum, minimum, property, side]);
  return (
    <div
      ref={ref}
      hidden={!visible}
      className={"panel-divider " + side}
      role="separator"
      aria-label={side === "left" ? "图层栏宽度" : "属性栏宽度"}
      aria-orientation="vertical"
      aria-controls={side + "-panel"}
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0 || drag.current) return;
        e.preventDefault();
        e.currentTarget.focus();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = {
          x: e.clientX,
          width: document.getElementById(side + "-panel")!.offsetWidth,
          previous:
            e.currentTarget.parentElement!.style.getPropertyValue(property),
        };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d)
          resize(
            d.width + (e.clientX - d.x) * (side === "left" ? 1 : -1),
            false,
          );
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        if (d) {
          drag.current = null;
          resize(
            d.width + (e.clientX - d.x) * (side === "left" ? 1 : -1),
            true,
          );
        }
      }}
      onLostPointerCapture={() => {
        if (drag.current) {
          ref.current?.parentElement?.style.setProperty(
            property,
            drag.current.previous,
          );
          drag.current = null;
        }
      }}
      onKeyDown={(e) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        const delta =
          (e.key === "ArrowRight" ? 1 : -1) *
          (side === "left" ? 1 : -1) *
          (e.shiftKey ? 32 : 8);
        resize(
          e.key === "Home"
            ? minimum
            : e.key === "End"
              ? maximum
              : width + delta,
          true,
        );
      }}
    />
  );
}
