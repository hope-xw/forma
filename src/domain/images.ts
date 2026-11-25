import { z } from "zod";
import { maxEncodedAssetLength } from "./asset-bytes";
import type { NodeStyle } from "./document";
import { strokeInset } from "./stroke";
export const imageId = z.string().regex(/^img-[a-f\d]{64}$/);
export const imageSchema = z.object({
  name: z.string().min(1).max(255),
  width: z.number().int().positive().max(32768),
  height: z.number().int().positive().max(32768),
  data: z
    .string()
    .max(maxEncodedAssetLength)
    .regex(/^data:image\/(png|jpeg|webp|gif);base64,[a-zA-Z0-9+/]+=*$/),
});
export const imageAssets = z.record(imageId, imageSchema);
export const imageFillSchema = z.object({
  assetId: imageId,
  opacity: z.number().min(0).max(1).optional(),
  fit: z.enum(["cover", "contain", "fill", "tile"]),
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
  zoom: z.number().min(1).max(8),
  tileScale: z.number().min(0.1).max(8).optional(),
  rotation: z.number().finite().min(-360).max(360).optional(),
  brightness: z.number().min(0).max(2).optional(),
  contrast: z.number().min(0).max(2).optional(),
  saturation: z.number().min(0).max(2).optional(),
  exposure: z.number().min(-1).max(1).optional(),
  temperature: z.number().min(-1).max(1).optional(),
  tint: z.number().min(-1).max(1).optional(),
  highlights: z.number().min(-1).max(1).optional(),
  shadows: z.number().min(-1).max(1).optional(),
});
export type ImageAsset = z.infer<typeof imageSchema>;
export type ImageFill = z.infer<typeof imageFillSchema>;

// The absolutely positioned image in the editor and React fills the padding box.
export function imageViewport(style: NodeStyle, width: number, height: number) {
  const x = strokeInset(style, "left");
  const y = strokeInset(style, "top");
  return {
    x,
    y,
    width: Math.max(0, width - x - strokeInset(style, "right")),
    height: Math.max(0, height - y - strokeInset(style, "bottom")),
  };
}

function roundFilter(value: number, digits = 4) {
  return Number(value.toFixed(digits));
}

export function imagePaint(fill: ImageFill, asset?: ImageAsset) {
  const {
    brightness = 1,
    contrast = 1,
    saturation = 1,
    exposure = 0,
    temperature = 0,
    tint = 0,
    highlights = 0,
    shadows = 0,
    rotation = 0,
    tileScale = 1,
    ...paint
  } = fill;
  const effectiveBrightness =
    exposure === 0 && highlights === 0 && shadows === 0
      ? brightness
      : roundFilter(
          Math.max(
            0,
            brightness *
              Math.pow(2, exposure) *
              (1 + highlights * 0.15 + shadows * 0.2),
          ),
        );
  const effectiveContrast =
    highlights === 0 && shadows === 0
      ? contrast
      : roundFilter(
          Math.max(0, contrast * (1 + highlights * 0.12 - shadows * 0.15)),
        );
  const sepiaAmount =
    temperature > 0 ? roundFilter(Math.min(1, temperature * 0.4)) : 0;
  const hueShift = roundFilter(
    (temperature < 0 ? temperature * 30 : -temperature * 10) + tint * 45,
    2,
  );
  const filter = [
    effectiveBrightness !== 1 && `brightness(${effectiveBrightness})`,
    effectiveContrast !== 1 && `contrast(${effectiveContrast})`,
    saturation !== 1 && `saturate(${saturation})`,
    sepiaAmount > 0 && `sepia(${sepiaAmount})`,
    hueShift !== 0 && `hue-rotate(${hueShift}deg)`,
  ]
    .filter(Boolean)
    .join(" ");
  const transform = rotation ? `rotate(${rotation}deg)` : undefined;
  return {
    ...paint,
    ...(rotation ? { rotation } : {}),
    ...(transform ? { transform } : {}),
    ...(filter ? { filter } : {}),
    ...(fill.fit === "tile" && asset
      ? {
          tileSize: [
            asset.width * tileScale,
            asset.height * tileScale,
          ] as const,
        }
      : {}),
  };
}

export function imageExtent(
  fill: ImageFill,
  asset: ImageAsset,
  w: number,
  h: number,
) {
  if (fill.fit === "tile") {
    const scale = fill.tileScale ?? 1;
    return { width: asset.width * scale, height: asset.height * scale };
  }
  if (fill.fit === "fill")
    return { width: w * fill.zoom, height: h * fill.zoom };
  const ratio =
    (fill.fit === "contain" ? Math.min : Math.max)(
      w / asset.width,
      h / asset.height,
    ) * fill.zoom;
  return { width: asset.width * ratio, height: asset.height * ratio };
}

// Both static artwork and bitmap masks use the original, validated data URI.
export function svgImagePaint(
  fill: ImageFill,
  asset: ImageAsset,
  w: number,
  h: number,
  patternId: string,
) {
  const size = imageExtent(fill, asset, w, h);
  const x = ((w - size.width) * fill.x) / 100,
    y = ((h - size.height) * fill.y) / 100;
  const bitmap = `${fill.opacity !== undefined ? `opacity="${fill.opacity}" ` : ""}width="${size.width}" height="${size.height}" preserveAspectRatio="none" href="${asset.data}"`;
  const rawArtwork =
    fill.fit !== "tile"
      ? `<image x="${x}" y="${y}" ${bitmap}/>`
      : `<defs><pattern id="${patternId}" patternUnits="userSpaceOnUse" x="${x}" y="${y}" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}"><image ${bitmap}/></pattern></defs><rect width="${w}" height="${h}" fill="url(#${patternId})"/>`;
  const artwork = fill.rotation
    ? `<g transform="rotate(${fill.rotation} ${w / 2} ${h / 2})">${rawArtwork}</g>`
    : rawArtwork;
  const transfer = (slope: number, intercept: number) =>
    slope === 1
      ? ""
      : "<feComponentTransfer>" +
        ["R", "G", "B"]
          .map(
            (channel) =>
              `<feFunc${channel} type="linear" slope="${slope}" intercept="${intercept}"/>`,
          )
          .join("") +
        "</feComponentTransfer>";
  const exposure = fill.exposure ?? 0;
  const highlights = fill.highlights ?? 0;
  const shadows = fill.shadows ?? 0;
  const temperature = fill.temperature ?? 0;
  const tint = fill.tint ?? 0;
  const brightness =
    exposure === 0 && highlights === 0 && shadows === 0
      ? (fill.brightness ?? 1)
      : roundFilter(
          Math.max(
            0,
            (fill.brightness ?? 1) *
              Math.pow(2, exposure) *
              (1 + highlights * 0.15 + shadows * 0.2),
          ),
        );
  const contrast =
    highlights === 0 && shadows === 0
      ? (fill.contrast ?? 1)
      : roundFilter(
          Math.max(
            0,
            (fill.contrast ?? 1) * (1 + highlights * 0.12 - shadows * 0.15),
          ),
        );
  const wbMatrix =
    temperature !== 0 || tint !== 0
      ? (() => {
          const r = roundFilter(1 + temperature * 0.18 + tint * 0.08);
          const g = roundFilter(1 - tint * 0.14);
          const b = roundFilter(1 - temperature * 0.18 + tint * 0.08);
          return `<feColorMatrix type="matrix" values="${r} 0 0 0 0 0 ${g} 0 0 0 0 0 ${b} 0 0 0 0 0 1 0"/>`;
        })()
      : "";
  const stages =
    transfer(brightness, 0) +
    transfer(contrast, (1 - contrast) / 2) +
    ((fill.saturation ?? 1) === 1
      ? ""
      : `<feColorMatrix type="saturate" values="${fill.saturation}"/>`) +
    wbMatrix;
  return stages
    ? `<defs><filter id="${patternId}fx" color-interpolation-filters="sRGB">${stages}</filter></defs><g filter="url(#${patternId}fx)">${artwork}</g>`
    : artwork;
}
