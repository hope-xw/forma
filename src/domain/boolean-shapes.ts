import { roundedContour } from "./stroke";
import { svgImagePaint } from "./images";
import paper from "paper";
import svgpath from "svgpath";
import type { DesignDocument, DesignNode } from "./document";
import { resolveNode } from "./design-system";
import { childrenOf } from "./scene-index";
import { localTransform } from "./transforms";
import { wrapOperations } from "./editing";
import { instanceOwner, isLocked, selectionRoots } from "./tree";
export type BooleanOperation = "union" | "subtract" | "intersect" | "exclude";
export const booleanNames: Record<BooleanOperation, string> = {
  union: "联集",
  subtract: "减去顶层",
  intersect: "交集",
  exclude: "排除重叠",
};
let scope: paper.PaperScope | undefined;
function kernel() {
  if (!scope) {
    scope = new paper.PaperScope();
    scope.setup(new scope.Size(1, 1));
  }
  return scope;
}
function primitivePath(n: DesignNode) {
  const { width, height } = n.style;
  return roundedContour(width, height, n.style, n.type === "ellipse");
}
export function canCombine(doc: DesignDocument, ids: string[]) {
  const nodes = selectionRoots(doc, ids);
  return (
    nodes.length >= 2 &&
    nodes.every(
      (n) =>
        n.parentId === nodes[0].parentId &&
        !instanceOwner(doc, n.id) &&
        !isLocked(doc, n.id) &&
        (n.type === "rectangle" ||
          n.type === "ellipse" ||
          n.booleanOperation ||
          (n.type === "vector" && n.vector?.paths.every((p) => p.fill))),
    )
  );
}
export function combineShapes(
  doc: DesignDocument,
  ids: string[],
  operation: BooleanOperation,
) {
  if (!canCombine(doc, ids))
    throw new Error("请选择同级、可编辑的矩形、椭圆、闭合填充矢量或布尔组");
  const result = wrapOperations(doc, ids, "group");
  const first = resolveNode(doc, selectionRoots(doc, ids)[0]);
  result.operations.push({
    type: "update",
    id: result.id,
    patch: { name: booleanNames[operation], booleanOperation: operation },
    style: {
      color:
        first.type === "vector" || first.booleanOperation
          ? first.style.color
          : first.style.fill,
    },
  });
  return result;
}
function operand(doc: DesignDocument, n: DesignNode) {
  const api = kernel(),
    v = n.booleanOperation ? booleanVector(doc, n) : n.vector;
  if (n.booleanOperation && !v) return new api.CompoundPath({ insert: false });
  const paths = v
    ? v.paths
        .filter((p) => p.fill)
        .map((p) => {
          const scale = Math.min(
            n.style.width / v.width,
            n.style.height / v.height,
          );
          const sx = v.stretch ? n.style.width / v.width : scale,
            sy = v.stretch ? n.style.height / v.height : scale;
          return {
            d: svgpath(p.d)
              .scale(sx, sy)
              .translate(
                (n.style.width - v.width * sx) / 2,
                (n.style.height - v.height * sy) / 2,
              )
              .toString(),
            rule: p.fillRule,
          };
        })
    : [{ d: primitivePath(n), rule: undefined }];
  const m = localTransform(n, n.style);
  let item: paper.PathItem | undefined;
  for (const path of paths) {
    const d = svgpath(path.d)
      .translate(n.style.x, n.style.y)
      .matrix([m.a, m.b, m.c, m.d, m.e, m.f])
      .toString();
    const next = new api.CompoundPath({
      pathData: d,
      fillRule: path.rule ?? "nonzero",
      insert: false,
    });
    item = item ? item.unite(next, { insert: false }) : next;
  }
  return item ?? new api.CompoundPath({ insert: false });
}
export function vectorClipPath(doc: DesignDocument, source: DesignNode) {
  const p = operand(doc, resolveNode(doc, source));
  return p.pathData
    ? "path(" +
        (p.fillRule === "evenodd" ? "evenodd, " : "") +
        JSON.stringify(p.pathData) +
        ")"
    : "inset(100%)";
}
type Vector = NonNullable<DesignNode["vector"]>;
const cache = new WeakMap<DesignDocument, Map<string, Vector | null>>();
export function booleanVector(
  doc: DesignDocument,
  n: DesignNode,
): Vector | null {
  const entries = cache.get(doc) ?? new Map<string, Vector | null>();
  cache.set(doc, entries);
  if (entries.has(n.id)) return entries.get(n.id)!;
  const parts = childrenOf(doc, n.id)
    .map((c) => resolveNode(doc, c))
    .filter((c) => !c.hidden);
  const compound = n.booleanOperation === "compound";
  let shape: paper.PathItem | undefined;
  let contours: string[] = [];
  const rule = n.compoundWindingRule ?? "nonzero";
  for (const child of parts) {
    const item = operand(doc, child);
    const mode = compound ? child.operandOperation : n.booleanOperation;
    if (compound && !mode) {
      contours.push(item.pathData);
      continue;
    }
    if (contours.length) {
      if (shape) contours.unshift(shape.pathData);
      shape = new (kernel().CompoundPath)({
        pathData: contours.join(" "),
        fillRule: rule,
        insert: false,
      });
      contours = [];
    }
    if (!shape) shape = item;
    else
      switch (mode) {
        case "union":
          shape = shape.unite(item, { insert: false });
          break;
        case "subtract":
          shape = shape.subtract(item, { insert: false });
          break;
        case "intersect":
          shape = shape.intersect(item, { insert: false });
          break;
        case "exclude":
          shape = shape.exclude(item, { insert: false });
          break;
      }
  }
  const d = [shape?.pathData, ...contours].filter(Boolean).join(" ");
  const result: Vector | null = d
    ? {
        width: n.style.width,
        height: n.style.height,
        paths: [
          {
            d,
            fill: true,
            strokeWidth: 0,
            ...(compound
              ? { fillRule: rule }
              : shape?.fillRule === "evenodd"
                ? { fillRule: "evenodd" as const }
                : {}),
          },
        ],
      }
    : null;
  entries.set(n.id, result);
  return result;
}

export function canMask(doc: DesignDocument, ids: string[]) {
  const nodes = selectionRoots(doc, ids),
    bottom = nodes[0];
  return (
    nodes.length > 1 &&
    (bottom.type === "rectangle" ||
      bottom.type === "ellipse" ||
      !!bottom.booleanOperation ||
      (bottom.type === "vector" &&
        !!bottom.vector?.paths.some((p) => p.fill))) &&
    nodes.every(
      (n) =>
        n.parentId === bottom.parentId &&
        !isLocked(doc, n.id) &&
        !instanceOwner(doc, n.id),
    )
  );
}
export function maskSelection(doc: DesignDocument, ids: string[]) {
  if (!canMask(doc, ids))
    throw new Error("请选择同级图层，并将用作蒙版的填充形状放在底部");
  const bottom = selectionRoots(doc, ids)[0],
    result = wrapOperations(doc, ids, "group");
  result.operations.push({
    type: "update",
    id: result.id,
    patch: {
      name: "蒙版组",
      maskSourceId: bottom.id,
      maskType: bottom.image ? "alpha" : undefined,
    },
  });
  return result;
}
const clipCache = new WeakMap<DesignNode, string>();
export function maskClip(doc: DesignDocument, group: DesignNode) {
  const source = childrenOf(doc, group.id).find(
    (n) => n.id === group.maskSourceId,
  );
  if (!source || source.hidden) return "none";
  const resolved = resolveNode(doc, source);
  const cached = !resolved.booleanOperation && clipCache.get(resolved);
  if (cached) return cached;
  const contour = operand(doc, resolved);
  const css = contour.pathData
    ? "path(" +
      (contour.fillRule === "evenodd" ? "evenodd, " : "") +
      JSON.stringify(contour.pathData) +
      ")"
    : "inset(100%)";
  if (!resolved.booleanOperation) clipCache.set(resolved, css);
  return css;
}

export function bitmapMaskArtwork(
  n: DesignNode,
  doc: DesignDocument,
  prefix: string,
) {
  const image = n.image,
    asset = image && doc.images?.[image.assetId];
  if (!image || !asset) return "";
  const s = n.style,
    w = s.width,
    h = s.height;
  const transform = `translate(${s.x + w / 2} ${s.y + h / 2}) rotate(${s.rotation ?? 0}) scale(${s.flipX ? -1 : 1} ${s.flipY ? -1 : 1}) translate(${-w / 2} ${-h / 2})`;
  return `<defs><clipPath id="${prefix}crop"><path d="${primitivePath(n)}"/></clipPath></defs><g transform="${transform}" opacity="${s.opacity ?? 1}"><g clip-path="url(#${prefix}crop)">${svgImagePaint(image, asset, w, h, prefix + "tile")}</g></g>`;
}
const maskCache = new WeakMap<
  DesignNode,
  { source: DesignNode; data: string; css: Record<string, string> }
>();
/** Encode the image crop in local source coordinates so all three renderers can use the same mask. */
export function maskCss(
  doc: DesignDocument,
  group: DesignNode,
): Record<string, string> {
  const source = childrenOf(doc, group.id).find(
    (c) => c.id === group.maskSourceId,
  );
  if (!source || source.hidden) return {};
  if (!group.maskType || group.maskType === "vector")
    return { clipPath: maskClip(doc, group) };
  const n = resolveNode(doc, source),
    image = n.image,
    asset = image && doc.images?.[image.assetId];
  if (!asset || !image) return { clipPath: "inset(100%)" };
  const cached = maskCache.get(group);
  if (cached?.source === n && cached.data === asset.data) return cached.css;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${group.style.width} ${group.style.height}" preserveAspectRatio="none">${bitmapMaskArtwork(n, doc, "m")}</svg>`;
  const css = {
    maskImage: 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")',
    maskSize: "100% 100%",
    maskRepeat: "no-repeat",
    maskMode: group.maskType,
  };
  maskCache.set(group, { source: n, data: asset.data, css });
  return css;
}
