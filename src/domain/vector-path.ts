import svgpath from "svgpath";
import type { Point, Rect } from "./geometry";
import type { DesignNode } from "./document";
export interface Anchor extends Point {
  junction?: string;
  incoming?: Point;
  outgoing?: Point;
}
export interface Contour {
  anchors: Anchor[];
  closed: boolean;
}
export type EditablePath = Omit<
  NonNullable<DesignNode["vector"]>["paths"][number],
  "d" | "junctions"
> & { contours: Contour[] };
const mix = (a: Point, b: Point, t: number) => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
export function readContours(d: string) {
  const contours: Contour[] = [];
  let contour: Contour;
  svgpath(d)
    .abs()
    .unshort()
    .unarc()
    .iterate((s, _i, x, y) => {
      if (s[0] === "M") {
        contour = { anchors: [{ x: s[1], y: s[2] }], closed: false };
        contours.push(contour);
        return;
      }
      if (!contour) return;
      const points = contour.anchors,
        last = points.at(-1)!;
      switch (s[0]) {
        case "L":
          points.push({ x: s[1], y: s[2] });
          break;
        case "H":
          points.push({ x: s[1], y });
          break;
        case "V":
          points.push({ x, y: s[1] });
          break;
        case "C":
          last.outgoing = { x: s[1], y: s[2] };
          points.push({ x: s[5], y: s[6], incoming: { x: s[3], y: s[4] } });
          break;
        case "Q": {
          const q = { x: s[1], y: s[2] },
            end = { x: s[3], y: s[4] };
          last.outgoing = mix(last, q, 2 / 3);
          points.push({ ...end, incoming: mix(end, q, 2 / 3) });
          break;
        }
        case "Z":
        case "z":
          contour.closed = true;
          if (
            points.length > 1 &&
            last.x === points[0].x &&
            last.y === points[0].y
          ) {
            points[0].incoming = last.incoming;
            points.pop();
          }
          break;
      }
    });
  return contours;
}
const xy = (p: Point) => [p.x, p.y].map((v) => Number(v.toFixed(5))).join(" ");
export function pathData(contours: Contour[]): string {
  return contours
    .map(({ anchors, closed }) => {
      if (!anchors.length) return "";
      const commands = ["M" + xy(anchors[0])];
      for (let i = 1; i < anchors.length + (closed ? 1 : 0); i++) {
        const a = anchors[i - 1],
          b = anchors[i % anchors.length];
        if (a.outgoing || b.incoming)
          commands.push(
            "C" + xy(a.outgoing ?? a) + " " + xy(b.incoming ?? b) + " " + xy(b),
          );
        else if (i < anchors.length) commands.push("L" + xy(b));
      }
      if (closed) commands.push("Z");
      return commands.join(" ");
    })
    .join(" ");
}
export function moveAnchor(anchor: Anchor, to: Point) {
  const shift = (p: Point) => ({
    x: p.x + to.x - anchor.x,
    y: p.y + to.y - anchor.y,
  });
  return {
    ...anchor,
    ...to,
    incoming: anchor.incoming && shift(anchor.incoming),
    outgoing: anchor.outgoing && shift(anchor.outgoing),
  };
}
export function splitSegment(contour: Contour, index: number) {
  const a = contour.anchors[index],
    b = contour.anchors[(index + 1) % contour.anchors.length];
  if (!a || !b || (!contour.closed && index === contour.anchors.length - 1))
    return;
  if (!a.outgoing && !b.incoming) {
    contour.anchors.splice(index + 1, 0, mix(a, b, 0.5));
    return;
  }
  const u = mix(a, a.outgoing ?? a, 0.5),
    v = mix(a.outgoing ?? a, b.incoming ?? b, 0.5),
    w = mix(b.incoming ?? b, b, 0.5),
    left = mix(u, v, 0.5),
    right = mix(v, w, 0.5);
  a.outgoing = u;
  b.incoming = w;
  contour.anchors.splice(index + 1, 0, {
    ...mix(left, right, 0.5),
    incoming: left,
    outgoing: right,
  });
}
export function mapContours(
  contours: Contour[],
  fn: (p: Point) => Point,
): Contour[] {
  return contours.map((c) => ({
    ...c,
    anchors: c.anchors.map((a) => ({
      ...fn(a),
      incoming: a.incoming && fn(a.incoming),
      outgoing: a.outgoing && fn(a.outgoing),
    })),
  }));
}
/** Cubic extrema give the actual painted bounds, including round stroke caps. */
export function vectorBounds(paths: EditablePath[]): Rect {
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const path of paths)
    for (const { anchors, closed } of path.contours) {
      const half = path.strokeWidth / 2;
      const add = (p: Point) => {
        left = Math.min(left, p.x - half);
        right = Math.max(right, p.x + half);
        top = Math.min(top, p.y - half);
        bottom = Math.max(bottom, p.y + half);
      };
      anchors.forEach(add);
      for (let i = 0; i < anchors.length - (closed ? 0 : 1); i++) {
        const a = anchors[i],
          d = anchors[(i + 1) % anchors.length],
          b = a.outgoing ?? a,
          c = d.incoming ?? d;
        for (const key of ["x", "y"] as const) {
          const A = -a[key] + 3 * b[key] - 3 * c[key] + d[key],
            B = 2 * (a[key] - 2 * b[key] + c[key]),
            C = b[key] - a[key],
            disc = B * B - 4 * A * C;
          const roots =
            Math.abs(A) < 1e-10
              ? Math.abs(B) < 1e-10
                ? []
                : [-C / B]
              : disc < 0
                ? []
                : [
                    (-B + Math.sqrt(disc)) / (2 * A),
                    (-B - Math.sqrt(disc)) / (2 * A),
                  ];
          for (const t of roots)
            if (t > 0 && t < 1)
              add(
                mix(
                  mix(mix(a, b, t), mix(b, c, t), t),
                  mix(mix(b, c, t), mix(c, d, t), t),
                  t,
                ),
              );
        }
      }
    }
  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}
export const editablePaths = (
  v: NonNullable<DesignNode["vector"]>,
): EditablePath[] =>
  v.paths.map(({ d, junctions, ...paint }) => {
    const contours = readContours(d);
    for (const link of junctions ?? []) {
      const a = contours[link.contour]?.anchors[link.anchor];
      if (a) a.junction = link.id;
    }
    return { ...paint, contours };
  });

export type AnchorIndex = { p: number; c: number; a: number };
export function moveNetworkAnchor(
  paths: EditablePath[],
  at: AnchorIndex,
  to: Point,
) {
  const origin = paths[at.p].contours[at.c].anchors[at.a];
  for (const path of paths)
    for (const contour of path.contours)
      contour.anchors = contour.anchors.map((a) =>
        a === origin || (origin.junction && a.junction === origin.junction)
          ? moveAnchor(a, to)
          : a,
      );
}
/** A chord divides one closed contour into independently painted regions. Open branches share their endpoint IDs. */
export function branchVector(
  paths: EditablePath[],
  from: AnchorIndex,
  point: Point,
  target?: AnchorIndex,
) {
  const path = paths[from.p],
    contour = path.contours[from.c],
    start = contour.anchors[from.a];
  const end = target
    ? paths[target.p].contours[target.c].anchors[target.a]
    : undefined;
  if (end === start || (end?.junction && end.junction === start.junction))
    throw Error("请选择另一个锚点");
  if (target && target.p === from.p && target.c === from.c && contour.closed) {
    if (path.contours.length !== 1) throw Error("请先选择单轮廓区域");
    const [i, j] = [from.a, target.a].sort((a, b) => a - b);
    if (j - i === 1 || j - i === contour.anchors.length - 1)
      throw Error("相邻锚点已有连线");
    start.junction ??= crypto.randomUUID();
    end!.junction ??= crypto.randomUUID();
    const region = (anchors: Anchor[]) => {
      const copy = structuredClone(anchors);
      delete copy[0].incoming;
      delete copy[copy.length - 1].outgoing;
      return { closed: true, anchors: copy };
    };
    const left = region(contour.anchors.slice(i, j + 1));
    const right = region([
      ...contour.anchors.slice(j),
      ...contour.anchors.slice(0, i + 1),
    ]);
    paths.splice(
      from.p,
      1,
      { ...path, contours: [left] },
      { ...path, contours: [right] },
    );
    return;
  }
  start.junction ??= crypto.randomUUID();
  if (end) end.junction ??= crypto.randomUUID();
  paths.push({
    fill: false,
    strokeWidth: path.strokeWidth || 1,
    strokeColor: path.strokeColor ?? path.fillColor,
    contours: [
      {
        closed: false,
        anchors: [
          { x: start.x, y: start.y, junction: start.junction },
          {
            x: end?.x ?? point.x,
            y: end?.y ?? point.y,
            junction: end?.junction,
          },
        ],
      },
    ],
  });
}
export function encodeVector(
  paths: EditablePath[],
  box: Rect,
): NonNullable<DesignNode["vector"]> {
  return {
    width: box.width,
    height: box.height,
    paths: paths.map(({ contours, ...paint }) => {
      const junctions = contours.flatMap((c, contour) =>
        c.anchors.flatMap((a, anchor) =>
          a.junction ? [{ contour, anchor, id: a.junction }] : [],
        ),
      );
      return {
        ...paint,
        ...(junctions.length ? { junctions } : {}),
        d: pathData(
          mapContours(contours, (v) => ({ x: v.x - box.x, y: v.y - box.y })),
        ),
      };
    }),
  };
}
