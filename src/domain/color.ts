export type HSV = { h: number; s: number; v: number };
const clamp = (n: number, min = 0, max = 1) => Math.max(min, Math.min(max, n));
export function hexToRgb(hex: string) {
  const raw = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(raw.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}
export function rgbToHex(r: number, g: number, b: number) {
  return (
    "#" +
    [r, g, b]
      .map((n) =>
        Math.round(clamp(n, 0, 255))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}
export function hexToHsv(hex: string): HSV {
  const [r, g, b] = hexToRgb(hex).map((n) => n / 255),
    max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    d = max - min;
  let h =
    d === 0
      ? 0
      : max === r
        ? ((g - b) / d) % 6
        : max === g
          ? (b - r) / d + 2
          : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s: max === 0 ? 0 : d / max, v: max };
}
export function hsvToHex({ h, s, v }: HSV) {
  const c = v * s,
    x = c * (1 - Math.abs(((h / 60) % 2) - 1)),
    m = v - c;
  const rgb =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return rgbToHex(
    ...(rgb.map((n) => (n + m) * 255) as [number, number, number]),
  );
}
export function hexToHsl(hex: string) {
  const { h, s, v } = hexToHsv(hex),
    l = v * (1 - s / 2);
  return [
    Math.round(h),
    Math.round((l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l)) * 100),
    Math.round(l * 100),
  ];
}
export function parseColorInput(
  value: string,
  model: "HEX" | "RGB" | "HSL",
): string | null {
  if (model === "HEX") {
    const v = value.trim().replace(/^#/, "");
    if (/^[a-f\d]{3}$/i.test(v))
      return (
        "#" +
        [...v]
          .map((c) => c + c)
          .join("")
          .toLowerCase()
      );
    return /^[a-f\d]{6}$/i.test(v) ? "#" + v.toLowerCase() : null;
  }
  const values = value
    .replace(/[a-z()%]/gi, "")
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(Number);
  if (values.length !== 3 || values.some((n) => !Number.isFinite(n)))
    return null;
  if (model === "RGB")
    return values.every((n) => n >= 0 && n <= 255)
      ? rgbToHex(...(values as [number, number, number]))
      : null;
  const [h, s, l] = values;
  if (h < 0 || h > 360 || s < 0 || s > 100 || l < 0 || l > 100) return null;
  const v = l / 100 + (s / 100) * Math.min(l / 100, 1 - l / 100);
  return hsvToHex({ h: h % 360, s: v === 0 ? 0 : 2 * (1 - l / 100 / v), v });
}
