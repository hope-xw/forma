import { z } from "zod";

export function parseTracks(value: string) {
  return value
    .trim()
    .split(/\s+/)
    .map((token) => {
      if (token === "auto") return { value: 1, unit: "auto" };
      const match = /^(\d+(?:\.\d+)?)(px|fr)$/.exec(token);
      if (!match || Number(match[1]) <= 0 || Number(match[1]) > 10000)
        throw new Error("轨道可设为 auto，或大于 0 且不超过 10000 的 px 或 fr");
      return { value: Number(match[1]), unit: match[2] };
    });
}
export const trackList = z
  .string()
  .min(1)
  .max(1024)
  .refine((s) => {
    try {
      return parseTracks(s).length <= 64;
    } catch {
      return false;
    }
  }, "请填写 1 至 64 个轨道尺寸");
export const trackCssValue = (t: { unit: string; value: number }) =>
  t.unit === "auto"
    ? "max-content"
    : t.unit === "fr"
      ? "minmax(0," + t.value + "fr)"
      : t.value + "px";
