import type { NodeStyle } from "./document";
type Stack = NodeStyle["strokePaints"];
const fields = [
  "color",
  "opacity",
  "visible",
  "blendMode",
  "colorVariableId",
  "opacityVariableId",
  "gradient",
] as const;
const prefix = (id: string) => "strokePaints." + id + ".";

// Figma keeps a paint style reference even when one paint has a local override.
// Preserve other paints and properties when the shared style is subsequently edited.
export function strokePaintOverrideKeys(base: Stack, own: Stack): string[] {
  if (!base?.length && !own?.length) return [];
  if (
    base?.length !== own?.length ||
    !base ||
    !own ||
    base.some((p, i) => p.id !== own[i].id)
  )
    return ["strokePaints"];
  return base.flatMap((p, i) =>
    fields
      .filter((k) => JSON.stringify(p[k]) !== JSON.stringify(own[i][k]))
      .map((k) => prefix(p.id) + k),
  );
}
export function mergeStrokePaintOverrides(
  base: NonNullable<Stack>,
  own: Stack,
  keys: string[],
) {
  if (!own || !keys.some((k) => k.startsWith("strokePaints."))) return base;
  const local = new Map(own.map((p) => [p.id, p]));
  return base.map((p) => {
    const q = local.get(p.id);
    if (!q) return p;
    const paint = { ...p };
    for (const key of fields)
      if (keys.includes(prefix(p.id) + key))
        Object.assign(paint, { [key]: q[key] });
    return paint;
  });
}
