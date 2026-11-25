import type { DesignDocument, DesignNode } from "../domain/document";
import { childrenOf } from "../domain/scene-index";
import { resolveNode } from "../domain/design-system";

// CSS gaps cannot be negative. Put the overlap on the measured flow siblings
// and leave layer-tree order independent of front-to-back painting.
export function flowItemCss(
  doc: DesignDocument,
  node: DesignNode,
  parent: DesignNode,
  gap?: string,
) {
  const s = parent.style;
  const css: Record<string, string | number> = {};
  if (
    (s.layout !== "row" && s.layout !== "column") ||
    (!s.firstChildOnTop && !gap && s.gap >= 0)
  )
    return css;
  const siblings = childrenOf(doc, parent.id);
  if (s.firstChildOnTop)
    css.zIndex = siblings.length - siblings.findIndex((c) => c.id === node.id);
  if (s.wrap || node.style.absolutePosition || (!gap && s.gap >= 0)) return css;
  const first = siblings.find((c) => {
    const visible = c.variableBindings?.visible ? resolveNode(doc, c) : c;
    return !visible.hidden && !visible.style.absolutePosition;
  });
  if (first && first.id !== node.id) {
    const side =
      s.layout === "row"
        ? s.layoutReverse
          ? "marginRight"
          : "marginLeft"
        : s.layoutReverse
          ? "marginBottom"
          : "marginTop";
    css[side] = gap ?? s.gap;
  }
  return css;
}
