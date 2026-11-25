import type { DesignNode } from "../../domain/node";
import { maxLayerDimension } from "../../domain/document-limits";
import {
  bounded,
  number,
  object,
  type Layer,
  type Warn,
} from "./sketch-source";

export function pinSettings(layer: Layer) {
  let mask = number(layer.resizingConstraint, 63);
  if (
    layer.horizontalPins !== undefined ||
    layer.verticalPins !== undefined ||
    layer.horizontalSizing !== undefined ||
    layer.verticalSizing !== undefined
  ) {
    const hp = number(layer.horizontalPins),
      vp = number(layer.verticalPins);
    mask =
      63 &
      ~(hp & 1 ? 4 : 0) &
      ~(hp & 4 ? 1 : 0) &
      ~(vp & 1 ? 32 : 0) &
      ~(vp & 4 ? 8 : 0) &
      ~(number(layer.horizontalSizing) < 2 ? 2 : 0) &
      ~(number(layer.verticalSizing) < 2 ? 16 : 0);
  } else if (layer.resizingConstraint === undefined) return;
  const axis = (near: number, fixed: number, far: number) => {
    const a = !(mask & near),
      b = !(mask & far),
      f = !(mask & fixed);
    if (a && b) return f ? "scale" : "stretch";
    if (a) return "start";
    if (b) return "end";
    return f ? "center" : "scale";
  };
  return { constraintX: axis(4, 2, 1), constraintY: axis(32, 16, 8) } as const;
}
/** Sketch stores the painter’s order. Stack layout gives those same children the reverse flow order. */
export function applyModernLayout(node: DesignNode, layer: Layer, warn: Warn) {
  const s = node.style,
    layout = object(layer.groupLayout);
  const stack = layout._class === "MSImmutableFlexGroupLayout";
  // A freeform frame's painted stroke does not change its saved child
  // positions or the flex basis of the frame when it is a stack item.
  if (
    layout._class === "MSImmutableFreeformGroupLayout" &&
    (s.strokeWidth || s.strokeSides)
  )
    s.strokeInLayout = false;
  const insets = {
    top: number(layer.topPadding),
    right: number(layer.rightPadding),
    bottom: number(layer.bottomPadding),
    left: number(layer.leftPadding),
  };
  const negative =
    Object.values(insets).some((value) => value < 0) ||
    number(layout.allGuttersGap) < 0 ||
    number(layout.crossAxisGutterGap) < 0;
  if (stack && negative) warn(node.id, "负内边距或负间距栈保留源子层坐标");
  if (stack && !negative) {
    const row = layout.flexDirection === 0;
    const align = ["start", "center", "end"] as const;
    const main = align[number(layout.justifyContent)] ?? "start";
    const cross = align[number(layout.alignItems)] ?? "start";
    s.layout = row ? "row" : "column";
    s.layoutReverse = layout.stackingOrder !== 1;
    s.alignX = row ? main : cross;
    s.alignY = row ? cross : main;
    s.justifyContent = layout.justifyContent === 3 ? "space-between" : "pack";
    if (number(layout.justifyContent) > 3)
      warn(node.id, "环绕或均匀分布的栈间距需复核");
    const spacing = (value: number) =>
      bounded(value, 0, 1000, (msg) => warn(node.id, msg), "布局间距");
    for (const k of Object.keys(insets) as (keyof typeof insets)[])
      insets[k] = spacing(insets[k]);
    s.insets = insets;
    s.gap = spacing(number(layout.allGuttersGap));
    if (layout.wrappingEnabled) {
      s.wrap = true;
      s.rowGap = spacing(number(layout.crossAxisGutterGap));
    }
    if (layout.bordersAffectLayout === false) s.strokeInLayout = false;
  }
  const item = object(layer.flexItem);
  if (item.ignoreLayout) s.absolutePosition = true;
  if (item.preserveSpaceWhenHidden && layer.isVisible === false)
    warn(node.id, "隐藏栈项在原稿中占位，需复核邻近元素");
  if (item.alignSelf !== undefined && item.alignSelf !== 5)
    warn(node.id, "栈子项的独立交叉轴对齐需复核");
  for (const [field, key] of [
    ["horizontalSizing", "widthMode"],
    ["verticalSizing", "heightMode"],
  ] as const) {
    const sizing = layer[field];
    if (sizing === 1) s[key] = "hug";
    else if (sizing === 2 && !item.ignoreLayout) s[key] = "fill";
    else if (sizing === 0 || sizing === 3) s[key] = "fixed";
    if (sizing === 3 && layer.flexItem && !item.ignoreLayout)
      warn(node.id, "栈子项相对尺寸按源图层初始宽高保留");
  }
}
let ctx: OffscreenCanvasRenderingContext2D | null | undefined;
function sizeText(n: DesignNode) {
  if (ctx === undefined)
    ctx =
      typeof OffscreenCanvas === "undefined"
        ? null
        : new OffscreenCanvas(1, 1).getContext("2d");
  const s = n.style;
  if (ctx)
    ctx.font =
      (s.fontStyle ?? "normal") +
      " " +
      (s.fontWeight ?? 400) +
      " " +
      s.fontSize +
      "px " +
      (s.fontFamily ?? "sans-serif");
  const text =
    s.textTransform === "uppercase"
      ? n.text.toUpperCase()
      : s.textTransform === "lowercase"
        ? n.text.toLowerCase()
        : n.text;
  const width = (t: string) =>
    (ctx
      ? ctx.measureText(t).width
      : [...t].reduce(
          (sum, c) =>
            sum + (/[^\u0000-\u00ff]/.test(c) ? s.fontSize : s.fontSize * 0.55),
          0,
        )) +
    [...t].length * (s.letterSpacing ?? 0);
  let count = 0,
    max = 0;
  for (const line of text.split("\n")) {
    max = Math.max(max, width(line));
    if (s.widthMode === "hug") {
      count++;
      continue;
    }
    let current = "";
    for (const word of line.match(
      /\s+|[\u3040-\u30ff\u3400-\u9fff]|[^\s\u3040-\u30ff\u3400-\u9fff]+/gu,
    ) ?? []) {
      if (current.trim() && word.trim() && width(current + word) > s.width) {
        count++;
        current = word;
      } else current += word;
    }
    count++;
  }
  return {
    width: Math.max(1, max),
    height: Math.max(1, count * (s.lineHeight ?? s.fontSize * 1.2)),
  };
}
// Sketch Smart Layout stores the already laid-out frames. Reflow the changed children,
// retaining the original gaps and the group's near/centre/far anchor on its parent.
export function reflowOverrides(
  live: Map<string, DesignNode>,
  templates: DesignNode[],
  sources: Map<string, Layer>,
  paths: Map<string, string>,
  definition: (id: string) => Layer | undefined,
  warn: Warn,
) {
  const children = new Map<string, DesignNode[]>();
  const original = new Map<
    string,
    Pick<DesignNode["style"], "x" | "y" | "width" | "height">
  >();
  const getSource = (t: DesignNode) =>
    sources.get(paths.get(t.templateKey!)?.split("/").at(-1) ?? "");
  for (const t of templates) {
    const node = live.get(t.templateKey!)!;
    const { x, y, width, height } = node.style;
    original.set(t.templateKey!, { x, y, width, height });
    if (node.parentId) {
      const a = children.get(node.parentId) ?? [];
      a.push(node);
      children.set(node.parentId, a);
    }
  }
  for (const t of [...templates].reverse()) {
    const n = live.get(t.templateKey!)!,
      s = n.style,
      source = getSource(t);
    if (!source) continue;
    const dimension = (size: number) =>
      bounded(size, 1, maxLayerDimension, (msg) => warn(n.id, msg), "重排尺寸");
    if (n.type === "text" && n.text !== t.text) {
      const before = sizeText({
          ...t,
          style: { ...t.style, ...original.get(t.templateKey!)! },
        }),
        after = sizeText(n);
      if (s.widthMode === "hug") {
        const next = dimension(s.width + (after.width - before.width));
        const delta = next - s.width;
        s.width = next;
        if (s.textAlign === "right") s.x -= delta;
        else if (s.textAlign === "center") s.x -= delta / 2;
      }
      if (s.heightMode === "hug")
        s.height = dimension(s.height + (after.height - before.height));
    }
    const owner =
      source._class === "symbolInstance"
        ? definition(n.nestedSource?.componentId ?? String(source.symbolID))
        : source;
    const layout = object(owner?.groupLayout);
    if (layout._class !== "MSImmutableInferredGroupLayout") continue;
    const horiz = layout.axis === 0,
      pos = horiz ? "x" : "y",
      dim = horiz ? "width" : "height",
      anchor = number(layout.layoutAnchor);
    let delta = 0;
    const items = [...(children.get(n.id) ?? [])].sort(
      (a, b) =>
        original.get(a.templateKey!)![pos] - original.get(b.templateKey!)![pos],
    );
    for (const child of items) {
      const old = original.get(child.templateKey!)!;
      child.style[pos] = old[pos] + delta;
      delta += child.style[dim] - old[dim];
    }
    const next = dimension(s[dim] + delta);
    delta = next - s[dim];
    s[dim] = next;
    s[pos] -= delta * (anchor === 2 ? 1 : anchor === 1 ? 0.5 : 0);
  }
}
