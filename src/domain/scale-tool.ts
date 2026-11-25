import type { DesignDocument, DesignNode, NodeStyle } from "./document";
import type { Operation } from "./commands";
import { layoutBounds, union } from "./geometry";
import { instanceAncestor, isLocked, selectionRoots } from "./tree";

export type ScaleAnchor =
  "tl" | "tc" | "tr" | "ml" | "mc" | "mr" | "bl" | "bc" | "br";

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function scaleValue(
  value: number,
  factor: number,
  min: number,
  max: number,
): number {
  return clamp(round(value * factor), min, max);
}

function anchorPoint(
  box: { x: number; y: number; width: number; height: number },
  anchor: ScaleAnchor,
): { x: number; y: number } {
  const row = anchor[0];
  const col = anchor[1];
  const x =
    col === "l"
      ? box.x
      : col === "c"
        ? box.x + box.width / 2
        : box.x + box.width;
  const y =
    row === "t"
      ? box.y
      : row === "m"
        ? box.y + box.height / 2
        : box.y + box.height;
  return { x, y };
}

/**
 * Plan proportional scaling operations (Scale Tool `K`) for the selected layers
 * and their recursive descendants, scaling geometry, typography, corners, strokes,
 * auto-layout spacing, and effects relative to the chosen 9-point anchor.
 * Respects locked layers and component instance structural protection.
 */
export function planScaleSelection(
  doc: DesignDocument,
  ids: string[],
  factor: number,
  anchor: ScaleAnchor = "tl",
): Operation[] {
  if (!Number.isFinite(factor) || factor <= 0)
    throw new Error("缩放比例必须大于 0");
  if (factor === 1 || !ids.length) return [];

  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const childrenMap = new Map<string, DesignNode[]>();
  for (const n of doc.nodes) {
    if (!n.parentId) continue;
    const list = childrenMap.get(n.parentId);
    if (list) list.push(n);
    else childrenMap.set(n.parentId, [n]);
  }

  const roots = selectionRoots(doc, ids).filter(
    (n) => !isLocked(doc, n.id) && !instanceAncestor(doc, n.id),
  );
  if (!roots.length) return [];

  const bounds = layoutBounds(doc);
  const rootBoxes = roots
    .map((r) => bounds.get(r.id))
    .filter((b): b is NonNullable<typeof b> => Boolean(b));
  const selectionBox = union(rootBoxes);
  if (!selectionBox) return [];

  const origin = anchorPoint(selectionBox, anchor);
  const operations: Operation[] = [];

  function scaleNodeStyle(
    node: DesignNode,
    pos: { x: number; y: number } | null,
    isInstanceRoot: boolean,
  ): { patch: Partial<DesignNode>; style: Partial<NodeStyle> } {
    const s = node.style;
    const next: Partial<NodeStyle> = {
      width: scaleValue(s.width, factor, 1, 10000),
      height: scaleValue(s.height, factor, 1, 10000),
      radius: scaleValue(s.radius, factor, 0, 10000),
      fontSize: scaleValue(s.fontSize, factor, 1, 500),
    };

    if (pos) {
      next.x = round(pos.x);
      next.y = round(pos.y);
    }

    if (s.minWidth !== undefined)
      next.minWidth = scaleValue(s.minWidth, factor, 1, 10000);
    if (s.maxWidth !== undefined)
      next.maxWidth = scaleValue(s.maxWidth, factor, 1, 10000);
    if (
      next.minWidth !== undefined &&
      next.maxWidth !== undefined &&
      next.minWidth > next.maxWidth
    ) {
      next.minWidth = next.maxWidth;
    }

    if (s.minHeight !== undefined)
      next.minHeight = scaleValue(s.minHeight, factor, 1, 10000);
    if (s.maxHeight !== undefined)
      next.maxHeight = scaleValue(s.maxHeight, factor, 1, 10000);
    if (
      next.minHeight !== undefined &&
      next.maxHeight !== undefined &&
      next.minHeight > next.maxHeight
    ) {
      next.minHeight = next.maxHeight;
    }

    // Typography
    if (s.lineHeight !== undefined)
      next.lineHeight = scaleValue(s.lineHeight, factor, 1, 1000);
    if (s.letterSpacing !== undefined)
      next.letterSpacing = scaleValue(s.letterSpacing, factor, -50, 200);

    // Individual corners
    if (s.corners) {
      next.corners = {
        tl: scaleValue(s.corners.tl, factor, 0, 10000),
        tr: scaleValue(s.corners.tr, factor, 0, 10000),
        br: scaleValue(s.corners.br, factor, 0, 10000),
        bl: scaleValue(s.corners.bl, factor, 0, 10000),
      };
    }

    // Strokes
    if (s.strokeWidth !== undefined)
      next.strokeWidth = scaleValue(s.strokeWidth, factor, 0, 100);
    if (s.strokeSides) {
      next.strokeSides = {
        ...(s.strokeSides.top !== undefined
          ? { top: scaleValue(s.strokeSides.top, factor, 0, 64) }
          : {}),
        ...(s.strokeSides.right !== undefined
          ? { right: scaleValue(s.strokeSides.right, factor, 0, 64) }
          : {}),
        ...(s.strokeSides.bottom !== undefined
          ? { bottom: scaleValue(s.strokeSides.bottom, factor, 0, 64) }
          : {}),
        ...(s.strokeSides.left !== undefined
          ? { left: scaleValue(s.strokeSides.left, factor, 0, 64) }
          : {}),
      };
    }

    // Auto-layout spacing (protected on instance roots)
    if (!isInstanceRoot) {
      next.padding = scaleValue(s.padding, factor, 0, 1000);
      next.gap = scaleValue(s.gap, factor, 0, 1000);
      if (s.rowGap !== undefined)
        next.rowGap = scaleValue(s.rowGap, factor, 0, 1000);
      if (s.insets) {
        next.insets = {
          top: scaleValue(s.insets.top, factor, 0, 1000),
          right: scaleValue(s.insets.right, factor, 0, 1000),
          bottom: scaleValue(s.insets.bottom, factor, 0, 1000),
          left: scaleValue(s.insets.left, factor, 0, 1000),
        };
      }
      if (s.minColumnWidth !== undefined)
        next.minColumnWidth = scaleValue(s.minColumnWidth, factor, 0, 10000);
      if (s.gridRowHeight !== undefined)
        next.gridRowHeight = scaleValue(s.gridRowHeight, factor, 1, 10000);
    }

    // Effects
    if (s.blur !== undefined) next.blur = scaleValue(s.blur, factor, 0, 100);
    if (s.backdropBlur !== undefined)
      next.backdropBlur = scaleValue(s.backdropBlur, factor, 0, 512);
    if (s.shadows?.length) {
      next.shadows = s.shadows.map((shadow) => ({
        ...shadow,
        x: scaleValue(shadow.x, factor, -1000, 1000),
        y: scaleValue(shadow.y, factor, -1000, 1000),
        blur: scaleValue(shadow.blur, factor, 0, 1000),
        spread: scaleValue(shadow.spread, factor, -1000, 1000),
      }));
    }

    const patch: Partial<DesignNode> = {};
    if (node.textRuns?.length) {
      const hasScaledRuns = node.textRuns.some(
        (run) =>
          run.style.fontSize !== undefined ||
          run.style.letterSpacing !== undefined,
      );
      if (hasScaledRuns) {
        patch.textRuns = node.textRuns.map((run) => ({
          ...run,
          style: {
            ...run.style,
            ...(run.style.fontSize !== undefined
              ? { fontSize: scaleValue(run.style.fontSize, factor, 1, 500) }
              : {}),
            ...(run.style.letterSpacing !== undefined
              ? {
                  letterSpacing: scaleValue(
                    run.style.letterSpacing,
                    factor,
                    -100,
                    500,
                  ),
                }
              : {}),
          },
        }));
      }
    }

    return { patch, style: next };
  }

  function visit(node: DesignNode, isRoot: boolean) {
    if (node.locked) return;
    const isInstanceRoot = Boolean(node.instance);
    if (!isRoot && instanceAncestor(doc, node.id)) return;

    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    const inFlow =
      parent?.type === "frame" &&
      parent.style.layout !== "free" &&
      !node.style.absolutePosition;

    let pos: { x: number; y: number } | null = null;
    if (!inFlow) {
      if (isRoot) {
        const box = bounds.get(node.id);
        if (box) {
          const newWorldX = origin.x + (box.x - origin.x) * factor;
          const newWorldY = origin.y + (box.y - origin.y) * factor;
          pos = {
            x: node.style.x + (newWorldX - box.x),
            y: node.style.y + (newWorldY - box.y),
          };
        }
      } else {
        pos = {
          x: node.style.x * factor,
          y: node.style.y * factor,
        };
      }
    }

    const { patch, style } = scaleNodeStyle(node, pos, isInstanceRoot);
    operations.push({
      type: "update",
      id: node.id,
      patch,
      style,
    });

    // Never recurse into a protected component instance's internal children
    if (isInstanceRoot) return;

    for (const child of childrenMap.get(node.id) ?? []) {
      visit(child, false);
    }
  }

  for (const root of roots) {
    visit(root, true);
  }

  return operations;
}
