import { useRef, useEffect, type PointerEvent } from "react";
import {
  arrangeGrid,
  gridPlacement,
  type SmartGrid,
} from "../domain/smart-selection";
import type { EditorController } from "./useEditor";
import type { Point, Viewport } from "../domain/geometry";
import { transform, vector, inverse, type Matrix } from "../domain/transforms";
import { previewGeometry } from "../application/geometry-preview";
import type { Operation } from "../domain/commands";
export function SmartHandles({
  editor: e,
  grid,
  viewport,
  matrix,
}: {
  editor: EditorController;
  grid: SmartGrid;
  viewport: Viewport;
  matrix: Matrix;
}) {
  const gesture = useRef<{
    type: "gapX" | "gapY" | "item";
    index: number;
    start: Point;
    ops: Operation[];
    revision: number;
  } | null>(null);
  const places = gridPlacement(grid);
  const cancel = () => {
    gesture.current = null;
    e.setPreview(null);
  };
  useEffect(() => {
    const onBlur = () => {
      if (gesture.current) cancel();
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [e.setPreview]);
  if (
    !gesture.current &&
    places.some(
      (p) => Math.abs(p.x - p.box.x) > 0.6 || Math.abs(p.y - p.box.y) > 0.6,
    )
  )
    return null;
  function begin(
    ev: PointerEvent<HTMLButtonElement>,
    type: "gapX" | "gapY" | "item",
    index: number,
  ) {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    ev.currentTarget.focus({ preventScroll: true });
    ev.currentTarget.setPointerCapture(ev.pointerId);
    gesture.current = {
      type,
      index,
      start: { x: ev.clientX, y: ev.clientY },
      ops: [],
      revision: e.committed.revision,
    };
  }
  function move(ev: PointerEvent<HTMLButtonElement>) {
    const state = gesture.current;
    if (!state) return;
    if (e.committed.revision !== state.revision) {
      cancel();
      return;
    }
    const delta = vector(inverse(matrix), {
      x: (ev.clientX - state.start.x) / viewport.zoom,
      y: (ev.clientY - state.start.y) / viewport.zoom,
    });
    if (state.type === "item") {
      const p = places[state.index],
        x = p.x + p.box.width / 2 + delta.x,
        y = p.y + p.box.height / 2 + delta.y;
      const nearest = places.reduce(
        (best, next, i) => {
          const d = Math.hypot(
            x - next.x - next.box.width / 2,
            y - next.y - next.box.height / 2,
          );
          return d < best.distance ? { distance: d, index: i } : best;
        },
        { index: state.index, distance: Infinity },
      ).index;
      const items = grid.items.slice();
      items.splice(nearest, 0, items.splice(state.index, 1)[0]);
      state.ops = arrangeGrid(grid, items);
    } else {
      const gap = Math.round(
        grid[state.type] + (state.type === "gapX" ? delta.x : delta.y),
      );
      state.ops = arrangeGrid({ ...grid, [state.type]: Math.max(0, gap) });
    }
    e.setPreview(
      state.ops.length ? previewGeometry(e.committed, state.ops) : null,
    );
  }
  function end(ev: PointerEvent<HTMLButtonElement>) {
    const state = gesture.current;
    if (!state) return;
    ev.stopPropagation();
    cancel();
    if (state.ops.length) e.attempt(() => e.apply(state.ops, state.revision));
  }
  function handle(
    type: "item" | "gapX" | "gapY",
    index: number,
    x: number,
    y: number,
    label: string,
  ) {
    const p = transform(matrix, { x, y });
    return (
      <button
        key={type + index}
        className={"smart-handle smart-" + type}
        aria-label={label}
        title={label}
        style={{
          left: viewport.x + p.x * viewport.zoom,
          top: viewport.y + p.y * viewport.zoom,
        }}
        onPointerDown={(ev) => begin(ev, type, index)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={cancel}
        onLostPointerCapture={() => {
          if (gesture.current) cancel();
        }}
        onDoubleClick={(ev) => ev.stopPropagation()}
        onKeyDown={(ev) => {
          if (ev.key === "Escape") {
            ev.preventDefault();
            ev.stopPropagation();
            cancel();
            return;
          }
          if (
            type !== "item" &&
            ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(ev.key)
          ) {
            ev.preventDefault();
            ev.stopPropagation();
            const delta =
              (ev.key === "ArrowLeft" || ev.key === "ArrowUp" ? -1 : 1) *
              (ev.shiftKey ? 10 : 1);
            const ops = arrangeGrid({
              ...grid,
              [type]: Math.max(0, grid[type] + delta),
            });
            if (ops.length) e.attempt(() => e.apply(ops));
            return;
          }
          if (
            type !== "item" ||
            ![
              "Backspace",
              "Delete",
              "ArrowLeft",
              "ArrowRight",
              "ArrowUp",
              "ArrowDown",
            ].includes(ev.key)
          )
            return;
          ev.stopPropagation();
          ev.preventDefault();
          const items = grid.items.slice();
          const [chosen] = items.splice(index, 1);
          if (ev.key === "Backspace" || ev.key === "Delete") {
            e.attempt(() => {
              e.apply([
                { type: "remove", id: chosen.node.id },
                ...arrangeGrid(grid, items),
              ]);
              e.setSelection(items.map((i) => i.node.id));
            });
          } else {
            const offset =
              ev.key === "ArrowLeft"
                ? -1
                : ev.key === "ArrowRight"
                  ? 1
                  : ev.key === "ArrowUp"
                    ? -grid.columns
                    : grid.columns;
            const at = Math.min(items.length, Math.max(0, index + offset));
            items.splice(at, 0, chosen);
            const ops = arrangeGrid(grid, items);
            if (ops.length) e.attempt(() => e.apply(ops));
          }
        }}
      />
    );
  }
  return (
    <>
      {places.map((p, i) =>
        handle(
          "item",
          i,
          p.x + p.box.width / 2,
          p.y + p.box.height / 2,
          "重排 " + p.node.name,
        ),
      )}
      {grid.columns > 1 &&
        handle(
          "gapX",
          0,
          (places[0].x + places[0].box.width + places[1].x) / 2,
          places[0].y + places[0].box.height / 2,
          "拖动水平间距",
        )}
      {places.length > grid.columns &&
        handle(
          "gapY",
          0,
          places[0].x + places[0].box.width / 2,
          (places[0].y + places[0].box.height + places[grid.columns].y) / 2,
          "拖动垂直间距",
        )}
    </>
  );
}
