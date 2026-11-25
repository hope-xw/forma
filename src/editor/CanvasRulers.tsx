import { useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import type { Guide } from "../domain/document";
import type { Viewport, Rect } from "../domain/geometry";

const strip = 20;
function ticks(origin: number, zoom: number, length: number) {
  const magnitude = Math.pow(10, Math.floor(Math.log10(65 / zoom)));
  const major =
    ([1, 2, 5, 10].find((n) => n * magnitude * zoom >= 65) ?? 10) * magnitude;
  const minor = major / 5;
  return Array.from(
    { length: Math.ceil(length / (minor * zoom)) + 2 },
    (_, i) => {
      const index = Math.ceil((strip - origin) / (minor * zoom)) + i,
        value = index * minor;
      return { at: origin + value * zoom, value, label: index % 5 === 0 };
    },
  ).filter((t) => t.at <= length);
}
interface Props {
  viewport: Viewport;
  selection?: Rect;
  guides: Guide[];
  change(guides: Guide[]): void;
}
export function CanvasRulers({ viewport, guides, selection, change }: Props) {
  const surface = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [moving, move] = useState<Guide | null>(null);
  const drag = useRef<Guide | null>(null);
  const activeGuideId = useRef<string | null>(null);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }),
    );
    observer.observe(surface.current!);
    return () => observer.disconnect();
  }, []);
  const local = (ev: PointerEvent) => {
    const rect = surface.current!.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  };
  const coordinate = (ev: PointerEvent, axis: Guide["axis"]) =>
    Math.round((local(ev)[axis] - viewport[axis]) / viewport.zoom);
  function start(ev: PointerEvent, axis: Guide["axis"], guide?: Guide) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    activeGuideId.current = guide?.id ?? null;
    if (guide && ev.currentTarget instanceof HTMLElement)
      ev.currentTarget.focus();
    else surface.current!.focus();
    surface.current!.setPointerCapture(ev.pointerId);
    drag.current = guide ?? {
      axis,
      id: crypto.randomUUID(),
      value: coordinate(ev, axis),
    };
    move(drag.current);
  }
  function cancel() {
    drag.current = null;
    move(null);
  }
  function end(ev: PointerEvent) {
    const item = drag.current;
    if (!item) return;
    ev.stopPropagation();
    const pos = local(ev);
    const remove =
      pos[item.axis] < strip ||
      pos.x < 0 ||
      pos.y < 0 ||
      pos.x > size.width ||
      pos.y > size.height;
    const rest = guides.filter((g) => g.id !== item.id);
    const value = coordinate(ev, item.axis);
    if (
      remove
        ? rest.length !== guides.length
        : !guides.some((g) => g.id === item.id && g.value === value)
    )
      change(remove ? rest : [...rest, { ...item, value }]);
    const focusId = !remove ? item.id : null;
    cancel();
    if (focusId) {
      requestAnimationFrame(() => {
        surface.current
          ?.querySelector<HTMLButtonElement>(`[data-guide-id="${focusId}"]`)
          ?.focus();
      });
    }
  }
  const visible = moving
    ? [...guides.filter((g) => g.id !== moving.id), moving]
    : guides;
  return (
    <div
      className="canvas-rulers"
      ref={surface}
      tabIndex={-1}
      onPointerMove={(ev) => {
        const item = drag.current;
        if (item) {
          ev.stopPropagation();
          move({ ...item, value: coordinate(ev, item.axis) });
        }
      }}
      onPointerUp={end}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onKeyDown={(ev) => {
        if (ev.key === "Escape" && drag.current) {
          ev.stopPropagation();
          cancel();
        }
      }}
    >
      {visible.map((g) => (
        <button
          type="button"
          className={"ruler-guide guide-" + g.axis}
          key={g.id}
          data-guide-id={g.id}
          data-guide-value={g.value}
          aria-label={(g.axis === "x" ? "垂直" : "水平") + "辅助线 " + g.value}
          title={g.value + " px"}
          style={
            g.axis === "x"
              ? { left: viewport.x + g.value * viewport.zoom }
              : { top: viewport.y + g.value * viewport.zoom }
          }
          onPointerDown={(ev) => start(ev, g.axis, g)}
          onDoubleClick={(ev) => ev.stopPropagation()}
          onKeyDown={(ev) => {
            if (ev.key === "Delete" || ev.key === "Backspace") {
              ev.preventDefault();
              ev.stopPropagation();
              change(guides.filter((item) => item.id !== g.id));
            }
            const keys =
              g.axis === "x"
                ? ["ArrowLeft", "ArrowRight"]
                : ["ArrowUp", "ArrowDown"];
            if (keys.includes(ev.key)) {
              ev.preventDefault();
              ev.stopPropagation();
              change(
                guides.map((item) =>
                  item.id === g.id
                    ? {
                        ...item,
                        value:
                          item.value +
                          (ev.key === keys[0] ? -1 : 1) *
                            (ev.shiftKey ? 10 : 1),
                      }
                    : item,
                ),
              );
            }
          }}
        />
      ))}
      {(["x", "y"] as const).map((axis) => {
        const horizontal = axis === "x",
          extent = horizontal ? size.width : size.height;
        return (
          <svg
            key={axis}
            className={"ruler-strip strip-" + axis}
            aria-label={horizontal ? "水平标尺" : "垂直标尺"}
            width={horizontal ? "100%" : strip}
            height={horizontal ? strip : "100%"}
            onPointerDown={(ev) => start(ev, horizontal ? "y" : "x")}
          >
            {selection && (
              <rect
                className="ruler-selection"
                pointerEvents="none"
                x={horizontal ? viewport.x + selection.x * viewport.zoom : 0}
                y={horizontal ? 0 : viewport.y + selection.y * viewport.zoom}
                width={horizontal ? selection.width * viewport.zoom : strip}
                height={horizontal ? strip : selection.height * viewport.zoom}
                fill="#0d99ff"
                opacity={0.28}
              />
            )}
            <g
              transform={horizontal ? undefined : "translate(20 0) rotate(90)"}
            >
              {ticks(viewport[axis], viewport.zoom, extent).map((t) => (
                <g key={t.value} transform={"translate(" + t.at + " 0)"}>
                  <path
                    d={
                      horizontal
                        ? "M0 20v-" + (t.label ? 8 : 4)
                        : "M0 0v" + (t.label ? 8 : 4)
                    }
                  />
                  {t.label && (
                    <text
                      x={horizontal ? 3 : -3}
                      y={horizontal ? 10 : -11}
                      transform={horizontal ? undefined : "rotate(180)"}
                      textAnchor={horizontal ? "start" : "end"}
                    >
                      {t.value}
                    </text>
                  )}
                </g>
              ))}
            </g>
          </svg>
        );
      })}
      <span className="ruler-origin" aria-hidden="true" />
      {moving && (
        <output
          className="guide-position"
          style={
            moving.axis === "x"
              ? {
                  top: 24,
                  left: Math.min(
                    size.width - 56,
                    Math.max(24, viewport.x + moving.value * viewport.zoom + 5),
                  ),
                }
              : {
                  left: 24,
                  top: Math.min(
                    size.height - 22,
                    Math.max(24, viewport.y + moving.value * viewport.zoom + 5),
                  ),
                }
          }
        >
          {moving.value} px
        </output>
      )}
    </div>
  );
}
