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
export function hasVisibleVectorStroke(
  n: DesignNode,
  p: Pick<
    EditablePath,
    "strokeWidth" | "strokeColor" | "strokeOpacity" | "opacity"
  >,
) {
  return (
    n.style.strokeVisible !== false &&
    p.strokeWidth > 0 &&
    (p.strokeColor ?? n.style.color) !== "transparent" &&
    (p.strokeOpacity ?? 1) > 0 &&
    (p.opacity ?? 1) > 0 &&
    (!!p.strokeColor || (n.style.colorOpacity ?? 1) > 0)
  );
}

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
export function vectorBounds(paths: EditablePath[], minimumSize = 1): Rect {
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
    width: Math.max(minimumSize, right - left),
    height: Math.max(minimumSize, bottom - top),
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

export const sameAnchor = (a: AnchorIndex, b: AnchorIndex) =>
  a.p === b.p && a.c === b.c && a.a === b.a;

export const anchorKey = ({ p, c, a }: AnchorIndex) => `${p}:${c}:${a}`;

export function allAnchors(paths: EditablePath[]): AnchorIndex[] {
  return paths.flatMap((path, p) =>
    path.contours.flatMap((contour, c) =>
      contour.anchors.map((_, a) => ({ p, c, a })),
    ),
  );
}

function anchorAt(paths: EditablePath[], { p, c, a }: AnchorIndex) {
  return paths[p]?.contours[c]?.anchors[a];
}

export function anchorsInRect(
  paths: EditablePath[],
  rect: Rect,
): AnchorIndex[] {
  return allAnchors(paths).filter((index) => {
    const { x, y } = anchorAt(paths, index)!;
    return (
      x >= rect.x &&
      x <= rect.x + rect.width &&
      y >= rect.y &&
      y <= rect.y + rect.height
    );
  });
}

export function moveNetworkAnchors(
  paths: EditablePath[],
  selected: readonly AnchorIndex[],
  delta: Point,
): void {
  const moving = new Set<Anchor>(),
    junctions = new Set<string>();
  for (const index of selected) {
    const anchor = anchorAt(paths, index);
    if (!anchor) continue;
    moving.add(anchor);
    if (anchor.junction) junctions.add(anchor.junction);
  }
  if (junctions.size) {
    for (const path of paths)
      for (const { anchors } of path.contours)
        for (const a of anchors)
          if (a.junction && junctions.has(a.junction)) moving.add(a);
  }
  for (const a of moving)
    Object.assign(a, moveAnchor(a, { x: a.x + delta.x, y: a.y + delta.y }));
}

export function isDrawableContour({ anchors, closed }: Contour): boolean {
  return (
    anchors.length >= 2 ||
    (closed &&
      anchors.length === 1 &&
      !!(anchors[0].outgoing || anchors[0].incoming))
  );
}

export function removeNetworkAnchors(
  paths: EditablePath[],
  selected: readonly AnchorIndex[],
  keepMinimumPath = true,
): boolean {
  const deletions = new Map<Contour, Set<number>>();
  for (const { p, c, a } of selected) {
    const contour = paths[p]?.contours[c];
    if (!contour?.anchors[a]) continue;
    const indices = deletions.get(contour) ?? new Set<number>();
    indices.add(a);
    deletions.set(contour, indices);
  }
  if (!deletions.size) return false;
  const survivors = new Map<Contour, Contour>();
  for (const [contour, indices] of deletions) {
    const anchors = contour.anchors.filter((_, i) => !indices.has(i));
    const closed =
      contour.closed &&
      (anchors.length > 2 || anchors.some((a) => a.outgoing || a.incoming));
    survivors.set(contour, { anchors, closed });
  }
  const hasSegment = paths.some((path) =>
    path.contours.some((c) => isDrawableContour(survivors.get(c) ?? c)),
  );
  if (keepMinimumPath && !hasSegment) return false;
  for (let i = paths.length - 1; i >= 0; i--) {
    const path = paths[i];
    path.contours = path.contours.filter((c) => {
      const remaining = survivors.get(c);
      if (!remaining) return true;
      Object.assign(c, remaining);
      return hasSegment ? isDrawableContour(c) : c.anchors.length > 0;
    });
    if (!path.contours.length) paths.splice(i, 1);
  }
  return true;
}

export function toggleAnchorsSmooth(
  paths: EditablePath[],
  selected: readonly AnchorIndex[],
): void {
  const sharp = selected.every((index) => {
    const a = anchorAt(paths, index);
    return !a || a.incoming || a.outgoing;
  });
  for (const { p, c, a } of selected) {
    const contour = paths[p]?.contours[c],
      anchor = contour?.anchors[a];
    if (!anchor) continue;
    if (sharp) {
      delete anchor.incoming;
      delete anchor.outgoing;
    } else if (
      !anchor.incoming &&
      !anchor.outgoing &&
      contour.anchors.length > 1
    ) {
      const points = contour.anchors,
        n = points.length;
      const prev = a > 0 || contour.closed ? points[(a + n - 1) % n] : anchor;
      const next = a < n - 1 || contour.closed ? points[(a + 1) % n] : anchor;
      const divisor = prev === anchor || next === anchor ? 3 : 6;
      const dx = (next.x - prev.x) / divisor,
        dy = (next.y - prev.y) / divisor;
      anchor.incoming = { x: anchor.x - dx, y: anchor.y - dy };
      anchor.outgoing = { x: anchor.x + dx, y: anchor.y + dy };
    }
  }
}

export interface SegmentHit {
  p: number;
  c: number;
  index: number;
  t: number;
  point: Point;
  distance: number;
}

export function evalSegmentPoint(a: Anchor, b: Anchor, t: number): Point {
  if (!a.outgoing && !b.incoming) return mix(a, b, t);
  const u = 1 - t,
    c1 = a.outgoing ?? a,
    c2 = b.incoming ?? b;
  return {
    x:
      u * u * u * a.x +
      3 * u * u * t * c1.x +
      3 * u * t * t * c2.x +
      t * t * t * b.x,
    y:
      u * u * u * a.y +
      3 * u * u * t * c1.y +
      3 * u * t * t * c2.y +
      t * t * t * b.y,
  };
}

function nearestParameter(a: Anchor, b: Anchor, target: Point) {
  if (!a.outgoing && !b.incoming) {
    const dx = b.x - a.x,
      dy = b.y - a.y,
      lengthSquared = dx * dx + dy * dy;
    return lengthSquared
      ? Math.max(
          0,
          Math.min(
            1,
            ((target.x - a.x) * dx + (target.y - a.y) * dy) / lengthSquared,
          ),
        )
      : 0;
  }
  const squared = (t: number) => {
    const point = evalSegmentPoint(a, b, t);
    return (point.x - target.x) ** 2 + (point.y - target.y) ** 2;
  };
  const steps = 24;
  const samples = Array.from({ length: steps + 1 }, (_, i) =>
    squared(i / steps),
  );
  let best = samples[0] <= samples[steps] ? 0 : 1,
    bestDistance = squared(best);
  // Refine each sampled minimum, including the two endpoint intervals on looping cubics.
  for (let i = 0; i <= steps; i++) {
    if (
      samples[i] > (samples[i - 1] ?? Infinity) ||
      samples[i] > (samples[i + 1] ?? Infinity)
    )
      continue;
    let lo = Math.max(0, (i - 1) / steps),
      hi = Math.min(1, (i + 1) / steps);
    for (let j = 0; j < 36; j++) {
      const third = (hi - lo) / 3;
      if (squared(lo + third) < squared(hi - third)) hi -= third;
      else lo += third;
    }
    const mid = (lo + hi) / 2,
      t = squared(mid) < samples[i] ? mid : i / steps;
    const distance = squared(t);
    if (distance < bestDistance) {
      best = t;
      bestDistance = distance;
    }
  }
  return best;
}

export function nearestSegmentPoint(
  paths: EditablePath[],
  target: Point,
  maxDistance: number,
): SegmentHit | null {
  let best: SegmentHit | null = null;
  for (const [p, path] of paths.entries())
    for (const [c, contour] of path.contours.entries()) {
      const points = contour.anchors;
      if (!isDrawableContour(contour)) continue;
      const count = points.length - (contour.closed ? 0 : 1);
      for (let index = 0; index < count; index++) {
        const a = points[index],
          b = points[(index + 1) % points.length],
          c1 = a.outgoing ?? a,
          c2 = b.incoming ?? b;
        const limit = best?.distance ?? maxDistance;
        if (
          target.x < Math.min(a.x, b.x, c1.x, c2.x) - limit ||
          target.x > Math.max(a.x, b.x, c1.x, c2.x) + limit ||
          target.y < Math.min(a.y, b.y, c1.y, c2.y) - limit ||
          target.y > Math.max(a.y, b.y, c1.y, c2.y) + limit
        )
          continue;
        const t = nearestParameter(a, b, target),
          point = evalSegmentPoint(a, b, t);
        const distance = Math.hypot(point.x - target.x, point.y - target.y);
        if (distance <= maxDistance && (!best || distance < best.distance))
          best = { p, c, index, t, point, distance };
      }
    }
  return best;
}

export function bendSegment(
  paths: EditablePath[],
  hit: Pick<SegmentHit, "p" | "c" | "index" | "t">,
  targetPoint: Point,
): boolean {
  const contour = paths[hit.p]?.contours[hit.c],
    points = contour?.anchors;
  if (
    !points ||
    !isDrawableContour(contour) ||
    !points[hit.index] ||
    (!contour.closed && hit.index === points.length - 1) ||
    ![hit.t, targetPoint.x, targetPoint.y].every(Number.isFinite)
  )
    return false;
  const a = points[hit.index],
    b = points[(hit.index + 1) % points.length];
  // Real hits are on [0, 1]. Preserve endpoint behavior for out-of-range callers.
  const basePoint =
    hit.t < 0 ? a : hit.t > 1 ? b : evalSegmentPoint(a, b, hit.t);
  const t = Math.max(0.15, Math.min(0.85, hit.t)),
    u = 1 - t;
  if (!a.outgoing && !b.incoming) {
    a.outgoing = mix(a, b, 1 / 3);
    b.incoming = mix(a, b, 2 / 3);
  }
  const dx = targetPoint.x - basePoint.x,
    dy = targetPoint.y - basePoint.y;
  const w1 = 3 * u * u * t,
    w2 = 3 * u * t * t,
    denom = w1 * w1 + w2 * w2;
  const c1 = a.outgoing ?? a,
    c2 = b.incoming ?? b;
  a.outgoing = { x: c1.x + (dx * w1) / denom, y: c1.y + (dy * w1) / denom };
  b.incoming = { x: c2.x + (dx * w2) / denom, y: c2.y + (dy * w2) / denom };
  return true;
}
