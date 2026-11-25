import { strokePaintOverrideKeys } from "../../domain/stroke-paint-overrides";
import {
  emptyDesignSystem,
  type DesignVariable,
  type VariableValue,
  type DesignSystem,
} from "../../domain/design-system-schema";
import {
  styleGroups,
  type StyleKind,
  type VariableProperty,
  propertyType,
} from "../../domain/design-properties";
import { fillUsesTextColor, type DesignNode } from "../../domain/node";
import { bindingValueSchema } from "../../domain/design-system";
import {
  makeLayer,
  type LayerContext,
  type Fields,
  obj,
  str,
  rows,
  guid,
  hex,
  num,
} from "./figma-layer";
import { setupColorAlpha, type AlphaValues } from "./figma-alpha";
const kinds: ReadonlyMap<unknown, StyleKind> = new Map([
  ["FILL", "paint"],
  ["TEXT", "text"],
  ["EFFECT", "effect"],
]);
function reference(value: unknown, ctx: LayerContext) {
  const ref = obj(value);
  return guid(ref.guid) || ctx.assetKeys.get(str(obj(ref.assetRef).key)) || "";
}
// A pair of uint32 max values explicitly detaches an inherited style.
function detachedStyle(value: unknown) {
  const id = obj(obj(value).guid);
  return id.sessionID === 0xffffffff && id.localID === 0xffffffff;
}
function alias(value: unknown, ctx: LayerContext) {
  return reference(obj(obj(value).value).alias, ctx);
}
export function buildStyles(nodes: Fields[], ctx: LayerContext) {
  const system = emptyDesignSystem(),
    names = new Set<string>(),
    alphas = new Map<string, AlphaValues>();
  for (const r of nodes.filter((r) => r.type === "VARIABLE_SET")) {
    const id = guid(r.guid),
      modes = rows(r.variableSetModes).map((m) => ({
        id: guid(m.id),
        name: str(m.name),
      }));
    if (
      !modes.length ||
      modes.length > 20 ||
      modes.some((m) => !m.id || !m.name)
    ) {
      ctx.report(id, "变量集合模式不受支持");
      continue;
    }
    system.collections[id] = {
      id,
      name: str(r.name) || id,
      modes,
      defaultModeId: modes[0].id,
    };
    system.activeModes[id] = modes[0].id;
  }
  const types = new Map<unknown, DesignVariable["type"]>([
    ["FLOAT", "number"],
    ["BOOLEAN", "boolean"],
    ["STRING", "string"],
    ["COLOR", "color"],
  ]);
  for (const r of nodes.filter((r) => r.type === "VARIABLE")) {
    const id = guid(r.guid),
      collectionId = reference(r.variableSetID, ctx),
      type = types.get(r.variableResolvedType),
      collection = system.collections[collectionId];
    if (!type || !collection) {
      ctx.report(id, "变量缺少集合或类型");
      continue;
    }
    const values: Record<string, VariableValue> = {},
      alpha: AlphaValues = {};
    for (const e of rows(obj(r.variableDataValues).entries)) {
      const data = obj(e.variableData),
        v = obj(data.value),
        mode = guid(e.modeID);
      if (!mode) continue;
      if (alias(data, ctx)) {
        values[mode] = { alias: alias(data, ctx) };
        if (type === "color") alpha[mode] = { alias: alias(data, ctx) };
      } else if (type === "color" && v.colorValue) {
        values[mode] = hex(v.colorValue);
        alpha[mode] = Math.min(1, Math.max(0, num(obj(v.colorValue).a, 1)));
      } else if (
        typeof v.floatValue === "number" &&
        Number.isFinite(v.floatValue)
      )
        values[mode] = v.floatValue;
      else if (typeof v.textValue === "string") values[mode] = v.textValue;
      else if (typeof v.boolValue === "boolean") values[mode] = v.boolValue;
    }
    if (collection.modes.some((m) => values[m.id] === undefined)) {
      ctx.report(id, "变量部分模式引用外部资产或不受支持");
      continue;
    }
    if (type === "color") alphas.set(id, alpha);
    let name = str(r.name) || id;
    if (names.has(collectionId + "/" + name)) name += " (" + id + ")";
    names.add(collectionId + "/" + name);
    const platformCodeSyntax: NonNullable<
      DesignVariable["platformCodeSyntax"]
    > = {};
    const platforms: Record<string, keyof typeof platformCodeSyntax> = {
      WEB: "web",
      ANDROID: "android",
      IOS: "ios",
    };
    for (const entry of rows(obj(r.codeSyntax).entries)) {
      const platform = platforms[str(entry.platform).toUpperCase()];
      if (
        platform &&
        typeof entry.value === "string" &&
        entry.value.length <= 200
      )
        platformCodeSyntax[platform] = entry.value;
      else ctx.report(id, "变量平台代码语法未映射 " + str(entry.platform));
    }
    system.variables[id] = {
      id,
      collectionId,
      name,
      type,
      description: str(r.description),
      codeSyntax:
        /^var\((--[A-Za-z_][A-Za-z0-9_-]*)\)$/.exec(
          platformCodeSyntax.web ?? "",
        )?.[1] ?? "",
      ...(Object.keys(platformCodeSyntax).length ? { platformCodeSyntax } : {}),
      scopes: [],
      values,
    };
  }
  // Validate alias closure before attaching bindings to it.
  const valid = new Map<string, boolean>();
  const check = (id: string, trail: Set<string>): boolean => {
    const v = system.variables[id];
    if (!v || trail.has(id) || trail.size > 100) return false;
    if (valid.has(id)) return valid.get(id)!;
    trail.add(id);
    const ok = Object.values(v.values).every(
      (x) =>
        typeof x !== "object" ||
        (system.variables[x.alias]?.type === v.type && check(x.alias, trail)),
    );
    trail.delete(id);
    valid.set(id, ok);
    return ok;
  };
  for (const id of Object.keys(system.variables))
    if (!check(id, new Set())) {
      delete system.variables[id];
      ctx.report(id, "变量别名缺失或成环");
    }
  setupColorAlpha(system, nodes, alphas, ctx, reference);
  const styleRecords = nodes
    .filter((r) => r.styleType)
    .sort(
      (a, b) =>
        Number(a.isSoftDeleted === true) - Number(b.isSoftDeleted === true),
    );
  for (const r of styleRecords) {
    const id = guid(r.guid),
      kind = kinds.get(r.styleType);
    if (!kind) {
      ctx.report(id, "未映射的共享样式 " + str(r.styleType));
      continue;
    }
    const n = makeLayer(r, id, null, ctx);
    let name = str(r.name) || id;
    if (names.has(kind + "/" + name)) name += " (" + id + ")";
    names.add(kind + "/" + name);
    const properties = Object.fromEntries(
      styleGroups[kind]
        .filter((k) => n.style[k] !== undefined)
        .map((k) => [k, n.style[k]]),
    );
    const bindings: Partial<Record<VariableProperty, string>> = {};
    if (kind === "paint" || kind === "text")
      bindPaints(r, n, system, ctx, (key, token) => {
        if (
          token &&
          system.variables[token] &&
          (styleGroups[kind] as readonly string[]).includes(key)
        )
          bindings[key] = token;
      });
    system.styles[id] = {
      ...(r.isSoftDeleted === true ? { sourceArchived: true as const } : {}),
      id,
      name,
      kind,
      properties,
      description: str(r.description),
      bindings,
    };
  }
  return system;
}
export function bindStyles(
  r: Fields,
  n: DesignNode,
  system: DesignSystem,
  ctx: LayerContext,
  overrides: { fill?: boolean; stroke?: boolean } = {},
) {
  for (const entry of rows(obj(r.variableModeBySetMap).entries)) {
    const collection = reference(entry.variableSetID, ctx),
      mode = guid(entry.variableModeID);
    if (system.collections[collection] && entry.variableModeID === undefined)
      continue;
    if (system.collections[collection]?.modes.some((m) => m.id === mode)) {
      n.variableModes ??= {};
      n.variableModes[collection] = mode;
    } else
      ctx.report(
        guid(r.guid),
        "图层变量模式无法解析 " + collection + "/" + mode,
      );
  }
  const paintBindings = new Map<VariableProperty, string>();
  bindPaints(r, n, system, ctx, (property, id) =>
    paintBindings.set(property, id),
  );
  const inherited = new Map<string, string>();
  for (const [field, kind] of [
    ["styleIdForText", "text"],
    ["styleIdForFill", "paint"],
    ["styleIdForEffect", "effect"],
  ] as const) {
    if (!r[field] || detachedStyle(r[field])) continue;
    const id = reference(r[field], ctx);
    if (system.styles[id]?.kind === kind) {
      n.styleBindings ??= {};
      n.styleBindings[kind] = id;
      for (const [key, variable] of Object.entries(
        system.styles[id].bindings,
      )) {
        const glyph = kind === "paint" && fillUsesTextColor(n);
        inherited.set(
          glyph && key === "fill"
            ? "color"
            : glyph && key === "fillOpacity"
              ? "colorOpacity"
              : key,
          variable,
        );
      }
      // The local .fig snapshot can contain stale pigment beside a live style
      // reference. Figma uses the linked paint until an instance overrides it.
      if (kind === "paint") {
        const paint = system.styles[id].properties;
        if (n.vector && (paint.gradient || paint.paints?.length))
          n.vector.fillFromStyle = true;
        if (!overrides.fill) continue;
        for (const key of styleGroups.paint) {
          const localKey = fillUsesTextColor(n)
            ? key === "fill"
              ? "color"
              : key === "fillOpacity"
                ? "colorOpacity"
                : key
            : key;
          if (
            JSON.stringify(n.style[localKey]) !== JSON.stringify(paint[key])
          ) {
            n.styleOverrides ??= [];
            n.styleOverrides.push(key);
          }
        }
        continue;
      }
      for (const [key, value] of Object.entries(system.styles[id].properties)) {
        if (
          JSON.stringify(n.style[key as keyof DesignNode["style"]]) !==
          JSON.stringify(value)
        ) {
          n.styleOverrides ??= [];
          n.styleOverrides.push(key);
        }
      }
    } else {
      const target = id || str(obj(obj(r[field]).assetRef).key);
      ctx.report(
        guid(r.guid),
        "共享样式无法在本文件解析 " + field + " " + target,
      );
    }
  }
  if (r.styleIdForStrokeFill && !detachedStyle(r.styleIdForStrokeFill)) {
    const id = reference(r.styleIdForStrokeFill, ctx),
      paint = system.styles[id];
    if (paint?.kind !== "paint")
      ctx.report(guid(r.guid), "共享描边样式无法在本文件解析");
    else if (
      paint.properties.gradient ||
      paint.properties.paints?.some((p) => p.gradient) ||
      n.type === "vector"
    )
      ctx.report(guid(r.guid), "描边样式保留图层或路径当前值");
    else {
      n.styleBindings ??= {};
      n.styleBindings.stroke = id;
      const stack = paint.properties.paints;
      for (const [source, target] of [
        ["fill", "stroke"],
        ["fillOpacity", "strokeOpacity"],
      ] as const) {
        const variable = paint.bindings[source];
        if (variable) inherited.set(target, variable);
        if (
          overrides.stroke &&
          !stack?.length &&
          !n.style.strokePaints?.length &&
          paint.properties[source] !== undefined &&
          n.style[target] !== paint.properties[source]
        ) {
          n.styleOverrides ??= [];
          n.styleOverrides.push(target);
        }
      }
    }
  }
  function bind(key: VariableProperty, id: string) {
    const v = system.variables[id];
    if (!id) return;
    if (!v || v.type !== propertyType(key)) {
      ctx.report(guid(r.guid), "变量绑定无法解析 " + key);
      return;
    }
    const field = bindingValueSchema(key);
    if (field) {
      const seen = new Set<string>();
      function fits(token: string): boolean {
        if (seen.has(token)) return true;
        seen.add(token);
        return Object.values(system.variables[token].values).every((value) =>
          typeof value === "object"
            ? fits(value.alias)
            : field.safeParse(value).success,
        );
      }
      if (!fits(id)) {
        ctx.report(guid(r.guid), "变量模式值超出属性范围 " + key);
        return;
      }
    }
    if (inherited.get(key) === id && !n.styleOverrides?.includes(key)) return;
    n.variableBindings ??= {};
    n.variableBindings[key] = id;
  }
  for (const [property, id] of paintBindings) {
    if (
      !overrides.fill &&
      n.styleBindings?.paint &&
      ["fill", "color", "fillOpacity", "colorOpacity"].includes(property)
    )
      continue;
    if (
      !overrides.stroke &&
      n.styleBindings?.stroke &&
      (property === "stroke" || property === "strokeOpacity")
    )
      continue;
    bind(property, id);
  }
  // A stroke paint cached on a regular node can predate an update to its
  // linked style. Only an authored component override supersedes that style.
  const strokeStyle =
    n.styleBindings?.stroke && system.styles[n.styleBindings.stroke];
  if (
    overrides.stroke &&
    strokeStyle &&
    (strokeStyle.properties.paints || n.style.strokePaints)
  ) {
    const keys = strokePaintOverrideKeys(
      strokeStyle.properties.paints,
      n.style.strokePaints,
    );
    if (keys.length) n.styleOverrides = [...(n.styleOverrides ?? []), ...keys];
  }
  const keys: Record<string, VariableProperty> = {
    STACK_SPACING: "gap",
    WIDTH: "width",
    HEIGHT: "height",
    STACK_PADDING_LEFT: "insets.left",
    STACK_PADDING_RIGHT: "insets.right",
    STACK_PADDING_TOP: "insets.top",
    STACK_PADDING_BOTTOM: "insets.bottom",
    BORDER_TOP_WEIGHT: "strokeSides.top",
    BORDER_LEFT_WEIGHT: "strokeSides.left",
    BORDER_RIGHT_WEIGHT: "strokeSides.right",
    BORDER_BOTTOM_WEIGHT: "strokeSides.bottom",
    RECTANGLE_TOP_LEFT_CORNER_RADIUS: "corners.tl",
    RECTANGLE_TOP_RIGHT_CORNER_RADIUS: "corners.tr",
    RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS: "corners.bl",
    RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: "corners.br",
    ...(obj(r.lineHeight).units === "PIXELS"
      ? { LINE_HEIGHT: "lineHeight" as const }
      : {}),
    ...(obj(r.letterSpacing).units === "PIXELS"
      ? { LETTER_SPACING: "letterSpacing" as const }
      : {}),
    FONT_SIZE: "fontSize",
    RECTANGLE_CORNER_RADIUS: "radius",
    STROKE_WEIGHT: "strokeWidth",
    OPACITY: "opacity",
    VISIBLE: "visible",
    TEXT_DATA: "text",
    FONT_FAMILY: "fontFamily",
  };
  for (const e of rows(obj(r.variableConsumptionMap).entries)) {
    const id = alias(e.variableData, ctx),
      key = keys[str(e.variableField)];
    if (key === "strokeWidth" && n.vector && id)
      ctx.report(guid(r.guid), "矢量描边宽度变量已按各路径宽度导入");
    else if (key) bind(key, id);
    else if (id)
      ctx.report(
        guid(r.guid),
        "变量字段已按图层值导入 " + str(e.variableField),
      );
  }
}

function bindPaints(
  r: Fields,
  n: DesignNode,
  system: DesignSystem,
  ctx: LayerContext,
  bind: (key: VariableProperty, id: string) => void,
) {
  const paints = rows(r.fillPaints);
  const visible = paints.filter((p) => p.visible !== false);
  const glyph = r.styleType === "TEXT" || fillUsesTextColor(n);
  const imageIndex = paints.findIndex(
    (p) => p.type === "IMAGE" && p.visible !== false,
  );
  const fill = glyph
    ? visible.at(-1)
    : imageIndex >= 0
      ? imageIndex === 1
        ? paints[0]
        : undefined
      : n.style.paints
        ? undefined
        : visible.at(-1);
  function bindColor(
    p: Fields | undefined,
    key: "fill" | "color" | "stroke",
    opacity: "fillOpacity" | "colorOpacity" | "strokeOpacity",
  ) {
    if (!p || p.type !== "SOLID" || p.visible === false) return;
    const id = alias(p.colorVar, ctx);
    if (!id) return;
    bind(key, id);
    const alpha = ctx.alphaBinding?.(id, p, r);
    if (alpha) bind(opacity, alpha);
  }
  bindColor(
    fill,
    glyph ? "color" : "fill",
    glyph ? "colorOpacity" : "fillOpacity",
  );
  const mapped = new Set<Fields>();
  const stacked = n.style.paints;
  const bindStops = (
    source: Fields,
    gradient: DesignNode["style"]["gradient"],
  ) => {
    if (!gradient) return;
    const originals = rows(source.stopsVar);
    if (originals.length !== gradient.stops.length) return;
    for (const [index, stop] of originals.entries()) {
      const id = alias(stop.colorVar, ctx);
      if (!id) continue;
      if (system.variables[id]?.type === "color")
        gradient.stops[index].variableId = id;
      else ctx.report(guid(r.guid), "渐变色标变量无法解析 " + id);
    }
  };
  if (n.style.gradient && fill) bindStops(fill, n.style.gradient);
  if (stacked) {
    const sources = imageIndex < 0 ? paints : paints.slice(imageIndex + 1);
    if (sources.length === stacked.length) {
      for (const [i, source] of sources.entries()) {
        const target = stacked[stacked.length - i - 1];
        bindStops(source, target.gradient);
        const id = alias(source.colorVar, ctx);
        if (!id || system.variables[id]?.type !== "color") continue;
        target.colorVariableId = id;
        const alpha = ctx.alphaBinding?.(id, source, r);
        if (alpha) target.opacityVariableId = alpha;
        mapped.add(source);
      }
    }
  }
  for (const p of visible)
    if (p !== fill && !mapped.has(p) && alias(p.colorVar, ctx))
      ctx.report(guid(r.guid), "额外填充颜色变量保留图层当前值");
  const strokeSources = rows(r.strokePaints);
  const stroke = strokeSources.filter((p) => p.visible !== false).at(-1);
  if (n.style.strokePaints) {
    for (const [i, p] of strokeSources.entries()) {
      const color = alias(p.colorVar, ctx);
      if (!color) continue;
      if (system.variables[color]?.type !== "color") {
        ctx.report(guid(r.guid), "描边颜色变量无法解析 " + color);
        continue;
      }
      const layer = n.style.strokePaints[n.style.strokePaints.length - 1 - i];
      layer.colorVariableId = color;
      const alpha = ctx.alphaBinding?.(color, p, r);
      if (alpha) layer.opacityVariableId = alpha;
    }
  } else if (n.type !== "vector") bindColor(stroke, "stroke", "strokeOpacity");
  else if (!visible.length) bindColor(stroke, "color", "colorOpacity");
  else if (stroke && alias(stroke.colorVar, ctx))
    ctx.report(guid(r.guid), "矢量独立描边颜色变量保留路径当前值");
}
