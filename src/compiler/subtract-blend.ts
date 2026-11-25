// Core Graphics Plus Darker contributes its source color in uncovered pixels.
// Keeping that term matters for semitransparent materials rendered over a page.
export function subtractBlend(color: string) {
  const hex = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color);
  const neutralP3 = /^color\(display-p3 ([.\d]+) \1 \1\)$/.exec(color);
  const channels = hex
    ? hex.slice(1).map((x) => parseInt(x, 16) / 255)
    : neutralP3
      ? Array<number>(3).fill(Number(neutralP3[1]))
      : undefined;
  if (!channels?.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) return;
  const transfer = ["R", "G", "B"]
    .map(
      (c, i) =>
        `<feFunc${c} type="linear" slope="1" intercept="${channels[i] - 1}"/>`,
    )
    .join("");
  const primitives = `<feFlood flood-color="${color}" result="ink"/><feComposite in="ink" in2="SourceAlpha" operator="out" result="uncovered"/><feComponentTransfer in="SourceGraphic" result="mixed">${transfer}</feComponentTransfer><feComposite in="uncovered" in2="mixed" operator="arithmetic" k2="1" k3="1"/>`;
  const filter =
    '<svg xmlns="http://www.w3.org/2000/svg"><filter id="s" color-interpolation-filters="sRGB" x="0" y="0" width="100%" height="100%">' +
    primitives +
    "</filter></svg>";
  return {
    primitives,
    css: 'url("data:image/svg+xml,' + encodeURIComponent(filter) + '#s")',
  };
}
