import assert from "node:assert/strict";

// Two PNGs, identical sRGB white backdrop and unrounded per-sample counts.
export async function compareApplePixels(
  page,
  reference,
  native,
  includeDiff = false,
) {
  return page.evaluate(
    async ([source, image, drawDiff]) => {
      async function decode(bytes) {
        const i = new Image();
        i.src = "data:image/png;base64," + bytes;
        await i.decode();
        const canvas = document.createElement("canvas");
        canvas.width = i.width;
        canvas.height = i.height;
        const ctx = canvas.getContext("2d", { colorSpace: "srgb" });
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, i.width, i.height);
        ctx.drawImage(i, 0, 0);
        return {
          w: i.width,
          h: i.height,
          pixels: ctx.getImageData(0, 0, i.width, i.height).data,
        };
      }
      const a = await decode(source),
        b = await decode(image);
      if (a.w !== b.w || a.h !== b.h)
        return {
          source: [a.w, a.h],
          actual: [b.w, b.h],
          dimensionMismatch: true,
        };
      const diffPixels = drawDiff ? new ImageData(a.w, a.h) : undefined;
      let diff = 0,
        max = 0;
      for (let i = 0; i < a.pixels.length; i += 4) {
        const d = Math.max(
          ...[0, 1, 2].map((c) => Math.abs(a.pixels[i + c] - b.pixels[i + c])),
        );
        if (d > 16) diff++;
        if (diffPixels) {
          const grey = Math.round(225 + (30 * a.pixels[i]) / 255);
          diffPixels.data.set(
            d > 16 ? [182, 19, 72, 255] : [grey, grey, grey, 255],
            i,
          );
        }
        max = Math.max(max, d);
      }
      let diffPng;
      if (diffPixels) {
        const canvas = document.createElement("canvas");
        canvas.width = a.w;
        canvas.height = a.h;
        canvas.getContext("2d").putImageData(diffPixels, 0, 0);
        diffPng = canvas.toDataURL("image/png").split(",")[1];
      }
      return {
        ...(diffPng ? { diffPng } : {}),
        width: a.w,
        height: a.h,
        over16: diff,
        total: a.w * a.h,
        pct: (100 * diff) / (a.w * a.h),
        max,
      };
    },
    [reference.toString("base64"), native.toString("base64"), includeDiff],
  );
}
export function assertAppleVisuals(samples) {
  assertPixelLimit(samples, [
    "alert",
    "button",
    "cover",
    "keyboard",
    "picker",
    "toggle",
  ]);
}
export function assertPixelLimit(samples, tags) {
  assert.deepEqual(
    samples.map((s) => s.tag).sort(),
    [...tags].sort(),
    "Every selected original must be compared exactly once",
  );
  const failures = samples.filter(
    ({ pixels: p, sourceSize }) =>
      p.dimensionMismatch ||
      p.width !== sourceSize[0] ||
      p.height !== sourceSize[1] ||
      p.total !== p.width * p.height ||
      !Number.isSafeInteger(p.over16) ||
      p.over16 < 0 ||
      p.over16 * 200 > p.total,
  );
  assert.deepEqual(
    failures.map(({ tag, pixels }) => ({ tag, pixels })),
    [],
    "Each original must have identical dimensions and no more than 0.5% of pixels over 16",
  );
}
