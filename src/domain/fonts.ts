import { z } from "zod";
import { maxEncodedAssetLength } from "./asset-bytes";
export const fontId = z.string().regex(/^font-[a-f0-9]{64}$/);
export const fontAsset = z.object({
  name: z.string().min(1).max(255),
  weight: z.number().int().min(1).max(1000).optional(),
  italic: z.boolean().optional(),
  features: z
    .array(z.string().regex(/^[a-zA-Z0-9 ]{4}$/))
    .max(512)
    .optional(),
  axes: z
    .array(
      z
        .object({
          tag: z.string().regex(/^[a-zA-Z0-9 ]{4}$/),
          min: z.number().finite(),
          max: z.number().finite(),
          default: z.number().finite(),
        })
        .refine((a) => a.min <= a.default && a.default <= a.max),
    )
    .max(64),
  data: z
    .string()
    .max(maxEncodedAssetLength)
    .regex(/^data:font\/(ttf|otf);base64,[a-zA-Z0-9+/]+=*$/),
});
export const fontAssets = z.record(fontId, fontAsset);
export type FontAsset = z.infer<typeof fontAsset>;
export function mergeFonts(
  target: Record<string, FontAsset> | undefined,
  source: Record<string, FontAsset>,
) {
  const out = { ...target };
  for (const [id, asset] of Object.entries(source)) {
    if (out[id] && out[id].data !== asset.data) throw Error("字体资源标识冲突");
    out[id] = asset;
  }
  return out;
}

export function fontFaceWeight(font: FontAsset) {
  const axis = font.axes.find((a) => a.tag === "wght");
  return axis ? axis.min + " " + axis.max : font.weight?.toString();
}
