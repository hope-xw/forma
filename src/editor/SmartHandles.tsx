import { useCallback, useLayoutEffect, useRef, type PointerEvent } from "react";
import type { DesignDocument } from "../domain/document";
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
  active = true,
  editor: e,
  grid,
  viewport,
  matrix,
}: {
  active?: boolean;
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
    pointerId: number;
    target: HTMLButtonElement;
  } | null>(null);
  const ownedPreviewRef = useRef<DesignDocument | null>(null);
  const activeRef = useRef(active);
  const { setLocalPreview, setPreview, previewRef, hasExternalPreview } = e;
  const publish = useCallback(
    (next: DesignDocument | null) => {
      const owned = ownedPreviewRef.current;
      if (hasExternalPreview || (previewRef && previewRef.current !== owned))
        return false;
      if (owned !== next) {
        if (setLocalPreview) {
          if (!setLocalPreview(owned, next)) return false;
        } else {
          setPreview(next);
        }
        ownedPreviewRef.current = next;
      }
      return true;
    },
    [hasExternalPreview, previewRef, setLocalPreview, setPreview],
  );
  const places = gridPlacement(grid);
  const cancel = useCallback(() => {
    const state = gesture.current;
    gesture.current = null;
    if (state?.target.hasPointerCapture(state.pointerId))
      state.target.releasePointerCapture(state.pointerId);
    const released = publish(null);
    ownedPreviewRef.current = null;
    return released;
  }, [publish]);
  useLayoutEffect(() => {
    activeRef.current = active;
    if (!active) {
      cancel();
      return;
    }
    window.addEventListener("blur", cancel);
    return () => {
      activeRef.current = false;
      window.removeEventListener("blur", cancel);
      cancel();
    };
  }, [active, cancel, e.tool, e.selection, e.committed]);
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
    if (
      !activeRef.current ||
      ev.button !== 0 ||
      gesture.current ||
      hasExternalPreview ||
      previewRef?.current
    )
      return;
    ev.stopPropagation();
    ev.currentTarget.focus({ preventScroll: true });
    ev.currentTarget.setPointerCapture(ev.pointerId);
    gesture.current = {
      type,
      index,
      start: { x: ev.clientX, y: ev.clientY },
      ops: [],
      revision: e.committed.revision,
      pointerId: ev.pointerId,
      target: ev.currentTarget,
    };
  }
  function move(ev: PointerEvent<HTMLButtonElement>) {
    const state = gesture.current;
    if (!activeRef.current || !state || state.pointerId !== ev.pointerId)
      return;
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
    if (
      !publish(
        state.ops.length ? previewGeometry(e.committed, state.ops) : null,
      )
    )
      cancel();
  }
  function end(ev: PointerEvent<HTMLButtonElement>) {
    const state = gesture.current;
    if (!activeRef.current || !state || state.pointerId !== ev.pointerId)
      return;
    ev.stopPropagation();
    if (cancel() && state.ops.length)
      e.attempt(() => e.apply(state.ops, state.revision));
  }
  function cancelPointer(ev: PointerEvent<HTMLButtonElement>) {
    if (gesture.current?.pointerId === ev.pointerId) cancel();
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
        onPointerCancel={cancelPointer}
        onLostPointerCapture={cancelPointer}
        onDoubleClick={(ev) => ev.stopPropagation()}
        onKeyDown={(ev) => {
          if (!activeRef.current) return;
          if (ev.key === "Escape") {
            ev.preventDefault();
            ev.stopPropagation();
            cancel();
            return;
          }
          if (hasExternalPreview || previewRef?.current) return;
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
