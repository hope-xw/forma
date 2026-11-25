import type { DesignNode } from "./node";

/** Apply source-view paint visibility after styles and variables resolve. Keep all paints editable in the master. */
export function symbolPaintForView(
  node: DesignNode,
  view: "canvas" | "export",
): DesignNode {
  const flags = node.style.sketchSymbolBackground,
    editPaints = node.style.sketchCanvasPaints;
  if (!flags && !editPaints?.length) return node;
  const instance = Boolean(node.instance || node.nestedSlot);
  if (view === "canvas" && !instance) return node;
  // Sketch exports a master as a Symbol occurrence: both switches gate its background.
  const hideBackground =
    flags && (!flags.inInstance || (view === "export" && !flags.inExport));
  const hideBase = hideBackground || editPaints?.includes("base");
  const style = { ...node.style };
  const result = { ...node, style };
  if (hideBackground || editPaints?.includes("image")) delete result.image;
  if (hideBackground) delete style.paints;
  else if (editPaints?.length && style.paints)
    style.paints = style.paints.filter((p) => !editPaints.includes(p.id));
  if (hideBase) {
    style.fillOpacity = 0;
    delete style.gradient;
    delete style.fillBlendMode;
    delete result.fillToken;
    result.variableBindings = { ...result.variableBindings };
    delete result.variableBindings.fill;
    delete result.variableBindings.fillOpacity;
    result.styleBindings = { ...result.styleBindings };
    delete result.styleBindings.paint;
  }
  return result;
}
