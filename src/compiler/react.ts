import type { CSSProperties } from "react";
import { layoutBounds } from "../domain/geometry";
import { strokePaintLayers } from "./stroke-paints";
import {
  exposeSurface,
  sampleGlass,
  glassUnderlays,
  sectionGlassBackdrop,
} from "./figma-glass";
import { separateCapsuleFill } from "./capsule-fill";
import {
  subtractiveFill,
  blendedStroke,
  blendedStrokePaint,
  linearBurnLayer,
} from "./layer-blend";
import {
  solidBlendPaint,
  hasIndependentShadows,
  independentShadows,
} from "./material-composite";
import { flowItemCss } from "./flow-gap";
import { siblingMaskPaint } from "../infrastructure/static-export";
import { symbolPaintForView } from "../domain/symbol-background";
import { tintCss } from "./group-tint";
import { currentTextLayout, currentTextShape } from "../domain/text-shape";
import { vectorPathProps, vectorFillMask } from "../runtime/FormaRuntime";
import { displayNode, displayColor } from "../domain/color-profile";
import { smoothCornerCss, strokeCss, strokeInset } from "../domain/stroke";
import { booleanVector, maskCss } from "../domain/boolean-shapes";
import { resolveNode } from "../domain/design-system";
import { childrenOf, findLayer } from "../domain/scene-index";
import { sizingCss, trackCss, flow } from "../domain/sizing";
import { constraintCss } from "../domain/constraints";
import { nodeInteractions } from "../domain/prototype";
import type { DesignDocument, DesignNode } from "../domain/document";
import {
  rgba as opaqueRgb,
  gradientCss,
  stackPaints,
  backdropSubtraction,
  textInkPaints,
  textSubtraction,
} from "./paints";

// The CSS paint builders take opacity separately from the color channels.
function combinePaintAlpha<T extends { color: string; opacity: number }>(
  paint: T,
): T {
  const { color, opacity } = paint;
  if (color.startsWith("#") && color.length === 9)
    return {
      ...paint,
      color: color.slice(0, 7),
      opacity: opacity * (parseInt(color.slice(7), 16) / 255),
    };
  const separator = color.indexOf(" / ");
  if (separator >= 0 && color.startsWith("color(display-p3 "))
    return {
      ...paint,
      color: color.slice(0, separator) + ")",
      opacity: opacity * Number(color.slice(separator + 3, -1)),
    };
  return paint;
}
export function rgba(color: string, opacity = 1) {
  const paint = combinePaintAlpha({ color, opacity });
  return opaqueRgb(paint.color, paint.opacity);
}
function gradientWithAlpha(
  gradient: NonNullable<DesignNode["style"]["gradient"]>,
) {
  return { ...gradient, stops: gradient.stops.map(combinePaintAlpha) };
}
export function nodeCss(
  node: DesignNode,
  document: DesignDocument,
  view: "canvas" | "export" = "export",
): Record<string, string | number> {
  const resolved = symbolPaintForView(resolveNode(document, node), view);
  const subtract = backdropSubtraction(
    resolved,
    (resolved.fillToken && document.tokens[resolved.fillToken]?.value) ||
      resolved.style.fill,
  );
  const composed = solidBlendPaint(
    resolved,
    (resolved.fillToken && document.tokens[resolved.fillToken]?.value) ||
      resolved.style.fill,
  );
  node = displayNode(resolved, document.colorProfile);
  const s = node.style;
  const intrinsicText = currentTextLayout(node) ?? currentTextShape(node);
  const layerInk = subtractiveFill(node, document);
  const burn = linearBurnLayer(node, document);
  const strokePaint = s.strokePaints?.length || blendedStroke(node, document);
  const rawParent = findLayer(document, node.parentId),
    parent = rawParent && resolveNode(document, rawParent);
  const backdrop = [
    s.backdropBlur && `blur(${s.backdropBlur}px)`,
    s.backdropSaturation !== undefined && `saturate(${s.backdropSaturation})`,
    s.backdropBrightness !== undefined && `brightness(${s.backdropBrightness})`,
    subtract !== undefined &&
      `brightness(${1 / (1 + 2 * subtract)}) contrast(${1 + 2 * subtract})`,
  ]
    .filter(Boolean)
    .join(" ");
  const tint = tintCss(s);
  const layerFilter = [
    tint,
    s.blur && s.blurVisible !== false && `blur(${s.blur}px)`,
  ]
    .filter(Boolean)
    .join(" ");
  const shadows = s.shadows?.filter((effect) => effect.visible !== false);
  const stroke: Record<string, string | number> =
    s.strokeWidth || s.strokeSides
      ? strokeCss(
          s,
          strokePaint
            ? "transparent"
            : s.strokeOpacity !== undefined && s.strokeOpacity !== 1
              ? rgba(s.stroke ?? s.color, s.strokeOpacity)
              : (s.stroke ?? s.color),
          undefined,
          node.type === "ellipse",
        )
      : { border: 0 };
  const centerStroke = stroke["--forma-center-stroke"]
    ? "var(--forma-center-stroke)"
    : "";
  const scroll = nodeInteractions(node).find((r) => r.scroll)?.scroll;
  const inFlow =
    parent?.type === "frame" &&
    parent.style.layout !== "free" &&
    !s.absolutePosition;
  const constraints = constraintCss(node, parent);
  if (parent?.style.layout === "free" && parent.style.strokeSides) {
    for (const horizontal of [true, false]) {
      const start = strokeInset(parent.style, horizontal ? "left" : "top");
      const end = strokeInset(parent.style, horizontal ? "right" : "bottom");
      const axis = horizontal ? "width" : "height",
        pos = horizontal ? "left" : "top";
      const mode = horizontal ? s.constraintX : s.constraintY,
        at = horizontal ? s.x : s.y;
      const basis = parent.style[axis] || 1,
        total = start + end;
      if (mode === "center" || mode === "end" || mode === "scale") {
        const ratio = mode === "center" ? 0.5 : mode === "end" ? 1 : at / basis;
        constraints[pos] =
          `calc(${100 * ratio}% + ${at - ratio * basis + ratio * total - start}px)`;
      }
      if (mode === "stretch")
        constraints[axis] =
          `max(${Math.min(1, s[axis])}px, calc(100% + ${s[axis] - basis + total}px))`;
      if (mode === "scale")
        constraints[axis] =
          `max(${Math.min(1, s[axis])}px, calc(${(100 * s[axis]) / basis}% + ${(total * s[axis]) / basis}px))`;
    }
  }
  const smooth =
    (node.type === "frame" || node.type === "rectangle") &&
    s.cornerSmoothing &&
    !s.layoutBreakpoints?.some((rule) => rule.radius !== undefined)
      ? smoothCornerCss(
          s,
          !!s.viewportWidth ||
            !!constraints.width ||
            !!constraints.height ||
            (!!s.widthMode && s.widthMode !== "fixed") ||
            (!!s.heightMode && s.heightMode !== "fixed"),
          (node.type === "rectangle" || !!s.clipContent || !!layerInk) &&
            !s.strokeWidth &&
            !s.strokeSides &&
            !shadows?.length,
        )
      : {};
  return {
    boxSizing: "border-box",
    ...(parent ? flowItemCss(document, node, parent) : {}),
    ...(s.firstChildOnTop ? { isolation: "isolate" } : {}),
    ...(node.vector || node.booleanOperation
      ? {
          ...(s.strokeDash ? { strokeDasharray: s.strokeDash } : {}),
          ...(s.strokeVisible === false
            ? { "--forma-vector-stroke-width": "0px" }
            : {}),
        }
      : {}),
    ...(node.maskSourceId ? maskCss(document, node) : {}),
    ...(s.rotation || s.flipX || s.flipY
      ? {
          transform: `rotate(${s.rotation ?? 0}deg) scale(${s.flipX ? -1 : 1}, ${s.flipY ? -1 : 1})`,
          transformOrigin: "center",
        }
      : {}),
    width: s.width,
    height: s.height,
    position: !inFlow ? "absolute" : "relative",
    ...(!inFlow
      ? {
          left: s.x - strokeInset(parent?.style, "left"),
          top: s.y - strokeInset(parent?.style, "top"),
        }
      : {}),
    display: node.hidden
      ? "none"
      : node.type === "button" || (node.type === "frame" && s.layout !== "free")
        ? "flex"
        : "block",
    ...(node.type === "button"
      ? { justifyContent: "center", alignItems: "center" }
      : {}),
    ...(s.layout !== "free"
      ? {
          ...(s.layout !== "grid"
            ? {
                flexDirection: s.layoutReverse
                  ? s.layout + "-reverse"
                  : s.layout,
              }
            : {}),
          gap: Math.max(0, s.gap),
        }
      : {}),
    flexShrink: 0,
    ...sizingCss(node, parent),
    ...(s.widthMode === "hug" && intrinsicText ? { width: s.width } : {}),
    ...(s.heightMode === "hug" && intrinsicText ? { height: s.height } : {}),
    ...constraints,
    ...(node.type === "frame" && s.layout !== "free"
      ? {
          justifyContent:
            s.layout !== "grid" && s.justifyContent === "space-between"
              ? "space-between"
              : ((s.layout === "row" ? s.alignX : s.alignY) ?? "start"),
          alignItems: (s.layout === "row" ? s.alignY : s.alignX) ?? "start",
        }
      : {}),
    ...(!node.hidden && flow(node)
      ? trackCss(
          node,
          childrenOf(document, node.id).map((c) =>
            c.variableBindings?.visible ? resolveNode(document, c) : c,
          ),
        )
      : {}),
    [node.vector?.fillFromStyle ? "--forma-vector-fill" : "background"]:
      layerInk ||
      subtract !== undefined ||
      node.type === "text" ||
      node.type === "group" ||
      (node.type === "vector" && !node.vector?.fillFromStyle) ||
      node.type === "slice"
        ? "transparent"
        : composed
          ? rgba(
              displayColor(composed.color, document.colorProfile),
              composed.opacity,
            )
          : stackPaints(
              s.paints?.map((paint) =>
                paint.gradient
                  ? { ...paint, gradient: gradientWithAlpha(paint.gradient) }
                  : combinePaintAlpha(paint),
              ),
              s.gradient
                ? gradientCss(gradientWithAlpha(s.gradient), s.fillOpacity ?? 1)
                : s.fillOpacity !== undefined && s.fillOpacity !== 1
                  ? rgba(
                      node.fillToken
                        ? document.tokens[node.fillToken]
                          ? displayColor(
                              document.tokens[node.fillToken].value,
                              document.colorProfile,
                            )
                          : s.fill
                        : s.fill,
                      s.fillOpacity,
                    )
                  : node.fillToken
                    ? `var(--token-${node.fillToken})`
                    : s.fill,
            ),
    color:
      s.colorOpacity !== undefined && s.colorOpacity !== 1
        ? rgba(s.color, s.colorOpacity)
        : s.color,
    ...(!layerInk &&
    !(strokePaint && !s.strokeBlendMode && s.fillOpacity === 0) &&
    s.blendMode &&
    s.blendMode !== "pass-through" &&
    textSubtraction(node) === undefined
      ? { mixBlendMode: s.blendMode }
      : subtract === undefined &&
          !composed &&
          s.fillBlendMode &&
          !textInkPaints(node) &&
          s.fillBlendMode !== "pass-through"
        ? { mixBlendMode: s.fillBlendMode }
        : {}),
    borderRadius:
      node.type === "ellipse"
        ? "50%"
        : s.corners
          ? [s.corners.tl, s.corners.tr, s.corners.br, s.corners.bl]
              .map((v) => v + "px")
              .join(" ")
          : s.radius,
    ...smooth,
    ...(burn
      ? { clipPath: "none", "--forma-burn-clip": smooth.clipPath ?? "none" }
      : {}),
    fontSize: s.fontSize,
    padding: node.type === "frame" ? s.padding : node.type === "button" ? 8 : 0,
    ...(node.type === "frame" && s.insets
      ? {
          padding: [
            s.insets.top,
            s.insets.right,
            s.insets.bottom,
            s.insets.left,
          ]
            .map((value) => value + "px")
            .join(" "),
        }
      : {}),
    ...stroke,
    ...(s.fontVariationSettings
      ? { fontVariationSettings: s.fontVariationSettings }
      : {}),
    ...(s.fontFeatureSettings
      ? { fontFeatureSettings: s.fontFeatureSettings }
      : {}),
    fontFamily: s.fontFamily ?? "inherit",
    ...(s.fontSmoothing
      ? {
          WebkitFontSmoothing: s.fontSmoothing,
          MozOsxFontSmoothing: "grayscale",
        }
      : {}),
    ...(burn
      ? { opacity: 1 }
      : layerInk
        ? {
            opacity: (s.opacity ?? 1) * (s.fillOpacity ?? 1),
            backdropFilter: layerInk.css,
            WebkitBackdropFilter: layerInk.css,
          }
        : s.opacity !== undefined
          ? { opacity: s.opacity }
          : {}),
    ...(s.fontWeight ? { fontWeight: s.fontWeight } : {}),
    ...(s.lineHeight ? { lineHeight: `${s.lineHeight}px` } : {}),
    ...(s.letterSpacing !== undefined
      ? { letterSpacing: s.letterSpacing }
      : {}),
    ...(s.fontStyle ? { fontStyle: s.fontStyle } : {}),
    ...(node.type === "text" && s.leadingTrim === "cap"
      ? { textBoxTrim: "trim-both", textBoxEdge: "cap alphabetic" }
      : {}),
    ...(s.textDecoration ? { textDecoration: s.textDecoration } : {}),
    ...(s.textTransform ? { textTransform: s.textTransform } : {}),
    ...(node.type === "text" && s.verticalAlign && s.heightMode !== "hug"
      ? {
          ...(node.hidden ? {} : { display: "flex" }),
          flexDirection: "column",
          justifyContent: { top: "start", middle: "center", bottom: "end" }[
            s.verticalAlign
          ],
        }
      : {}),
    ...(node.type === "text" && s.maxLines
      ? {
          ...(node.hidden ? {} : { display: "-webkit-box" }),
          WebkitLineClamp: s.maxLines,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          ...(s.verticalAlign
            ? {
                WebkitBoxPack: {
                  top: "start",
                  middle: "center",
                  bottom: "end",
                }[s.verticalAlign],
              }
            : {}),
        }
      : {}),
    ...(s.textAlign ? { textAlign: s.textAlign } : {}),
    ...(node.type === "text"
      ? {
          fontFamily: s.fontFamily ?? "system-ui, sans-serif",
          fontWeight: s.fontWeight ?? 400,
          lineHeight: s.lineHeight ? s.lineHeight + "px" : 1.4,
          letterSpacing: s.letterSpacing ?? 0,
        }
      : {}),
    ...(s.clipContent ? { overflow: "hidden" } : {}),
    ...(scroll
      ? {
          overflowX: scroll === "vertical" ? "hidden" : "auto",
          overflowY: scroll === "horizontal" ? "hidden" : "auto",
        }
      : {}),
    ...(s.blurVisible === false ? { "--forma-hide-blur": 1 } : {}),
    ...(s.backdropBlurVisible === false ? { "--forma-hide-backdrop": 1 } : {}),
    ...(layerFilter ? { filter: layerFilter } : {}),
    ...(backdrop && s.backdropBlurVisible !== false
      ? node.type === "text" && s.textEffectClip === "glyphs"
        ? { "--forma-text-backdrop": backdrop }
        : {
            backdropFilter: backdrop,
            WebkitBackdropFilter: backdrop,
          }
      : {}),
    ...(!tint &&
    !hasIndependentShadows(node) &&
    (node.type !== "text" || s.textEffectClip !== "glyphs") &&
    shadows?.length
      ? {
          boxShadow: [
            centerStroke,
            ...shadows.map(
              (shadow) =>
                `${shadow.inset ? "inset " : ""}${shadow.x}px ${shadow.y}px ${shadow.blur}px ${shadow.spread}px ${rgba(shadow.color, shadow.opacity)}`,
            ),
          ]
            .filter(Boolean)
            .join(", "),
        }
      : centerStroke
        ? { boxShadow: centerStroke }
        : {}),
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
  };
}
export function exportReact(document: DesignDocument): string {
  const sections = new Map(
    document.nodes.filter((n) => n.type === "section").map((n) => [n.id, n]),
  );
  const compiledNodes: DesignNode[] = [];
  const hasGlass = document.nodes.some((n) => n.style.figmaGlass?.visible);
  for (const raw of document.nodes) {
    if (raw.type === "slice" || raw.type === "section") continue;
    if (raw.parentId && sections.has(raw.parentId)) {
      let dx = 0;
      let dy = 0;
      let hidden = raw.hidden;
      let inheritedModes: DesignNode["variableModes"];
      let current = sections.get(raw.parentId);
      const seen = new Set<string>();
      while (current && !seen.has(current.id)) {
        seen.add(current.id);
        dx += current.style.x;
        dy += current.style.y;
        if (current.hidden) hidden = true;
        if (current.variableModes)
          inheritedModes = { ...current.variableModes, ...inheritedModes };
        current = current.parentId ? sections.get(current.parentId) : undefined;
      }
      compiledNodes.push({
        ...raw,
        ...(inheritedModes
          ? { variableModes: { ...inheritedModes, ...raw.variableModes } }
          : {}),
        parentId: null,
        hidden,
        style: {
          ...raw.style,
          x: raw.style.x + dx,
          y: raw.style.y + dy,
          ...(hasGlass
            ? {
                glassSampleEnvironment: undefined,
                ...sectionGlassBackdrop(document, raw.parentId),
              }
            : {}),
        },
      });
    } else {
      compiledNodes.push(raw);
    }
  }
  const compiledDoc: DesignDocument =
    compiledNodes.length === document.nodes.length
      ? document
      : { ...document, nodes: compiledNodes };

  const floors = hasGlass
    ? glassUnderlays(compiledDoc, layoutBounds(compiledDoc))
    : new Map();
  const render = (node: DesignNode, depth: number): string => {
    node = symbolPaintForView(resolveNode(compiledDoc, node), "export");
    const tag =
      node.type === "button" ? "button" : node.type === "text" ? "p" : "div";
    const style = nodeCss(node, compiledDoc);
    exposeSurface(node, style);
    const glass = sampleGlass(node, compiledDoc, style);
    const optics =
      glass && !glass.floorOnly
        ? `<span aria-hidden="true" style={${JSON.stringify(glass.layer)} as React.CSSProperties}><span style={${JSON.stringify(glass.source)} as React.CSSProperties}/></span><span aria-hidden="true" style={${JSON.stringify(glass.face)} as React.CSSProperties}/>`
        : "";
    const opticalFloor = (floors.get(node.id) ?? [])
      .map(
        ({ style }: { style: CSSProperties }) =>
          `<span aria-hidden="true" style={${JSON.stringify(style)} as React.CSSProperties}/>`,
      )
      .join("");
    const capsule = separateCapsuleFill(node, style);
    const parts: string[] = [];
    let range: string[] = [];
    let mask: ReturnType<typeof siblingMaskPaint>;
    const finishMask = () => {
      if (range.length && mask) {
        const style = {
          position: "absolute",
          inset: 0,
          ...mask.style,
          ...(mask.source
            ? { maskImage: `url(${JSON.stringify(mask.source)})` }
            : {}),
        };
        parts.push(
          `<div style={${JSON.stringify(style)} as React.CSSProperties}>${range.join("\n")}</div>`,
        );
      } else parts.push(...range);
      range = [];
    };
    if (!node.booleanOperation) {
      for (const child of childrenOf(compiledDoc, node.id)) {
        if (child.siblingMask) {
          finishMask();
          mask = siblingMaskPaint(compiledDoc, node, child);
        } else range.push(render(child, depth + 1));
      }
    }
    finishMask();
    const children = parts.join("\n");
    const display = displayNode(node, compiledDoc.colorProfile);
    const drawing = node.booleanOperation
      ? booleanVector(compiledDoc, node)
      : node.type === "vector" && node.vector
        ? display.vector
        : undefined;
    const vectorMask = drawing && vectorFillMask(drawing);
    const maskedFill = vectorMask
      ? `<span aria-hidden="true" style={${JSON.stringify(vectorMask)} as React.CSSProperties}/>`
      : "";
    const vector = drawing
      ? `<svg width="${node.style.width === 0 ? drawing.width : "100%"}" height="${node.style.height === 0 ? drawing.height : "100%"}" viewBox="0 0 ${drawing.width} ${drawing.height}"${drawing.stretch ? ' preserveAspectRatio="none"' : ""}${drawing.overflowVisible ? ' overflow="visible"' : ""} aria-hidden="true">${drawing.paths
          .map((path) => {
            const attributes = Object.entries(
              vectorPathProps(path, drawing.fillFromStyle),
            )
              .filter(([, value]) => value !== undefined)
              .map(([name, value]) => `${name}={${JSON.stringify(value)}}`)
              .join(" ");
            return `<path ${attributes} />`;
          })
          .join("")}</svg>`
      : "";
    const endBreak =
      (!node.text && node.type === "text") || node.text.endsWith("\n");
    const label = node.text ? `{${JSON.stringify(node.text)}}` : "";
    const glyphs = currentTextShape(node);
    const layout = currentTextLayout(node);
    const content = layout
      ? `<span style={{opacity:0}}>${label}</span><svg aria-hidden="true" width={${layout.width}} height={${layout.height}} style={{position:"absolute",top:0,left:0,overflow:"visible",pointerEvents:"none"}}>${layout.lines.map((line) => `<text fill="currentColor" style={{whiteSpace:"pre",letterSpacing:0}}>${[...line.text].map((c, i) => `<tspan x={${line.x[i]}} y={${line.y}}>{${JSON.stringify(c)}}</tspan>`).join("")}</text>`).join("")}</svg>`
      : glyphs
        ? `<span style={{opacity:0}}>${label}</span><svg aria-hidden="true" width={${glyphs.width}} height={${glyphs.height}} viewBox="0 0 ${glyphs.width} ${glyphs.height}" style={{position:"absolute",top:0,left:0,overflow:"visible",pointerEvents:"none"}}><path d={${JSON.stringify(glyphs.d)}} fill="currentColor" /></svg>`
        : endBreak
          ? `<span>${label}<br /></span>`
          : label;
    const burn = linearBurnLayer(display, compiledDoc);
    const blend = !burn && blendedStrokePaint(display, compiledDoc);
    const burnMarkup = burn
      ? `{(typeof CSS!=="undefined"&&CSS.supports("mix-blend-mode","plus-darker")?[${JSON.stringify(burn.native)}]:${JSON.stringify(burn.layers)}).map((p,i)=><span aria-hidden="true" key={i} style={{...${JSON.stringify(burn.shape)},...p} as React.CSSProperties}/>) }`
      : "";

    const shadows = [
      ...(capsule ? [capsule] : []),
      ...(blend || []),
      ...(strokePaintLayers(display) ?? []),
      ...(independentShadows(display) ?? []),
    ]
      .map(
        (shadow) =>
          `<span aria-hidden="true" style={${JSON.stringify(shadow)} as React.CSSProperties}/>`,
      )
      .join("");
    return `${"  ".repeat(depth)}<${tag} data-design-id={${JSON.stringify(node.id)}} style={${JSON.stringify({ margin: 0, ...style })} as React.CSSProperties}>${opticalFloor}${optics}${burnMarkup}${shadows}${maskedFill}${vector}${content}${children ? "\n" + children + "\n" + "  ".repeat(depth) : ""}</${tag}>`;
  };
  const tokens = Object.fromEntries(
    Object.entries(compiledDoc.tokens).map(([id, token]) => [
      `--token-${id}`,
      displayColor(token.value, compiledDoc.colorProfile),
    ]),
  );
  return `import type * as React from 'react';\n\n// Generated from document ${JSON.stringify(compiledDoc.id)}, revision ${compiledDoc.revision}.\n// This milestone exports static layout only; prototype runtime is not yet implemented.\nexport default function DesignPage() {\n  return <main style={${JSON.stringify({ ...tokens, position: "relative", minHeight: Math.max(800, ...compiledDoc.nodes.filter((n) => !n.parentId).map((n) => n.style.y + n.style.height)), fontFamily: "system-ui, sans-serif" })} as React.CSSProperties}>\n${compiledDoc.nodes
    .filter((n) => !n.parentId)
    .map((n) => render(n, 2))
    .join("\n")}\n  </main>;\n}\n`;
}
