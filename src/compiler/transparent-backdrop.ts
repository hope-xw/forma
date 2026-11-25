import type { DesignDocument, DesignNode } from "../domain/document";
import { resolveNode } from "../domain/design-system";
import { intersects, layoutBounds, type Rect } from "../domain/geometry";
import { childrenOf, findLayer } from "../domain/scene-index";

function paintsOutsideBox(n: DesignNode) {
  const s = n.style;
  return !!(
    s.rotation ||
    s.flipX ||
    s.flipY ||
    (s.blur && s.blurVisible !== false) ||
    s.shadows?.some((e) => e.visible !== false && !e.inset && e.opacity > 0) ||
    ((s.strokeWidth || s.strokeSides) && s.strokeAlign !== "inside") ||
    n.vector?.overflowVisible
  );
}

// CSS Color Burn produces source pixels even on a transparent backing. On
// uncovered pixels the native blend equation instead contributes the source
// color exactly once. Check the actual drawing order and measured layer boxes.
export function hasClearBackdrop(node: DesignNode, doc: DesignDocument) {
  let boxes: Map<string, Rect> | undefined;
  function covers(raw: DesignNode): boolean {
    const n = resolveNode(doc, raw),
      s = n.style;
    if (n.hidden || s.opacity === 0 || n.type === "slice") return false;
    if (paintsOutsideBox(n)) return true;
    boxes ??= layoutBounds(doc);
    const target = boxes.get(node.id),
      bound = boxes.get(n.id);
    if (!target || !bound || intersects(target, bound)) return true;
    return !s.clipContent && childrenOf(doc, n.id).some(covers);
  }
  function borderReaches(n: DesignNode) {
    const s = n.style;
    if (s.strokeVisible === false || (!s.strokeWidth && !s.strokeSides))
      return false;
    boxes ??= layoutBounds(doc);
    const target = boxes.get(node.id),
      bound = boxes.get(n.id);
    if (!target || !bound) return true;
    const inset =
      Math.max(s.radius, ...Object.values(s.corners ?? {})) +
      Math.max(s.strokeWidth ?? 0, ...Object.values(s.strokeSides ?? {}));
    return (
      target.x < bound.x + inset ||
      target.y < bound.y + inset ||
      target.x + target.width > bound.x + bound.width - inset ||
      target.y + target.height > bound.y + bound.height - inset
    );
  }
  let branch: DesignNode | undefined = node;
  while (branch) {
    const rawParent = findLayer(doc, branch.parentId);
    const parent = rawParent && resolveNode(doc, rawParent);
    if (parent) {
      const s = parent.style;
      if (
        paintsOutsideBox(parent) ||
        parent.image ||
        s.tint ||
        s.figmaGlass?.visible ||
        s.backdropBlur ||
        s.backdropBrightness !== undefined ||
        s.shadows?.some((e) => e.visible !== false && e.opacity > 0) ||
        (parent.type !== "group" &&
          ((s.fillOpacity ?? 1) > 0 || s.paints?.some((p) => p.visible))) ||
        borderReaches(parent)
      )
        return false;
    }
    for (const earlier of childrenOf(doc, branch.parentId)) {
      if (earlier.id === branch.id) break;
      if (covers(earlier)) return false;
    }
    branch = parent;
  }
  return true;
}
