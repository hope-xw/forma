import { z } from "zod";
import { stableHash } from "../../domain/stable-hash";

export type Fields = Record<string, unknown>;
export const object = (v: unknown): Fields =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Fields) : {};
export const array = (v: unknown): Fields[] =>
  Array.isArray(v) ? v.map(object) : [];
export const string = (v: unknown, fallback = "") =>
  typeof v === "string" ? v : fallback;
export const number = (v: unknown, fallback = 0) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
export const idFor = (scope: string, value: string) =>
  scope + "-" + stableHash(value);
export type Warn = (node: string, detail: string) => void;
const layerSchema = z.looseObject({
  _class: z.string().min(1),
  do_objectID: z.string().min(1).max(128),
  name: z.string(),
  frame: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
  }),
  layers: z.array(z.unknown()).optional(),
});
export type Layer = Omit<z.infer<typeof layerSchema>, "layers"> & {
  _class: string;
  do_objectID: string;
  name: string;
  frame: { x: number; y: number; width: number; height: number };
  layers: Layer[];
};
export function readLayer(
  raw: unknown,
  depth = 0,
  budget = { count: 0 },
): Layer {
  if (++budget.count > 100_000 || depth > 180)
    throw Error("Sketch 图层规模或嵌套深度超限");
  const source = parseSketch(
    layerSchema,
    raw,
    "图层 " + string(object(raw).do_objectID),
  );
  return {
    ...source,
    layers: (source.layers ?? []).map((l) => readLayer(l, depth + 1, budget)),
  };
}
export function point(value: unknown) {
  const m = /^\{\s*([-+.\deE]+)\s*,\s*([-+.\deE]+)\s*\}$/.exec(string(value));
  if (!m || !Number.isFinite(Number(m[1])) || !Number.isFinite(Number(m[2])))
    throw Error("Sketch 点坐标格式无效");
  return { x: Number(m[1]), y: Number(m[2]) };
}
export function color(value: unknown) {
  const c = object(value);
  return (
    "#" +
    [c.red, c.green, c.blue]
      .map((v) =>
        Math.round(Math.max(0, Math.min(1, number(v))) * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}
export function parseSketch<T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw Error(
      "Sketch " + label + " 格式无效：" + parsed.error.issues[0].path.join("."),
    );
  return parsed.data;
}
export function bounded(
  value: number,
  min: number,
  max: number,
  warn?: (msg: string) => void,
  label = "数值",
) {
  if (value >= min && value <= max) return value;
  warn?.(label + "超出范围，已限制在 " + min + " 至 " + max);
  return Math.max(min, Math.min(max, value));
}
export const alpha = (v: unknown, warn?: (msg: string) => void) =>
  bounded(number(object(v).alpha, 1), 0, 1, warn, "颜色透明度");
export function rotation(layer: Layer, warn: Warn) {
  const value = -number(layer.rotation);
  if (Math.abs(value) <= 360) return value;
  warn(layer.do_objectID, "旋转角度已折算为一周内的等效值");
  return value % 360;
}
