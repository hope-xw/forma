import type { DesignNode } from "./document";
import type { Point, Rect } from "./geometry";
import { pathData } from "./vector-path";

export type ShapeTool = "rectangle" | "ellipse" | "line" | "polygon" | "star";
type Vector = NonNullable<DesignNode["vector"]>;
export type RadialShape = NonNullable<Vector["radial"]>;
export function defaultRadial(kind: "polygon" | "star"): RadialShape {
  return kind === "star"
    ? { kind, points: 5, innerRatio: 0.45 }
    : { kind, points: 3 };
}
/** A closed regular polygon, scaled to its actual outer bounds, independent of the number of sides. */
export function radialVector(
  radial: RadialShape,
  width: number,
  height: number,
  previous?: Vector,
): Vector {
  const total = radial.kind === "star" ? radial.points * 2 : radial.points;
  const points = Array.from({ length: total }, (_, i) => {
    const angle = (i / total - 0.25) * 2 * Math.PI;
    const r = radial.kind === "star" && i % 2 ? radial.innerRatio : 1;
    return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
  });
  const xs = points.map((p) => p.x),
    ys = points.map((p) => p.y);
  const left = Math.min(...xs),
    top = Math.min(...ys);
  const w = Math.max(...xs) - left,
    h = Math.max(...ys) - top;
  const anchors = points.map((p) => ({
    x: ((p.x - left) * width) / w,
    y: ((p.y - top) * height) / h,
  }));
  return {
    width,
    height,
    stretch: true,
    radial,
    paths: [
      {
        fill: true,
        strokeWidth: 0,
        ...previous?.paths[0],
        d: pathData([{ closed: true, anchors }]),
      },
    ],
  };
}
export function lineEndpoint(start: Point, end: Point, snap: boolean): Point {
  if (!snap) return end;
  const dx = end.x - start.x,
    dy = end.y - start.y,
    length = Math.hypot(dx, dy);
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return {
    x: start.x + length * Math.cos(angle),
    y: start.y + length * Math.sin(angle),
  };
}
export function drawnLine(
  start: Point,
  end: Point,
): { rect: Rect; vector: Vector } {
  const strokeWidth = 2,
    half = strokeWidth / 2;
  const rect = {
    x: Math.min(start.x, end.x) - half,
    y: Math.min(start.y, end.y) - half,
    width: Math.abs(end.x - start.x) + strokeWidth,
    height: Math.abs(end.y - start.y) + strokeWidth,
  };
  const anchors = [start, end].map((p) => ({
    x: p.x - rect.x,
    y: p.y - rect.y,
  }));
  return {
    rect,
    vector: {
      width: rect.width,
      height: rect.height,
      stretch: true,
      paths: [
        {
          fill: false,
          strokeWidth,
          lineCap: "round",
          d: pathData([{ closed: false, anchors }]),
        },
      ],
    },
  };
}
