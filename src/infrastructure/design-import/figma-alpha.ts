import type { DesignSystem } from "../../domain/design-system-schema";
import {
  clamp,
  guid,
  num,
  obj,
  rows,
  type Fields,
  type LayerContext,
} from "./figma-layer";

export type AlphaValues = Record<string, number | { alias: string }>;

// Figma caches the effective alpha in paint.opacity or in color.a. Comparing
// with the active source modes avoids multiplying the same alpha twice.
export function setupColorAlpha(
  system: DesignSystem,
  source: Fields[],
  alphas: Map<string, AlphaValues>,
  ctx: LayerContext,
  reference: (value: unknown, ctx: LayerContext) => string,
) {
  const byId = new Map(source.map((n) => [guid(n.guid), n]));
  const modesCache = new Map<string, Record<string, string>>();
  function modesFor(row: Fields, depth = 0): Record<string, string> {
    const id = guid(row.guid);
    const cached = modesCache.get(id);
    if (cached) return cached;
    const parent = byId.get(guid(obj(row.parentIndex).guid));
    const inherited =
      parent && depth < 256 ? modesFor(parent, depth + 1) : system.activeModes;
    const entries = rows(obj(row.variableModeBySetMap).entries);
    const modes = entries.length ? { ...inherited } : inherited;
    for (const entry of entries) {
      const collection = reference(entry.variableSetID, ctx);
      const mode = guid(entry.variableModeID);
      if (system.collections[collection]?.modes.some((m) => m.id === mode))
        modes[collection] = mode;
    }
    if (id) modesCache.set(id, modes);
    return modes;
  }
  function current(id: string, modes: Record<string, string>): number {
    const v = system.variables[id];
    const value =
      alphas.get(id)?.[
        modes[v.collectionId] ??
          system.collections[v.collectionId].defaultModeId
      ];
    return typeof value === "object"
      ? current(value.alias, modes)
      : (value ?? 1);
  }
  const nonopaque = new Map<string, boolean>();
  function hasAlpha(id: string): boolean {
    if (nonopaque.has(id)) return nonopaque.get(id)!;
    const result = Object.values(alphas.get(id) ?? {}).some((v) =>
      typeof v === "number" ? v !== 1 : hasAlpha(v.alias),
    );
    nonopaque.set(id, result);
    return result;
  }
  const names = new Set(
    Object.values(system.variables).map((v) => v.collectionId + "/" + v.name),
  );
  function companion(id: string, factor: number): string {
    const key = "alpha-" + id + "-" + factor;
    if (system.variables[key]) return key;
    const v = system.variables[id];
    const suffix =
      " / Alpha" + (factor === 1 ? "" : " × " + factor.toPrecision(4));
    let name = v.name.slice(0, 200 - suffix.length) + suffix;
    if (names.has(v.collectionId + "/" + name))
      name = name.slice(0, 195 - key.length) + " (" + key + ")";
    names.add(v.collectionId + "/" + name);
    const values = Object.fromEntries(
      Object.entries(alphas.get(id)!).map(([mode, value]) => [
        mode,
        typeof value === "number"
          ? factor * value
          : hasAlpha(value.alias)
            ? { alias: companion(value.alias, factor) }
            : factor,
      ]),
    );
    system.variables[key] = {
      id: key,
      name,
      collectionId: v.collectionId,
      type: "number",
      description: v.name + " 的源颜色透明度",
      codeSyntax: "",
      scopes: ["fillOpacity", "colorOpacity", "strokeOpacity"],
      values,
    };
    return key;
  }
  for (const id of alphas.keys())
    if (system.variables[id] && hasAlpha(id)) companion(id, 1);
  ctx.alphaBinding = (id, paint, row) => {
    if (!system.variables[id] || !hasAlpha(id)) return;
    const base = current(id, modesFor(row));
    const effective = clamp(
      num(paint.opacity, 1) * num(obj(paint.color).a, 1),
      0,
      1,
    );
    const factor = Math.abs(effective - base) < 1e-6 ? 1 : effective / base;
    if (factor >= 0 && factor <= 1) return companion(id, factor);
    ctx.report(
      guid(row.guid),
      "颜色变量 Alpha 与源图层当前值不一致，保留图层透明度",
    );
  };
}
