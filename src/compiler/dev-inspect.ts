import type {
  Annotation,
  DesignDocument,
  DesignNode,
  NodeStyle,
} from "../domain/document";
import {
  effectiveModes,
  resolveNode,
  resolveVariable,
} from "../domain/design-system";
import { layoutBounds } from "../domain/geometry";
import { cssVariableName } from "./design-tokens";
import { gradientCss, rgba } from "./paints";

export type DevUnit = "px" | "rem";

export interface DevBoxModel {
  width: number;
  height: number;
  padding: { top: number; right: number; bottom: number; left: number };
  border: { top: number; right: number; bottom: number; left: number };
  gap: number;
  rowGap?: number;
  layout: NodeStyle["layout"];
}

export interface DevTokenBinding {
  property: string;
  kind: "variable" | "style" | "legacy-token";
  id: string;
  name: string;
  resolvedValue: string | number | boolean;
  codeSyntax: {
    web: string;
    react: string;
    ios: string;
    android: string;
  };
}

export interface DevInspectOutput {
  nodeId: string;
  nodeName: string;
  nodeType: DesignNode["type"];
  unit: DevUnit;
  devStatus: NonNullable<DesignNode["devStatus"]>;
  annotations: Annotation[];
  boxModel: DevBoxModel;
  tokens: DevTokenBinding[];
  snippets: {
    css: string;
    tailwind: string;
    react: string;
  };
}

function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function fmtLength(px: number, unit: DevUnit): string {
  if (px === 0) return "0";
  if (unit === "rem") return `${round(px / 16, 4)}rem`;
  return `${round(px, 2)}px`;
}

function camelIdentifier(name: string): string {
  const parts = name
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "token";
  const joined = parts
    .map((part, idx) =>
      idx === 0
        ? part.toLowerCase()
        : part[0].toUpperCase() + part.slice(1).toLowerCase(),
    )
    .join("");
  return /^[0-9]/.test(joined) ? `t${joined}` : joined;
}

function cssClassName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "layer";
}

function twWeight(weight?: number): string | undefined {
  if (!weight) return undefined;
  const map: Record<number, string> = {
    100: "font-thin",
    200: "font-extralight",
    300: "font-light",
    400: "font-normal",
    500: "font-medium",
    600: "font-semibold",
    700: "font-bold",
    800: "font-extrabold",
    900: "font-black",
  };
  return map[weight] ?? `font-[${weight}]`;
}

/**
 * Generate Dev Mode inspection output: box-model metrics, resolved token bindings
 * with multi-platform code syntax, and CSS / Tailwind / React snippets in px or rem.
 */
export function inspectNodeForDev(
  doc: DesignDocument,
  nodeId: string,
  unit: DevUnit = "px",
): DevInspectOutput {
  const raw = doc.nodes.find((n) => n.id === nodeId);
  if (!raw) throw new Error(`图层不存在：${nodeId}`);

  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const resolved = resolveNode(doc, raw, byId);
  const s = resolved.style;
  const measured = layoutBounds(doc).get(nodeId);
  const width = round(measured?.width ?? s.width, 2);
  const height = round(measured?.height ?? s.height, 2);

  const padding =
    resolved.type === "frame"
      ? s.insets
        ? { ...s.insets }
        : {
            top: s.padding,
            right: s.padding,
            bottom: s.padding,
            left: s.padding,
          }
      : resolved.type === "button"
        ? { top: 8, right: 8, bottom: 8, left: 8 }
        : { top: 0, right: 0, bottom: 0, left: 0 };

  const border =
    s.strokeVisible === false
      ? { top: 0, right: 0, bottom: 0, left: 0 }
      : {
          top: s.strokeSides?.top ?? s.strokeWidth ?? 0,
          right: s.strokeSides?.right ?? s.strokeWidth ?? 0,
          bottom: s.strokeSides?.bottom ?? s.strokeWidth ?? 0,
          left: s.strokeSides?.left ?? s.strokeWidth ?? 0,
        };

  const boxModel: DevBoxModel = {
    width,
    height,
    padding,
    border,
    gap: s.layout !== "free" ? s.gap : 0,
    ...(s.layout !== "free" && s.rowGap !== undefined
      ? { rowGap: s.rowGap }
      : {}),
    layout: s.layout,
  };

  // Collect bound tokens & styles
  const tokens: DevTokenBinding[] = [];
  const varSyntaxByProp = new Map<string, string>();
  const system = doc.designSystem;
  const modes = system ? effectiveModes(doc, raw, byId) : {};

  if (system && raw.variableBindings) {
    for (const [property, varId] of Object.entries(raw.variableBindings)) {
      if (!varId) continue;
      const variable = system.variables[varId];
      if (!variable) continue;
      const value = resolveVariable(system, varId, modes);
      const cssName = cssVariableName(system, varId);
      const ident = camelIdentifier(variable.name);
      const web =
        variable.platformCodeSyntax?.web?.trim() ||
        (variable.codeSyntax.trim()
          ? variable.codeSyntax.trim().startsWith("--")
            ? `var(${variable.codeSyntax.trim()})`
            : variable.codeSyntax.trim()
          : `var(${cssName})`);
      const react =
        variable.platformCodeSyntax?.react?.trim() || `tokens.${ident}`;
      const ios =
        variable.platformCodeSyntax?.ios?.trim() ||
        (variable.type === "color"
          ? `Color("${variable.name}")`
          : `DesignTokens.${ident}`);
      const android =
        variable.platformCodeSyntax?.android?.trim() || `DesignTokens.${ident}`;
      varSyntaxByProp.set(property, web);
      tokens.push({
        property,
        kind: "variable",
        id: variable.id,
        name: variable.name,
        resolvedValue: value,
        codeSyntax: { web, react, ios, android },
      });
    }
  }

  if (system && raw.styleBindings) {
    for (const [kind, styleId] of Object.entries(raw.styleBindings)) {
      if (!styleId) continue;
      const style = system.styles[styleId];
      if (!style) continue;
      const ident = camelIdentifier(style.name);
      tokens.push({
        property: `style.${kind}`,
        kind: "style",
        id: style.id,
        name: style.name,
        resolvedValue: style.name,
        codeSyntax: {
          web: `.${cssClassName(style.name)}`,
          react: `styles.${ident}`,
          ios: `DesignStyles.${ident}`,
          android: `DesignStyles.${ident}`,
        },
      });
    }
  }

  if (raw.fillToken && doc.tokens[raw.fillToken]) {
    const legacy = doc.tokens[raw.fillToken];
    const web = `var(--token-${raw.fillToken})`;
    const ident = camelIdentifier(legacy.name);
    varSyntaxByProp.set("fill", web);
    tokens.push({
      property: "fill",
      kind: "legacy-token",
      id: raw.fillToken,
      name: legacy.name,
      resolvedValue: legacy.value,
      codeSyntax: {
        web,
        react: `tokens.${ident}`,
        ios: `Color("${legacy.name}")`,
        android: `DesignTokens.${ident}`,
      },
    });
  }

  // Build CSS declarations
  const cssProps: [string, string][] = [];
  const reactStyleEntries: [string, string | number][] = [];
  const tw: string[] = [];

  const addDecl = (
    cssProp: string,
    reactProp: string,
    cssVal: string,
    reactVal: string | number = cssVal,
  ) => {
    cssProps.push([cssProp, cssVal]);
    reactStyleEntries.push([reactProp, reactVal]);
  };

  // Layout
  if (resolved.type === "frame" && s.layout !== "free") {
    if (s.layout === "grid") {
      addDecl("display", "display", "grid");
      tw.push("grid");
      if (s.columns) {
        addDecl(
          "grid-template-columns",
          "gridTemplateColumns",
          `repeat(${s.columns}, minmax(0, 1fr))`,
        );
        tw.push(`grid-cols-${s.columns}`);
      }
    } else {
      addDecl("display", "display", "flex");
      addDecl("flex-direction", "flexDirection", s.layout);
      tw.push("flex", s.layout === "row" ? "flex-row" : "flex-col");
      if (s.wrap) {
        addDecl("flex-wrap", "flexWrap", "wrap");
        tw.push("flex-wrap");
      }
      const justify =
        s.justifyContent === "space-between"
          ? "space-between"
          : ((s.layout === "row" ? s.alignX : s.alignY) ?? "flex-start");
      const align = (s.layout === "row" ? s.alignY : s.alignX) ?? "flex-start";
      const mapFlex = (v: string) =>
        v === "start" ? "flex-start" : v === "end" ? "flex-end" : v;
      addDecl("justify-content", "justifyContent", mapFlex(justify));
      addDecl("align-items", "alignItems", mapFlex(align));
      tw.push(
        justify === "space-between"
          ? "justify-between"
          : justify === "center"
            ? "justify-center"
            : justify === "end"
              ? "justify-end"
              : "justify-start",
        align === "center"
          ? "items-center"
          : align === "end"
            ? "items-end"
            : "items-start",
      );
    }
    if (s.gap > 0) {
      const gapStr = fmtLength(s.gap, unit);
      addDecl("gap", "gap", varSyntaxByProp.get("gap") ?? gapStr);
      tw.push(`gap-[${gapStr}]`);
    }
    if (s.rowGap !== undefined && s.rowGap !== s.gap) {
      const rowGapStr = fmtLength(s.rowGap, unit);
      addDecl("row-gap", "rowGap", rowGapStr);
      tw.push(`gap-y-[${rowGapStr}]`);
    }
  } else if (resolved.type === "button") {
    addDecl("display", "display", "flex");
    addDecl("align-items", "alignItems", "center");
    addDecl("justify-content", "justifyContent", "center");
    tw.push("flex", "items-center", "justify-center");
  }

  // Dimensions
  const wVal = varSyntaxByProp.get("width") ?? fmtLength(width, unit);
  const hVal = varSyntaxByProp.get("height") ?? fmtLength(height, unit);
  addDecl("width", "width", wVal);
  addDecl("height", "height", hVal);
  tw.push(`w-[${fmtLength(width, unit)}]`, `h-[${fmtLength(height, unit)}]`);

  // Padding
  const { top: pt, right: pr, bottom: pb, left: pl } = padding;
  if (pt || pr || pb || pl) {
    if (pt === pr && pr === pb && pb === pl) {
      const pVal = varSyntaxByProp.get("padding") ?? fmtLength(pt, unit);
      addDecl("padding", "padding", pVal);
      tw.push(`p-[${fmtLength(pt, unit)}]`);
    } else if (pt === pb && pl === pr) {
      const padStr = `${fmtLength(pt, unit)} ${fmtLength(pr, unit)}`;
      addDecl("padding", "padding", padStr);
      tw.push(`py-[${fmtLength(pt, unit)}]`, `px-[${fmtLength(pr, unit)}]`);
    } else {
      const padStr = `${fmtLength(pt, unit)} ${fmtLength(pr, unit)} ${fmtLength(pb, unit)} ${fmtLength(pl, unit)}`;
      addDecl("padding", "padding", padStr);
      if (pt) tw.push(`pt-[${fmtLength(pt, unit)}]`);
      if (pr) tw.push(`pr-[${fmtLength(pr, unit)}]`);
      if (pb) tw.push(`pb-[${fmtLength(pb, unit)}]`);
      if (pl) tw.push(`pl-[${fmtLength(pl, unit)}]`);
    }
  }

  // Background
  if (!["text", "group", "vector", "slice"].includes(resolved.type)) {
    if (s.gradient) {
      const bg = gradientCss(s.gradient, s.fillOpacity ?? 1);
      addDecl("background", "background", bg);
      tw.push(`bg-[${bg.replace(/\s+/g, "_")}]`);
    } else if ((s.fillOpacity ?? 1) > 0) {
      const fillExpr =
        varSyntaxByProp.get("fill") ??
        (s.fillOpacity !== undefined && s.fillOpacity !== 1
          ? rgba(s.fill, s.fillOpacity)
          : s.fill);
      addDecl("background-color", "backgroundColor", fillExpr);
      tw.push(`bg-[${s.fill}]`);
    }
  }

  // Border / Stroke
  const { top: bt, right: br, bottom: bb, left: bl } = border;
  if (bt || br || bb || bl) {
    const strokeColor =
      varSyntaxByProp.get("stroke") ??
      (s.strokeOpacity !== undefined && s.strokeOpacity !== 1
        ? rgba(s.stroke ?? s.color, s.strokeOpacity)
        : (s.stroke ?? s.color));
    const lineStyle = s.strokeStyle ?? "solid";
    if (bt === br && br === bb && bb === bl) {
      const bw = fmtLength(bt, unit);
      addDecl("border", "border", `${bw} ${lineStyle} ${strokeColor}`);
      tw.push(`border-[${bw}]`, `border-[${s.stroke ?? s.color}]`);
    } else {
      addDecl("border-style", "borderStyle", lineStyle);
      addDecl("border-color", "borderColor", strokeColor);
      addDecl(
        "border-width",
        "borderWidth",
        `${fmtLength(bt, unit)} ${fmtLength(br, unit)} ${fmtLength(bb, unit)} ${fmtLength(bl, unit)}`,
      );
      tw.push(`border-[${s.stroke ?? s.color}]`);
    }
  }

  // Border radius
  if (resolved.type === "ellipse") {
    addDecl("border-radius", "borderRadius", "50%");
    tw.push("rounded-full");
  } else if (s.corners) {
    const rad = [s.corners.tl, s.corners.tr, s.corners.br, s.corners.bl]
      .map((v) => fmtLength(v, unit))
      .join(" ");
    addDecl("border-radius", "borderRadius", rad);
    tw.push(`rounded-[${rad.replace(/\s+/g, "_")}]`);
  } else if (s.radius > 0) {
    const rad = varSyntaxByProp.get("radius") ?? fmtLength(s.radius, unit);
    addDecl("border-radius", "borderRadius", rad);
    tw.push(`rounded-[${fmtLength(s.radius, unit)}]`);
  }

  // Typography
  if (resolved.type === "text" || resolved.type === "button" || resolved.text) {
    const colorExpr =
      varSyntaxByProp.get("color") ??
      (s.colorOpacity !== undefined && s.colorOpacity !== 1
        ? rgba(s.color, s.colorOpacity)
        : s.color);
    addDecl("color", "color", colorExpr);
    tw.push(`text-[${s.color}]`);

    const fs = varSyntaxByProp.get("fontSize") ?? fmtLength(s.fontSize, unit);
    addDecl("font-size", "fontSize", fs);
    tw.push(`text-[${fmtLength(s.fontSize, unit)}]`);

    if (s.fontFamily) {
      addDecl(
        "font-family",
        "fontFamily",
        varSyntaxByProp.get("fontFamily") ?? s.fontFamily,
      );
    }
    if (s.fontWeight) {
      addDecl("font-weight", "fontWeight", String(s.fontWeight), s.fontWeight);
      const wClass = twWeight(s.fontWeight);
      if (wClass) tw.push(wClass);
    }
    if (s.lineHeight) {
      const lh = fmtLength(s.lineHeight, unit);
      addDecl("line-height", "lineHeight", lh);
      tw.push(`leading-[${lh}]`);
    }
    if (s.letterSpacing) {
      const ls = fmtLength(s.letterSpacing, unit);
      addDecl("letter-spacing", "letterSpacing", ls);
      tw.push(`tracking-[${ls}]`);
    }
    if (s.textAlign) {
      addDecl("text-align", "textAlign", s.textAlign);
      tw.push(`text-${s.textAlign}`);
    }
  }

  // Opacity & Effects
  if (s.opacity !== undefined && s.opacity !== 1) {
    addDecl("opacity", "opacity", String(s.opacity), s.opacity);
    tw.push(`opacity-${Math.round(s.opacity * 100)}`);
  }
  if (s.clipContent) {
    addDecl("overflow", "overflow", "hidden");
    tw.push("overflow-hidden");
  }
  if (s.blur && s.blurVisible !== false) {
    const blurStr = `blur(${fmtLength(s.blur, unit)})`;
    addDecl("filter", "filter", blurStr);
    tw.push(`blur-[${fmtLength(s.blur, unit)}]`);
  }
  if (s.backdropBlur && s.backdropBlurVisible !== false) {
    const blurStr = `blur(${fmtLength(s.backdropBlur, unit)})`;
    addDecl("backdrop-filter", "backdropFilter", blurStr);
    tw.push(`backdrop-blur-[${fmtLength(s.backdropBlur, unit)}]`);
  }
  const activeShadows = s.shadows?.filter((sh) => sh.visible !== false) ?? [];
  if (activeShadows.length) {
    const shadowVal = activeShadows
      .map(
        (sh) =>
          `${sh.inset ? "inset " : ""}${fmtLength(sh.x, unit)} ${fmtLength(sh.y, unit)} ${fmtLength(sh.blur, unit)} ${fmtLength(sh.spread, unit)} ${rgba(sh.color, sh.opacity)}`,
      )
      .join(", ");
    addDecl("box-shadow", "boxShadow", shadowVal);
  }
  if (s.rotation) {
    addDecl("transform", "transform", `rotate(${s.rotation}deg)`);
    tw.push(`rotate-[${s.rotation}deg]`);
  }

  const selector = `.${cssClassName(resolved.name)}`;
  const css = `${selector} {\n${cssProps.map(([k, v]) => `  ${k}: ${v};`).join("\n")}\n}`;
  const tailwind = tw.join(" ");
  const tag =
    resolved.type === "button"
      ? "button"
      : resolved.type === "text"
        ? "p"
        : "div";
  const styleObj = reactStyleEntries
    .map(([k, v]) => `    ${k}: ${JSON.stringify(v)},`)
    .join("\n");
  const body = resolved.text ? `\n  ${resolved.text}\n` : "";
  const react = `<${tag}\n  style={{\n${styleObj}\n  }}\n>${body}</${tag}>`;

  return {
    nodeId: resolved.id,
    nodeName: resolved.name,
    nodeType: resolved.type,
    unit,
    devStatus: resolved.devStatus ?? "none",
    annotations: resolved.annotations ?? [],
    boxModel,
    tokens,
    snippets: { css, tailwind, react },
  };
}
