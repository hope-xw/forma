import { layoutRuleAt, responsiveSpacing } from "../domain/layout-breakpoints";
import { useEffect, useRef, type PointerEvent } from "react";
import { previewGeometry } from "../application/geometry-preview";
import type { Operation } from "../domain/commands";
import type { DesignNode } from "../domain/document";
import type { Rect } from "../domain/geometry";
import { gridSceneMetrics } from "../domain/grid-drop";
import { parseTracks } from "../domain/grid-tracks";
import { flowInsets } from "../domain/sizing";
import { inverse, vector, type Matrix } from "../domain/transforms";
import type { EditorController } from "./useEditor";

type Axis = "column" | "row";

export function GridHandles({
  editor: e,
  node,
  boxes,
  zoom,
  matrix,
}: {
  editor: EditorController;
  node: DesignNode;
  boxes: Map<string, Rect>;
  zoom: number;
  matrix: Matrix;
}) {
  const gesture = useRef<{
    axis: Axis;
    index: number;
    size: number;
    tracks: string[];
    revision: number;
    x: number;
    y: number;
    op?: Operation;
  } | null>(null);
  const cancel = () => {
    if (!gesture.current) return;
    gesture.current = null;
    e.setPreview(null);
  };
  useEffect(() => {
    const escape = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && gesture.current) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        cancel();
      }
    };
    window.addEventListener("keydown", escape, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("blur", cancel);
      cancel();
    };
  }, [e.setPreview]);
  const grid = gridSceneMetrics(e.doc, node, boxes);
  const box = boxes.get(node.id)!;
  const inset = flowInsets({
    ...node,
    style: { ...node.style, ...responsiveSpacing(node.style, box.width) },
  });
  const narrow = layoutRuleAt(node.style, box.width)?.columns !== undefined;
  const specs = (axis: Axis, index: number) => {
    const raw =
      axis === "column" ? node.style.gridTracks : node.style.gridRowTracks;
    const tracks = raw
      ? parseTracks(raw).map((t) =>
          t.unit === "auto" ? "auto" : t.value + t.unit,
        )
      : [];
    const count = axis === "column" ? grid.count : index + 1;
    while (tracks.length < count)
      tracks.push(
        axis === "column"
          ? "1fr"
          : node.style.gridRowHeight
            ? node.style.gridRowHeight + "px"
            : "auto",
      );
    return tracks;
  };
  const operation = (
    axis: Axis,
    index: number,
    tracks: string[],
    value: number,
  ): Operation => {
    const next = tracks.slice();
    next[index] = Math.max(1, Math.min(10000, Math.round(value))) + "px";
    return {
      type: "update",
      id: node.id,
      patch: {},
      style: {
        [axis === "column" ? "gridTracks" : "gridRowTracks"]: next.join(" "),
      },
    };
  };
  function move(ev: PointerEvent<HTMLButtonElement>) {
    const g = gesture.current;
    if (!g) return;
    if (e.committed.revision !== g.revision) {
      cancel();
      return;
    }
    const d = vector(inverse(matrix), {
      x: (ev.clientX - g.x) / zoom,
      y: (ev.clientY - g.y) / zoom,
    });
    const delta = g.axis === "column" ? d.x : d.y;
    if (Math.abs(delta) < 0.5) {
      g.op = undefined;
      e.setPreview(null);
      return;
    }
    g.op = operation(g.axis, g.index, g.tracks, g.size + delta);
    e.setPreview(previewGeometry(e.committed, [g.op]));
  }
  const handle = (axis: Axis, index: number, end: number, size: number) => {
    const col = axis === "column";
    const label = "拖动调整第 " + (index + 1) + (col ? " 列宽" : " 行高");
    return (
      <button
        key={axis + index}
        className={"grid-track-handle " + axis}
        style={
          col
            ? { left: (inset.left + end) * zoom, top: 9 }
            : { top: (inset.top + end) * zoom, left: 9 }
        }
        aria-label={label}
        data-tip={label}
        data-tip-desc={
          Math.round(size) + " px · 拖动后固定尺寸，方向键微调，Esc 取消"
        }
        onPointerDown={(ev) => {
          if (ev.button !== 0) return;
          ev.preventDefault();
          ev.stopPropagation();
          ev.currentTarget.focus({ preventScroll: true });
          ev.currentTarget.setPointerCapture(ev.pointerId);
          gesture.current = {
            axis,
            index,
            size,
            tracks: specs(axis, index),
            x: ev.clientX,
            y: ev.clientY,
            revision: e.committed.revision,
          };
        }}
        onDoubleClick={(ev) => ev.stopPropagation()}
        onPointerMove={move}
        onPointerUp={(ev) => {
          const g = gesture.current;
          if (!g) return;
          ev.stopPropagation();
          cancel();
          if (g.op) e.attempt(() => e.apply([g.op!], g.revision));
        }}
        onLostPointerCapture={cancel}
        onPointerCancel={cancel}
        onKeyDown={(ev) => {
          const keys = col
            ? ["ArrowLeft", "ArrowRight"]
            : ["ArrowUp", "ArrowDown"];
          const k = keys.indexOf(ev.key);
          if (k < 0) return;
          ev.preventDefault();
          ev.stopPropagation();
          e.attempt(() =>
            e.apply([
              operation(
                axis,
                index,
                specs(axis, index),
                size + (k ? 1 : -1) * (ev.shiftKey ? 10 : 1),
              ),
            ]),
          );
        }}
      >
        {gesture.current?.axis === axis && gesture.current.index === index && (
          <span>{Math.round(size)} px</span>
        )}
      </button>
    );
  };
  const rowGap = responsiveSpacing(node.style, box.width).rowGap ?? grid.gap;
  let y = 0;
  return (
    <>
      {!narrow &&
        grid.starts
          .slice(1, -1)
          .map((end, i) =>
            handle(
              "column",
              i,
              end - grid.gap,
              end - grid.starts[i] - grid.gap,
            ),
          )}
      {grid.heights.slice(0, 64).map((h, i) => {
        y += h + rowGap;
        return y - rowGap < box.height - inset.top - 1
          ? handle("row", i, y - rowGap, h)
          : null;
      })}
    </>
  );
}
