export function compositeSurface(
  color: string,
  alpha: number,
  backdrop = "#ffffff",
) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return backdrop;
  const channel = (n: number) =>
    Math.round(
      parseInt(color.slice(n, n + 2), 16) * alpha +
        parseInt(backdrop.slice(n, n + 2), 16) * (1 - alpha),
    )
      .toString(16)
      .padStart(2, "0");
  return "#" + channel(1) + channel(3) + channel(5);
}

export function glassEnvironmentFields(
  surfaces: { color: string; alpha: number }[],
) {
  const glassEnvironment = surfaces.reduce(
    (backdrop, p) => compositeSurface(p.color, p.alpha, backdrop),
    "#ffffff",
  );
  // A transmitting background participates in both the source scene and the
  // refracted sample. An opaque surface starts a new scene and contributes once.
  let first = surfaces.length;
  while (first > 0 && surfaces[first - 1].alpha < 1) first--;
  const sampled = surfaces
    .slice(first)
    .reduce(
      (backdrop, p) => compositeSurface(p.color, p.alpha, backdrop),
      glassEnvironment,
    );
  return {
    glassEnvironment,
    ...(sampled !== glassEnvironment
      ? { glassSampleEnvironment: sampled }
      : {}),
  };
}
