import { memo, useLayoutEffect, useRef } from "react";
import {
  branchHasLayoutGuides,
  computeTileResolution,
  isBoardLodRenderable,
} from "../application/board-lod";
import { resolveNode } from "../domain/design-system";
import type { DesignDocument, DesignNode } from "../domain/document";
import type { Rect } from "../domain/geometry";
import { symbolPaintForView } from "../domain/symbol-background";
import { CanvasNode } from "./CanvasNode";
import { boardTileCache, summaryFill } from "./board-tile-cache";

interface Props {
  document: DesignDocument;
  node: DesignNode;
  rect: Rect;
  bounds: Map<string, Rect>;
  zoom: number;
  dpr?: number;
  showLayoutGuides?: boolean;
}
const inactiveSelection: string[] = [];
export const BoardLodTile = memo(function BoardLodTile(props: Props) {
  const { document: doc, node, bounds, showLayoutGuides = true } = props;
  if (resolveNode(doc, node).hidden) return null;
  if (
    !isBoardLodRenderable(doc, node.id, bounds) ||
    (showLayoutGuides && branchHasLayoutGuides(doc, node.id))
  ) {
    return (
      <CanvasNode
        document={doc}
        node={node}
        selection={inactiveSelection}
        editing={null}
        showLayoutGuides={showLayoutGuides}
      />
    );
  }
  return <TileDisplay {...props} />;
});

function TileDisplay({
  document: doc,
  node,
  rect,
  bounds,
  zoom,
  dpr = globalThis.devicePixelRatio || 1,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const colorSpace = doc.colorProfile ?? "srgb";
  const displayedKey = useRef<string>(undefined);
  const resolved = symbolPaintForView(resolveNode(doc, node), "canvas");
  const s = resolved.style;
  const placeholder = useRef(summaryFill(doc, resolved));
  const { width, height } = computeTileResolution(
    rect.width,
    rect.height,
    zoom,
    dpr,
  );

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    return () => {
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    };
  }, [colorSpace]);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    return boardTileCache.request(
      doc,
      node.id,
      bounds,
      width,
      height,
      (tile, key) => {
        if (displayedKey.current === key && canvas.width) return;
        const ctx = canvas.getContext("2d", {
          colorSpace,
        });
        if (!ctx) return;
        canvas.width = tile.width;
        canvas.height = tile.height;
        ctx.drawImage(tile.canvas, 0, 0);
        displayedKey.current = key;
        host.style.background = "transparent";
      },
    );
  }, [doc, node.id, bounds, width, height, colorSpace]);

  return (
    <div
      data-node-id={node.id}
      data-node-type={node.type}
      data-lod="cached"
      className="design-node board-lod-tile"
      style={{
        position: "absolute",
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        borderRadius: s.corners
          ? [s.corners.tl, s.corners.tr, s.corners.br, s.corners.bl]
              .map((r) => r + "px")
              .join(" ")
          : s.radius,
        background: placeholder.current,
        overflow: s.clipContent ? "hidden" : "visible",
        contain: s.clipContent ? undefined : "layout style",
        pointerEvents: "auto",
        transform:
          s.rotation || s.flipX || s.flipY
            ? `rotate(${s.rotation ?? 0}deg) scale(${s.flipX ? -1 : 1}, ${s.flipY ? -1 : 1})`
            : undefined,
      }}
    >
      <canvas
        key={doc.colorProfile ?? "srgb"}
        ref={canvasRef}
        className="board-lod-canvas"
        aria-hidden="true"
        width={0}
        height={0}
        style={{
          width: "100%",
          height: "100%",
          display: "block",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
