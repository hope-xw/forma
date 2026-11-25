import type { DesignDocument, DesignNode } from "./document";
import type { Point, Rect } from "./geometry";
import {
  childrenOf,
  findLayer,
  isPublished,
  positionDelta,
} from "./scene-index";
export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}
export const identity: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
export const vector = (m: Matrix, p: Point) => ({
  x: m.a * p.x + m.c * p.y,
  y: m.b * p.x + m.d * p.y,
});
export const transform = (m: Matrix, p: Point) => ({
  x: m.a * p.x + m.c * p.y + m.e,
  y: m.b * p.x + m.d * p.y + m.f,
});
export function inverse(m: Matrix): Matrix {
  const det = m.a * m.d - m.b * m.c;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}
export function compose(m: Matrix, n: Matrix): Matrix {
  const x = vector(m, { x: n.a, y: n.b }),
    y = vector(m, { x: n.c, y: n.d }),
    t = transform(m, { x: n.e, y: n.f });
  return { a: x.x, b: x.y, c: y.x, d: y.y, e: t.x, f: t.y };
}
export function localTransform(n: DesignNode, r: Rect): Matrix {
  const theta = ((n.style.rotation ?? 0) * Math.PI) / 180,
    cos = Math.cos(theta),
    sin = Math.sin(theta),
    x = n.style.flipX ? -1 : 1,
    y = n.style.flipY ? -1 : 1;
  const m = { a: cos * x, b: sin * x, c: -sin * y, d: cos * y, e: 0, f: 0 };
  const center = { x: r.x + r.width / 2, y: r.y + r.height / 2 },
    p = vector(m, center);
  return { ...m, e: center.x - p.x, f: center.y - p.y };
}
const transformCache = new WeakMap<
  DesignDocument,
  { boxes: Map<string, Rect>; result: Map<string, Matrix> }
>();
export function sceneTransforms(doc: DesignDocument, boxes: Map<string, Rect>) {
  const cached = transformCache.get(doc);
  if (cached?.boxes === boxes) return cached.result;
  const delta = positionDelta(doc);
  if (delta) {
    const baseCached = transformCache.get(delta.base);
    if (baseCached) {
      let needsUpdate = false;
      const checkSubtree = (id: string) => {
        if (needsUpdate) return;
        const n = findLayer(doc, id);
        if (!n) return;
        if (n.style.rotation || n.style.flipX || n.style.flipY) {
          needsUpdate = true;
          return;
        }
        const prevM = baseCached.result.get(id);
        if (prevM && prevM !== identity) {
          needsUpdate = true;
          return;
        }
        for (const child of childrenOf(doc, id)) checkSubtree(child.id);
      };
      for (const [id, move] of delta.moved) {
        if (move.rotationChanged) {
          needsUpdate = true;
          break;
        }
        checkSubtree(id);
      }
      if (!needsUpdate) {
        transformCache.set(doc, { boxes, result: baseCached.result });
        return baseCached.result;
      }
      const result = new Map(baseCached.result);
      const updateSubtree = (n: DesignNode, parentMatrix: Matrix) => {
        const matrix =
          n.style.rotation || n.style.flipX || n.style.flipY
            ? compose(parentMatrix, localTransform(n, boxes.get(n.id)!))
            : parentMatrix;
        result.set(n.id, matrix);
        for (const child of childrenOf(doc, n.id)) updateSubtree(child, matrix);
      };
      for (const id of delta.moved.keys()) {
        const n = findLayer(doc, id);
        if (!n) continue;
        const parentMatrix = n.parentId
          ? (result.get(n.parentId) ?? identity)
          : identity;
        updateSubtree(n, parentMatrix);
      }
      transformCache.set(doc, { boxes, result });
      return result;
    }
  }
  const result = new Map<string, Matrix>();
  const useIndex = isPublished(doc);
  const nodes = useIndex ? null : new Map(doc.nodes.map((n) => [n.id, n]));
  function visit(n: DesignNode): Matrix {
    const existing = result.get(n.id);
    if (existing) return existing;
    const parentNode = n.parentId
      ? useIndex
        ? findLayer(doc, n.parentId)!
        : nodes!.get(n.parentId)!
      : null;
    const parent = parentNode ? visit(parentNode) : identity;
    const matrix =
      n.style.rotation || n.style.flipX || n.style.flipY
        ? compose(parent, localTransform(n, boxes.get(n.id)!))
        : parent;
    result.set(n.id, matrix);
    return matrix;
  }
  doc.nodes.forEach(visit);
  transformCache.set(doc, { boxes, result });
  return result;
}
export function visualBounds(r: Rect, m: Matrix) {
  if (m === identity) return r;
  const points = [
    r,
    { x: r.x + r.width, y: r.y },
    { x: r.x, y: r.y + r.height },
    { x: r.x + r.width, y: r.y + r.height },
  ].map((p) => transform(m, p));
  const xs = points.map((p) => p.x),
    ys = points.map((p) => p.y),
    x = Math.min(...xs),
    y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
export const degrees = (angle: number) =>
  Math.round((((((angle + 180) % 360) + 360) % 360) - 180) * 100) / 100;
/** Express a layer in its new parent's coordinates without moving its painted center or changing its orientation. */
export function poseInParent(
  n: DesignNode,
  r: Rect,
  source: Matrix,
  parent: Rect | undefined,
  destination: Matrix,
  delta: Point = { x: 0, y: 0 },
) {
  const inv = inverse(destination),
    center = transform(source, { x: r.x + r.width / 2, y: r.y + r.height / 2 });
  const p = transform(inv, { x: center.x + delta.x, y: center.y + delta.y });
  const relative = compose(inv, source),
    fx = n.style.flipX ?? false,
    fy = relative.a * relative.d - relative.b * relative.c < 0 ? !fx : fx;
  const angle = degrees(
    (Math.atan2(fx ? -relative.b : relative.b, fx ? -relative.a : relative.a) *
      180) /
      Math.PI,
  );
  return {
    x: p.x - r.width / 2 - (parent?.x ?? 0),
    y: p.y - r.height / 2 - (parent?.y ?? 0),
    ...(angle || n.style.rotation ? { rotation: angle } : {}),
    ...(fy || n.style.flipY ? { flipY: fy } : {}),
  };
}
