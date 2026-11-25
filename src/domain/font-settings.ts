import { z } from "zod";

export const typeSettings = [
  {
    key: "fontVariationSettings",
    label: "可变字体轴",
    example: '"wght" 650, "wdth" 90',
  },
  {
    key: "fontFeatureSettings",
    label: "OpenType 特性",
    example: '"liga" 1, "tnum" 1',
  },
] as const;
export function validFontSettings(value: string, axis: boolean) {
  if (value === "normal") return true;
  const tags = new Set<string>();
  return value.split(",").every((item) => {
    const match = /^"([ -~]{4})"\s+(-?\d+(?:\.\d+)?)$/.exec(item.trim());
    if (!match || !/^[a-zA-Z0-9 ]{4}$/.test(match[1]) || tags.has(match[1]))
      return false;
    tags.add(match[1]);
    const n = Number(match[2]);
    return axis ? Number.isFinite(n) : Number.isSafeInteger(n) && n >= 0;
  });
}
export const fontSettingsSchema = {
  fontVariationSettings: z
    .string()
    .max(512)
    .refine((v) => validFontSettings(v, true), '示例："wght" 650')
    .optional(),
  fontFeatureSettings: z
    .string()
    .max(512)
    .refine((v) => validFontSettings(v, false), '示例："liga" 1')
    .optional(),
};

export function settingsMap(value?: string) {
  return new Map(
    Array.from(
      (value ?? "").matchAll(/"([a-zA-Z0-9 ]{4})"\s+(-?[\d.]+)/g),
      (m) => [m[1], Number(m[2])],
    ),
  );
}
export function setFontOption(
  value: string | undefined,
  tag: string,
  n?: number,
) {
  const map = settingsMap(value);
  if (n === undefined) map.delete(tag);
  else map.set(tag, n);
  return (
    Array.from(map, ([key, v]) => '"' + key + '" ' + v).join(", ") || undefined
  );
}
export const fontTagNames: Record<string, string> = {
  wght: "字重",
  wdth: "字宽",
  slnt: "倾斜",
  ital: "斜体",
  opsz: "光学字号",
  GRAD: "笔画粗细",
  liga: "标准连字",
  dlig: "装饰连字",
  calt: "上下文替换",
  kern: "字偶距",
  tnum: "等宽数字",
  pnum: "比例数字",
  frac: "分数",
  zero: "带斜线的零",
  smcp: "小型大写",
  onum: "旧式数字",
  lnum: "等高数字",
  sups: "上标",
  subs: "下标",
  locl: "本地化字形",
};
