import type { NodeStyle } from "../domain/document";

// Sketch's tint replaces RGB after the entire group is painted. Its alpha
// multiplies the composited silhouette, including overlaps and child effects.
export function tintPrimitives(s: NodeStyle) {
  if (!s.tint) return "";
  const elements = [
    `<feFlood flood-color="${s.tint.color}" flood-opacity="${s.tint.opacity}"/><feComposite in2="SourceAlpha" operator="in" result="ink"/>`,
  ];
  const below: string[] = [],
    above: string[] = [];
  for (const [i, shadow] of (s.shadows ?? []).entries()) {
    if (shadow.visible === false) continue;
    const { spread, blur, x, y, inset, opacity, color } = shadow;
    // The same group's shadows keep their own color. Child shadows are already
    // part of SourceAlpha and therefore take the tint of their parent.
    if (spread)
      elements.push(
        `<feMorphology in="SourceAlpha" operator="${spread > 0 !== !!inset ? "dilate" : "erode"}" radius="${Math.abs(spread)}"/>`,
      );
    elements.push(
      `<feGaussianBlur ${spread ? "" : 'in="SourceAlpha" '}stdDeviation="${blur / 2}"/><feOffset dx="${x}" dy="${y}" result="off${i}"/>`,
    );
    if (inset)
      elements.push(
        `<feComposite in="SourceAlpha" in2="off${i}" operator="out" result="off${i}"/>`,
      );
    elements.push(
      `<feFlood flood-color="${color}" flood-opacity="${opacity}"/><feComposite in2="off${i}" operator="in" result="s${i}"/>`,
    );
    (inset ? above : below).unshift(`<feMergeNode in="s${i}"/>`);
  }
  if (below.length || above.length)
    elements.push(
      "<feMerge>" +
        below.join("") +
        '<feMergeNode in="ink"/>' +
        above.join("") +
        "</feMerge>",
    );
  return elements.join("");
}
export function tintCss(s: NodeStyle) {
  const body = tintPrimitives(s);
  if (!body) return;
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg"><filter id="t" color-interpolation-filters="sRGB" x="-100%" y="-100%" width="300%" height="300%">' +
    body +
    "</filter></svg>";
  return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '#t")';
}
