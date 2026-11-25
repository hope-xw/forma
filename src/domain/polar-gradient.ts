import { inverse, transform, type Matrix } from "./transforms";

// Transform unit paint coordinates back into the normalized layer box.
export function polarPaint(source: Matrix) {
  const basis = inverse(source);
  const center = transform(basis, { x: 0.5, y: 0.5 });
  const x = Math.hypot(source.a, source.b),
    y = Math.hypot(source.c, source.d);
  return {
    basis,
    center,
    rx: 0.5 / x,
    ry: 0.5 / y,
    axisAligned:
      Math.abs(source.a * source.c + source.b * source.d) <= 1e-7 * x * y,
  };
}
