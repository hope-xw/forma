import type { DesignNode, NodeStyle } from "./node";

// Only metrics and layout affect cached glyph geometry. Moving or recoloring the layer is safe.
export function textShapeStyleKey(style: NodeStyle): string {
  return JSON.stringify([
    style.width,
    style.height,
    style.widthMode,
    style.heightMode,
    style.fontFamily,
    style.fontSize,
    style.fontWeight,
    style.fontStyle,
    style.lineHeight,
    style.letterSpacing,
    style.fontFeatureSettings,
    style.fontVariationSettings,
    style.textAlign,
    style.verticalAlign,
    style.textDecoration,
    style.textTransform,
    style.leadingTrim,
    style.maxLines,
  ]);
}

export function currentTextShape(node: DesignNode) {
  const shape = node.sourceTextShape;
  if (
    !shape ||
    node.textRuns?.length ||
    shape.text !== node.text ||
    shape.styleKey !== textShapeStyleKey(node.style)
  )
    return undefined;
  return shape;
}

// Sketch constructs a vector ink mask for multiple paints, preserving fractional glyph origins.
export function textLayoutStyleKey(style: NodeStyle) {
  return (
    textShapeStyleKey(style) +
    (style.paints?.some((p) => p.visible) ? "/paint-mask" : "")
  );
}
export function currentTextLayout(node: DesignNode) {
  const layout = node.sourceTextLayout;
  return layout &&
    !node.textRuns?.length &&
    layout.text === node.text &&
    layout.styleKey === textLayoutStyleKey(node.style)
    ? layout
    : undefined;
}
