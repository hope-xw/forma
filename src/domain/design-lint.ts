import type { DesignDocument, DesignNode } from "./document";
import type { Operation } from "./commands";
import type { ReusableStyle } from "./design-system-schema";
import { hexToRgb, rgbToHex } from "./color";
import { layoutBounds, type Rect } from "./geometry";
import { effectiveModes, resolveNode, resolveVariable } from "./design-system";
import { applyReusableStyle, bindVariable } from "./design-system-actions";
import { ancestors, isLocked, subtreeIds } from "./tree";

export type LintIssueKind =
  "unbound-color" | "unbound-typography" | "low-contrast" | "generic-name";

export interface LintIssue {
  id: string;
  kind: LintIssueKind;
  severity: "error" | "warning" | "info";
  nodeId: string;
  nodeName: string;
  message: string;
  detail?: string;
  contrast?: {
    ratio: number;
    fg: string;
    bg: string;
    largeText: boolean;
  };
  suggestion?: string;
  fixOperations?: Operation[];
}

function normalizeHex(hex: string): string {
  const raw = hex.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(raw))
    return (
      "#" +
      raw[0] +
      raw[0] +
      raw[1] +
      raw[1] +
      raw[2] +
      raw[2]
    ).toLowerCase();
  if (/^[0-9a-f]{6}$/i.test(raw)) return "#" + raw.toLowerCase();
  return "#000000";
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(normalizeHex(hex)).map((channel) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 contrast ratio between two sRGB hex colors, rounded to 2 decimals. */
export function contrastRatio(fgHex: string, bgHex: string): number {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
}

/** WCAG 2.1 grade evaluation for normal or large text. */
export function wcagGrade(
  ratio: number,
  largeText = false,
): {
  ratio: number;
  aa: boolean;
  aaa: boolean;
  label: "AAA" | "AA" | "未通过";
} {
  const rounded = Math.round(ratio * 100) / 100;
  const aa = rounded >= (largeText ? 3 : 4.5);
  const aaa = rounded >= (largeText ? 4.5 : 7);
  const label = aaa ? "AAA" : aa ? "AA" : "未通过";
  return { ratio: rounded, aa, aaa, label };
}

function compositeOver(fgHex: string, alpha: number, bgHex: string): string {
  if (alpha >= 1) return normalizeHex(fgHex);
  if (alpha <= 0) return normalizeHex(bgHex);
  const [fr, fg, fb] = hexToRgb(normalizeHex(fgHex));
  const [br, bg, bb] = hexToRgb(normalizeHex(bgHex));
  return rgbToHex(
    fr * alpha + br * (1 - alpha),
    fg * alpha + bg * (1 - alpha),
    fb * alpha + bb * (1 - alpha),
  );
}

function rgbDistance(hexA: string, hexB: string): number {
  const [r1, g1, b1] = hexToRgb(normalizeHex(hexA));
  const [r2, g2, b2] = hexToRgb(normalizeHex(hexB));
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2);
}

// A lightweight contrast sample at the text box center, in the gradient
// layer's coordinates. Composite each stop before interpolating its color.
function linearBackdrop(
  gradient: NonNullable<DesignNode["style"]["gradient"]>,
  layer: Rect,
  text: Rect,
  alpha: number,
  base: string,
) {
  const x = text.x + text.width / 2 - layer.x;
  const y = text.y + text.height / 2 - layer.y;
  const radians = (gradient.angle * Math.PI) / 180;
  const dx = Math.sin(radians),
    dy = -Math.cos(radians);
  const span = Math.abs(dx) * layer.width + Math.abs(dy) * layer.height;
  const p = gradient.linearProjection;
  const position = p
    ? (p.x * x) / layer.width + (p.y * y) / layer.height + p.offset
    : 0.5 +
      ((x - layer.width / 2) * dx + (y - layer.height / 2) * dy) / (span || 1);
  const stops = gradient.stops;
  const color = (stop: (typeof stops)[number]) =>
    compositeOver(stop.color, stop.opacity * alpha, base);
  let left = stops[0];
  if (position < left.offset) return color(left);
  for (const right of stops.slice(1)) {
    if (position < right.offset) {
      const fraction = (position - left.offset) / (right.offset - left.offset);
      return compositeOver(color(right), fraction, color(left));
    }
    left = right;
  }
  return color(left);
}

function effectiveBackground(
  doc: DesignDocument,
  node: DesignNode,
  byId: ReadonlyMap<string, DesignNode>,
  getBounds: () => ReadonlyMap<string, Rect>,
): string {
  const pageBase =
    doc.pageBackgroundVisible === false
      ? "#ffffff"
      : normalizeHex(doc.pageBackground ?? "#ffffff");
  const chain = ancestors(doc, node.id).reverse();
  if (node.type === "button") chain.push(node);

  let bg = pageBase;
  for (const layer of chain) {
    if (["text", "group", "vector", "slice"].includes(layer.type)) continue;
    const resolved = resolveNode(doc, layer, byId);
    const fillHex =
      resolved.fillToken && doc.tokens[resolved.fillToken]
        ? doc.tokens[resolved.fillToken].value
        : resolved.style.fill;
    const opacity =
      (resolved.style.fillOpacity ?? 1) * (resolved.style.opacity ?? 1);
    if (opacity <= 0) continue;
    const gradient = resolved.style.gradient;
    if (gradient?.type === "linear") {
      const bounds = getBounds();
      const outer = bounds.get(layer.id),
        text = bounds.get(node.id);
      if (outer && outer.width > 0 && outer.height > 0 && text)
        bg = linearBackdrop(gradient, outer, text, opacity, bg);
    } else if (!gradient) {
      bg = compositeOver(fillHex, opacity, bg);
    }
  }
  return bg;
}

const GENERIC_NAME_RE =
  /^(矩形|椭圆|画板|图层|Rectangle|Ellipse|Frame|Layer)(\s*\d+)?$/i;

const COLOR_MATCH_MAX_DISTANCE = 12;

/**
 * Audit a document (or selected subtree) for unbound colors, unbound typography,
 * WCAG contrast violations, and duplicate generic layer names.
 */
export function checkDesigns(
  doc: DesignDocument,
  scopeIds?: string[],
): LintIssue[] {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  let bounds: ReadonlyMap<string, Rect> | undefined;
  const getBounds = () => (bounds ??= layoutBounds(doc));
  const scope = scopeIds?.length ? subtreeIds(doc, scopeIds) : null;
  const targets = doc.nodes.filter(
    (n) => !n.hidden && n.type !== "slice" && (!scope || scope.has(n.id)),
  );

  const issues: LintIssue[] = [];
  const system = doc.designSystem;
  const colorVars = system
    ? Object.values(system.variables).filter((v) => v.type === "color")
    : [];
  const paintStyles = system
    ? Object.values(system.styles).filter(
        (s) => s.kind === "paint" && !s.properties.gradient,
      )
    : [];
  const textStyles = system
    ? Object.values(system.styles).filter((s) => s.kind === "text")
    : [];

  function findColorMatch(
    hex: string,
    prop: "fill" | "color" | "stroke",
    node: DesignNode,
    modes: Record<string, string>,
  ): {
    label: string;
    distance: number;
    fix?: Operation;
  } | null {
    if (!system) return null;
    let best: {
      label: string;
      distance: number;
      fix?: Operation;
    } | null = null;

    for (const v of colorVars) {
      if (v.scopes.length && !v.scopes.includes(prop)) continue;
      let resolvedValue: string | number | boolean;
      try {
        resolvedValue = resolveVariable(system, v.id, modes);
      } catch {
        continue;
      }
      if (typeof resolvedValue !== "string") continue;
      const dist = rgbDistance(hex, resolvedValue);
      if (dist <= COLOR_MATCH_MAX_DISTANCE && (!best || dist < best.distance)) {
        best = {
          label: `变量 ${v.name}`,
          distance: dist,
          fix: bindVariable(node, prop, v.id),
        };
      }
    }

    const canUsePaintStyle =
      prop === "fill" ||
      (prop === "color" && ["text", "vector"].includes(node.type));
    if (canUsePaintStyle) {
      for (const style of paintStyles) {
        let styleColor: string | undefined;
        if (style.bindings.fill) {
          try {
            const val = resolveVariable(system, style.bindings.fill, modes);
            if (typeof val === "string") styleColor = val;
          } catch {
            continue;
          }
        } else if (style.properties.fill) {
          styleColor = style.properties.fill;
        }
        if (!styleColor) continue;
        const dist = rgbDistance(hex, styleColor);
        if (
          dist <= COLOR_MATCH_MAX_DISTANCE &&
          (!best || dist < best.distance)
        ) {
          best = {
            label: `颜色样式 ${style.name}`,
            distance: dist,
            fix: applyReusableStyle(node, style),
          };
        }
      }
    }

    return best;
  }

  function matchTextStyle(
    resolved: DesignNode,
    modes: Record<string, string>,
  ): ReusableStyle | null {
    if (!system || !textStyles.length) return null;
    for (const style of textStyles) {
      const readNum = (key: "fontSize" | "fontWeight" | "lineHeight") => {
        const bound = style.bindings[key];
        if (bound) {
          try {
            const v = resolveVariable(system, bound, modes);
            return typeof v === "number" ? v : undefined;
          } catch {
            return undefined;
          }
        }
        return style.properties[key];
      };
      const readStr = (key: "fontFamily") => {
        const bound = style.bindings[key];
        if (bound) {
          try {
            const v = resolveVariable(system, bound, modes);
            return typeof v === "string" ? v : undefined;
          } catch {
            return undefined;
          }
        }
        return style.properties[key];
      };

      const styleSize = readNum("fontSize");
      if (styleSize === undefined || styleSize !== resolved.style.fontSize)
        continue;
      const styleWeight = readNum("fontWeight");
      if (
        styleWeight !== undefined &&
        styleWeight !== (resolved.style.fontWeight ?? 400)
      )
        continue;
      const styleFamily = readStr("fontFamily");
      if (
        styleFamily !== undefined &&
        styleFamily.trim().toLowerCase() !==
          (resolved.style.fontFamily ?? "").trim().toLowerCase()
      )
        continue;
      return style;
    }
    return null;
  }

  // 1-3: Per-node checks
  for (const node of targets) {
    const resolved = resolveNode(doc, node, byId);
    const locked = isLocked(doc, node.id);
    const modes = system ? effectiveModes(doc, node, byId) : {};

    // 1. Unbound colors
    if (system && (colorVars.length || paintStyles.length)) {
      if (
        ["frame", "rectangle", "ellipse", "button", "section"].includes(
          node.type,
        ) &&
        (resolved.style.fillOpacity ?? 1) > 0 &&
        !resolved.style.gradient &&
        !node.variableBindings?.fill &&
        !node.styleBindings?.paint &&
        !node.fillToken
      ) {
        const match = findColorMatch(resolved.style.fill, "fill", node, modes);
        if (match) {
          issues.push({
            id: `unbound-color:${node.id}:fill`,
            kind: "unbound-color",
            severity: "warning",
            nodeId: node.id,
            nodeName: node.name,
            message: `填充色 ${resolved.style.fill} 未绑定，可替换为${match.label}`,
            suggestion: `绑定到${match.label}`,
            fixOperations: !locked && match.fix ? [match.fix] : undefined,
          });
        }
      }

      if (
        ["text", "button", "vector"].includes(node.type) &&
        (resolved.style.colorOpacity ?? 1) > 0 &&
        !node.variableBindings?.color &&
        !(["text", "vector"].includes(node.type) && node.styleBindings?.paint)
      ) {
        const match = findColorMatch(
          resolved.style.color,
          "color",
          node,
          modes,
        );
        if (match) {
          issues.push({
            id: `unbound-color:${node.id}:color`,
            kind: "unbound-color",
            severity: "warning",
            nodeId: node.id,
            nodeName: node.name,
            message: `文字/前景色 ${resolved.style.color} 未绑定，可替换为${match.label}`,
            suggestion: `绑定到${match.label}`,
            fixOperations: !locked && match.fix ? [match.fix] : undefined,
          });
        }
      }

      if (
        (resolved.style.strokeWidth || resolved.style.strokeSides) &&
        resolved.style.strokeVisible !== false &&
        resolved.style.stroke &&
        !node.variableBindings?.stroke
      ) {
        const match = findColorMatch(
          resolved.style.stroke,
          "stroke",
          node,
          modes,
        );
        if (match) {
          issues.push({
            id: `unbound-color:${node.id}:stroke`,
            kind: "unbound-color",
            severity: "warning",
            nodeId: node.id,
            nodeName: node.name,
            message: `描边色 ${resolved.style.stroke} 未绑定，可替换为${match.label}`,
            suggestion: `绑定到${match.label}`,
            fixOperations: !locked && match.fix ? [match.fix] : undefined,
          });
        }
      }
    }

    // 2. Unbound typography
    if (
      node.type === "text" &&
      !node.styleBindings?.text &&
      textStyles.length
    ) {
      const matchedStyle = matchTextStyle(resolved, modes);
      if (matchedStyle) {
        issues.push({
          id: `unbound-typography:${node.id}`,
          kind: "unbound-typography",
          severity: "warning",
          nodeId: node.id,
          nodeName: node.name,
          message: `文本排版匹配本地样式「${matchedStyle.name}」但未绑定`,
          suggestion: `应用文本样式 ${matchedStyle.name}`,
          fixOperations: locked
            ? undefined
            : [applyReusableStyle(node, matchedStyle)],
        });
      }
    }

    // 3. WCAG AA contrast check
    if (
      (node.type === "text" || node.type === "button") &&
      resolved.text.trim().length > 0
    ) {
      const bg = effectiveBackground(doc, node, byId, getBounds);
      const fgAlpha =
        (resolved.style.colorOpacity ?? 1) * (resolved.style.opacity ?? 1);
      const fg = compositeOver(resolved.style.color, fgAlpha, bg);
      const size = resolved.style.fontSize;
      const weight = resolved.style.fontWeight ?? 400;
      const largeText = size >= 24 || (size >= 18.66 && weight >= 700);
      const ratio = contrastRatio(fg, bg);
      const grade = wcagGrade(ratio, largeText);
      if (!grade.aa) {
        issues.push({
          id: `low-contrast:${node.id}`,
          kind: "low-contrast",
          severity: "error",
          nodeId: node.id,
          nodeName: node.name,
          message: `文字对比度 ${ratio.toFixed(2)}:1 未达 WCAG AA 标准（需 ≥ ${largeText ? "3.0" : "4.5"}:1）`,
          detail: `前景色 ${fg} / 背景色 ${bg}`,
          contrast: { ratio, fg, bg, largeText },
        });
      }
    }
  }

  // 4. Generic names when multiple exist
  const genericNodes = targets.filter((n) =>
    GENERIC_NAME_RE.test(n.name.trim()),
  );
  if (genericNodes.length >= 2) {
    for (const node of genericNodes) {
      issues.push({
        id: `generic-name:${node.id}`,
        kind: "generic-name",
        severity: "info",
        nodeId: node.id,
        nodeName: node.name,
        message: `图层使用默认通用名称「${node.name}」，建议重命名为语义化名称`,
      });
    }
  }

  return issues;
}
