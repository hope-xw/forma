import {
  useEffect,
  useRef,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { imageExtent, imageViewport, type ImageFill } from "../domain/images";
import type { DesignNode } from "../domain/document";
import type { Rect } from "../domain/geometry";
import { inverse, vector, type Matrix } from "../domain/transforms";
import { previewGeometry } from "../application/geometry-preview";
import type { EditorController } from "./useEditor";

const limit = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Math.round(value * 10) / 10));

type CropHandle = "pan" | "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w";

const HANDLE_META: {
  id: Exclude<CropHandle, "pan">;
  label: string;
  tip: string;
  cursor: string;
  style: CSSProperties;
}[] = [
  {
    id: "nw",
    label: "从左上角裁切缩放",
    tip: "左上角裁切缩放",
    cursor: "nwse-resize",
    style: { left: -5, top: -5, width: 10, height: 10, borderRadius: 2 },
  },
  {
    id: "ne",
    label: "从右上角裁切缩放",
    tip: "右上角裁切缩放",
    cursor: "nesw-resize",
    style: { right: -5, top: -5, width: 10, height: 10, borderRadius: 2 },
  },
  {
    id: "sw",
    label: "从左下角裁切缩放",
    tip: "左下角裁切缩放",
    cursor: "nesw-resize",
    style: { left: -5, bottom: -5, width: 10, height: 10, borderRadius: 2 },
  },
  {
    id: "se",
    label: "缩放裁切图像",
    tip: "拖动缩放图像",
    cursor: "nwse-resize",
    style: {},
  },
  {
    id: "n",
    label: "从上边裁切缩放",
    tip: "上边缘裁切",
    cursor: "ns-resize",
    style: {
      left: "50%",
      top: -4,
      width: 18,
      height: 6,
      marginLeft: -9,
      borderRadius: 3,
    },
  },
  {
    id: "s",
    label: "从下边裁切缩放",
    tip: "下边缘裁切",
    cursor: "ns-resize",
    style: {
      left: "50%",
      bottom: -4,
      width: 18,
      height: 6,
      marginLeft: -9,
      borderRadius: 3,
    },
  },
  {
    id: "w",
    label: "从左边裁切缩放",
    tip: "左边缘裁切",
    cursor: "ew-resize",
    style: {
      left: -4,
      top: "50%",
      width: 6,
      height: 18,
      marginTop: -9,
      borderRadius: 3,
    },
  },
  {
    id: "e",
    label: "从右边裁切缩放",
    tip: "右边缘裁切",
    cursor: "ew-resize",
    style: {
      right: -4,
      top: "50%",
      width: 6,
      height: 18,
      marginTop: -9,
      borderRadius: 3,
    },
  },
];

export function ImageCropOverlay({
  editor: e,
  node,
  box,
  matrix,
  zoom,
  style,
}: {
  editor: EditorController;
  node: DesignNode;
  box: Rect;
  matrix: Matrix;
  zoom: number;
  style: CSSProperties;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    id: number;
    revision: number;
    x: number;
    y: number;
    handle: CropHandle;
    original: ImageFill;
    last: ImageFill;
  } | null>(null);
  const fill = node.image!;
  const asset = e.committed.images?.[fill.assetId];
  const area = imageViewport(node.style, box.width, box.height);
  const { setPreview, setCropping } = e;
  useEffect(() => {
    surface.current?.focus({ preventScroll: true });
    const cancel = () => {
      if (drag.current) {
        drag.current = null;
        setPreview(null);
      }
    };
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      cancel();
    };
  }, [setPreview]);
  const finish = () => {
    if (drag.current) {
      drag.current = null;
      setPreview(null);
    }
    setCropping(null);
    surface.current
      ?.closest<HTMLElement>(".editor-canvas")
      ?.focus({ preventScroll: true });
  };
  const change = (ev: PointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    if (!g || g.id !== ev.pointerId || !asset) return;
    if (e.historyRef.current.present.revision !== g.revision) {
      drag.current = null;
      setPreview(null);
      return;
    }
    const delta = vector(inverse(matrix), {
      x: (ev.clientX - g.x) / zoom,
      y: (ev.clientY - g.y) / zoom,
    });
    const { width, height } = imageExtent(
      g.original,
      asset,
      area.width,
      area.height,
    );
    const shift = (start: number, dist: number, travel: number) =>
      Math.abs(travel) < 0.01
        ? start
        : limit(start + (dist / travel) * 100, 0, 100);
    let next: ImageFill;
    if (g.handle === "pan") {
      next = {
        ...g.original,
        x: shift(g.original.x, delta.x, area.width - width),
        y: shift(g.original.y, delta.y, area.height - height),
      };
    } else if (g.handle === "se") {
      next = {
        ...g.original,
        zoom: limit(
          g.original.zoom *
            (1 +
              (delta.x * box.width + delta.y * box.height) /
                Math.max(1, box.width ** 2 + box.height ** 2)),
          1,
          8,
        ),
      };
    } else if (g.handle === "nw" || g.handle === "ne" || g.handle === "sw") {
      const sx = g.handle.includes("e") ? 1 : -1;
      const sy = g.handle.includes("s") ? 1 : -1;
      const factor =
        (sx * delta.x * box.width + sy * delta.y * box.height) /
        Math.max(1, box.width ** 2 + box.height ** 2);
      const nextZoom = limit(g.original.zoom * (1 + factor), 1, 8);
      next = {
        ...g.original,
        zoom: nextZoom,
        x: shift(g.original.x, sx < 0 ? delta.x * 0.5 : 0, area.width - width),
        y: shift(
          g.original.y,
          sy < 0 ? delta.y * 0.5 : 0,
          area.height - height,
        ),
      };
    } else {
      // Edge handles: n, s, e, w adjust crop/zoom along that edge axis and pan focal window smoothly
      const isHorizontal = g.handle === "e" || g.handle === "w";
      const sign = g.handle === "e" || g.handle === "s" ? 1 : -1;
      const axisDelta = isHorizontal ? delta.x : delta.y;
      const axisSize = Math.max(1, isHorizontal ? box.width : box.height);
      const nextZoom = limit(
        g.original.zoom * (1 + (sign * axisDelta) / axisSize),
        1,
        8,
      );
      next = {
        ...g.original,
        zoom: nextZoom,
        x: isHorizontal
          ? shift(g.original.x, delta.x * 0.5, area.width - width)
          : g.original.x,
        y: !isHorizontal
          ? shift(g.original.y, delta.y * 0.5, area.height - height)
          : g.original.y,
      };
    }
    if (next.x === g.last.x && next.y === g.last.y && next.zoom === g.last.zoom)
      return;
    g.last = next;
    setPreview(
      previewGeometry(e.committed, [
        { type: "update", id: node.id, patch: { image: next } },
      ]),
    );
  };
  return (
    <div
      className="image-crop-overlay"
      style={style}
      ref={surface}
      tabIndex={0}
      role="group"
      aria-label="画布裁切"
      onPointerDown={(ev) => {
        if (ev.button !== 0 || !ev.isPrimary || drag.current) return;
        ev.stopPropagation();
        ev.preventDefault();
        ev.currentTarget.focus({ preventScroll: true });
        ev.currentTarget.setPointerCapture(ev.pointerId);
        const handleEl = (ev.target as HTMLElement).closest<HTMLElement>(
          "[data-crop-handle]",
        );
        const handle = (handleEl?.dataset.cropHandle as CropHandle) ?? "pan";
        drag.current = {
          id: ev.pointerId,
          revision: e.committed.revision,
          x: ev.clientX,
          y: ev.clientY,
          handle,
          original: fill,
          last: fill,
        };
      }}
      onPointerMove={change}
      onPointerUp={(ev) => {
        if (ev.pointerId !== drag.current?.id) return;
        ev.stopPropagation();
        change(ev);
        const g = drag.current;
        drag.current = null;
        setPreview(null);
        if (
          g &&
          (g.last.x !== g.original.x ||
            g.last.y !== g.original.y ||
            g.last.zoom !== g.original.zoom)
        )
          e.attempt(() =>
            e.apply(
              [{ type: "update", id: node.id, patch: { image: g.last } }],
              g.revision,
            ),
          );
      }}
      onLostPointerCapture={() => {
        if (drag.current) {
          drag.current = null;
          setPreview(null);
        }
      }}
      onDoubleClick={(ev) => {
        ev.stopPropagation();
        finish();
      }}
      onKeyDown={(ev) => {
        if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
        if (ev.key === "Escape" || ev.key === "Enter") {
          ev.preventDefault();
          ev.stopPropagation();
          finish();
          return;
        }
        if (
          drag.current ||
          ![
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
            "+",
            "=",
            "-",
          ].includes(ev.key)
        )
          return;
        ev.preventDefault();
        ev.stopPropagation();
        const step = ev.shiftKey ? 10 : 1;
        const next = { ...fill };
        if (ev.key === "ArrowLeft" || ev.key === "ArrowRight")
          next.x = limit(
            fill.x + (ev.key === "ArrowRight" ? step : -step),
            0,
            100,
          );
        else if (ev.key === "ArrowDown" || ev.key === "ArrowUp")
          next.y = limit(
            fill.y + (ev.key === "ArrowDown" ? step : -step),
            0,
            100,
          );
        else
          next.zoom = limit(
            fill.zoom + (ev.key === "-" ? -0.1 : 0.1) * step,
            1,
            8,
          );
        if (next.x !== fill.x || next.y !== fill.y || next.zoom !== fill.zoom)
          e.update({ image: next });
      }}
    >
      {HANDLE_META.map((h) =>
        h.id === "se" ? (
          <button
            key={h.id}
            type="button"
            className="crop-scale"
            data-crop-handle="se"
            title={h.label}
            aria-label={h.label}
            data-tip={h.tip}
            data-tip-desc="也可使用加减键调整倍率"
          />
        ) : (
          <button
            key={h.id}
            type="button"
            data-crop-handle={h.id}
            title={h.label}
            aria-label={h.label}
            data-tip={h.tip}
            data-tip-desc="拖动裁剪或缩放图像视口"
            style={{
              position: "absolute",
              padding: 0,
              background: "#ffffff",
              border: "1.5px solid var(--figma-blue, #0d99ff)",
              boxShadow: "0 1px 3px rgba(0, 0, 0, 0.28)",
              cursor: h.cursor,
              ...h.style,
            }}
          />
        ),
      )}
    </div>
  );
}
