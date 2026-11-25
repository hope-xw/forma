import type { MeasureText } from "../domain/sizing";
import { textParts } from "../domain/rich-text";

/** Ask the browser's text shaper to resolve wraps, fallback fonts, bidi and ligatures. */
export function browserTextMetrics(): MeasureText {
  const probe = document.createElement("div");
  probe.style.cssText =
    "all:initial;-webkit-locale:inherit;display:block;position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;box-sizing:border-box;white-space:pre-wrap;overflow-wrap:break-word;min-width:1px;min-height:1px";
  probe.setAttribute("aria-hidden", "true");
  const cache = new Map<string, { width: number; height: number }>();
  document.fonts?.addEventListener("loadingdone", () => cache.clear());
  return (node, width) => {
    const s = node.style;
    const key = JSON.stringify([
      node.text,
      node.textRuns,
      width,
      s.fontFamily,
      s.fontVariationSettings,
      s.fontFeatureSettings,
      s.fontStyle,
      s.textTransform,
      s.leadingTrim,
      s.fontSize,
      s.fontWeight,
      s.lineHeight,
      s.letterSpacing,
      s.strokeWidth,
    ]);
    const existing = cache.get(key);
    if (existing) return existing;
    if (!probe.isConnected) document.body.appendChild(probe);
    Object.assign(probe.style, {
      fontVariationSettings: s.fontVariationSettings ?? "normal",
      fontFeatureSettings: s.fontFeatureSettings ?? "normal",
      fontFamily: s.fontFamily ?? "system-ui, sans-serif",
      fontSize: s.fontSize + "px",
      fontStyle: s.fontStyle ?? "normal",
      textTransform: s.textTransform ?? "none",
      textBoxTrim: s.leadingTrim === "cap" ? "trim-both" : "none",
      textBoxEdge: s.leadingTrim === "cap" ? "cap alphabetic" : "auto",
      fontWeight: String(s.fontWeight ?? 400),
      letterSpacing: (s.letterSpacing ?? 0) + "px",
      lineHeight: s.lineHeight ? s.lineHeight + "px" : "1.4",
      border: (s.strokeWidth ?? 0) + "px solid transparent",
      width: width === undefined ? "max-content" : width + "px",
    });
    if (node.textRuns?.length)
      probe.replaceChildren(
        ...textParts(node).map((part) => {
          const span = document.createElement("span");
          span.textContent = part.text;
          Object.assign(span.style, part.style, {
            letterSpacing:
              part.style.letterSpacing !== undefined
                ? part.style.letterSpacing + "px"
                : "",
            fontSize: part.style.fontSize ? part.style.fontSize + "px" : "",
          });
          return span;
        }),
      );
    else probe.textContent = node.text;
    if (!node.text || node.text.endsWith("\n"))
      probe.append(document.createElement("br"));
    const rect = probe.getBoundingClientRect();
    const result = { width: rect.width, height: rect.height };
    if (cache.size >= 2048) cache.delete(cache.keys().next().value!);
    cache.set(key, result);
    return result;
  };
}
