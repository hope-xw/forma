// The linear channel of Figma's UV-to-paint matrix. The gradient parameter
// at (u, v) is x*u + y*v + offset in the box's normalized coordinates.
export type LinearProjection = { x: number; y: number; offset: number };
export function linearGradientEndpoints({ x, y, offset }: LinearProjection) {
  const den = x * x + y * y;
  if (!den) return undefined;
  return {
    x1: (-offset * x) / den,
    y1: (-offset * y) / den,
    x2: ((1 - offset) * x) / den,
    y2: ((1 - offset) * y) / den,
  };
}
export function linearGradientBackground({ x, y, offset }: LinearProjection) {
  const ax = Math.abs(x),
    ay = Math.abs(y),
    m = Math.max(ax, ay);
  if (!m) return undefined;
  const horizontal = x < 0 ? "left" : "right",
    vertical = y < 0 ? "top" : "bottom";
  // A CSS corner-to-corner gradient increases by half along each normalized
  // axis, independently of the box's aspect ratio. Extend the weaker axis
  // so the two projected coefficients retain the ratio of the source matrix.
  const alongX = ay <= m * 1e-7,
    alongY = ax <= m * 1e-7;
  const direction = alongX
    ? horizontal
    : alongY
      ? vertical
      : horizontal + " " + vertical;
  const range = alongX || alongY ? m : 2 * m;
  const min = offset - (!alongY && x < 0 ? m : 0) - (!alongX && y < 0 ? m : 0);
  return {
    direction,
    range,
    min,
    size:
      alongX || alongY
        ? ""
        : ` left top / ${(100 * m) / ax}% ${(100 * m) / ay}% no-repeat`,
  };
}
