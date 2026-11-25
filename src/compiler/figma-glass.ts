import {
  compositeSurface,
  glassEnvironmentFields,
} from "../domain/surface-color";
import type { CSSProperties } from "react";
import type { DesignDocument, DesignNode } from "../domain/document";
import { displayColor } from "../domain/color-profile";
import { resolveNode } from "../domain/design-system";
import { findLayer, childrenOf } from "../domain/scene-index";
import { stableHash } from "../domain/stable-hash";
import type { GlassSample } from "../runtime/FormaRuntime";

const paintVar = (id: string) => "--forma-surface-" + stableHash(id);

// Custom properties keep a sampled backing linked to the paint selected by a
// live theme. Each ancestor supplies its own variable, even inside instances.
export function exposeSurface(node: DesignNode, css: CSSProperties) {
  if (node.style.cornerSmoothingModel === "figma" && css.background)
    Object.assign(css, { [paintVar(node.id)]: css.background });
}

export function sectionGlassBackdrop(doc: DesignDocument, sectionId: string) {
  const surfaces: DesignNode[] = [];
  let section = findLayer(doc, sectionId);
  while (section?.type === "section") {
    surfaces.push(resolveNode(doc, section));
    section = findLayer(doc, section.parentId);
  }
  return glassEnvironmentFields(surfaces.reverse().map(surfacePaint));
}
function surfacePaint(n: DesignNode) {
  return {
    color: n.style.fill,
    alpha: (n.style.fillOpacity ?? 1) * (n.style.opacity ?? 1),
  };
}

function flatSurface(n: DesignNode) {
  const s = n.style;
  return (
    (n.type === "frame" || n.type === "rectangle" || n.type === "section") &&
    (s.fillOpacity ?? 1) > 0 &&
    (s.opacity ?? 1) === 1 &&
    !n.image &&
    !s.gradient &&
    !s.paints?.some((p) => p.visible) &&
    (!s.blendMode || s.blendMode === "pass-through")
  );
}

function glassFloor(node: DesignNode, doc: DesignDocument) {
  let current: DesignNode | undefined = node,
    inner = node,
    anchor: DesignNode | undefined,
    saved: DesignNode | undefined;
  const paints: DesignNode[] = [];
  let paintedAncestor: string | undefined;
  while (current) {
    if (current.style.glassEnvironment) saved = current;
    if (
      current.type === "section" ||
      (current.componentSet && current.type === "group")
    ) {
      if (
        (current.style.fillOpacity ?? 1) > 0 &&
        !current.style.gradient &&
        !current.style.paints?.some((p) => p.visible)
      ) {
        paints.push(resolveNode(doc, current));
        anchor = inner;
        paintedAncestor = current.id;
      }
    }
    inner = current;
    current = findLayer(doc, current.parentId);
  }
  if (!paints.length && !saved) return;
  const environment = paints.length
    ? glassEnvironmentFields(paints.reverse().map(surfacePaint))
    : saved!.style;
  return {
    color: environment.glassEnvironment!,
    sample: environment.glassSampleEnvironment,
    anchor: (anchor ?? saved!).id,
    paintedAncestor,
  };
}
export function sampleGlass(
  node: DesignNode,
  doc: DesignDocument,
  css: CSSProperties,
): GlassSample | undefined {
  const s = node.style,
    g = s.figmaGlass;
  if (!g?.visible) return;
  const floor = glassFloor(node, doc);
  const fallback: GlassSample | undefined = floor
    ? {
        ancestor: floor.anchor,
        paintedAncestor: floor.paintedAncestor,
        environment: floor.color,
        floorOnly: true,
        capturedEnvironment: true,
        source: {},
        face: { display: "none" },
        layer: { display: "none" },
      }
    : undefined;
  if (
    !g?.visible ||
    g.radius ||
    g.chromaticAberration ||
    g.specularIntensity ||
    !g.refractionIntensity ||
    g.refractionIntensity <= 0 ||
    g.refractionIntensity > 4 ||
    !g.refractionRadius ||
    g.refractionRadius <= 0 ||
    g.refractionRadius > 1024 ||
    !g.bevelSize ||
    g.bevelSize <= 0 ||
    g.bevelSize > 64 ||
    !g.density ||
    g.density <= 0 ||
    s.width <= 0 ||
    s.height <= 0 ||
    s.width > 1024 ||
    s.height > 1024 ||
    s.gradient ||
    s.paints?.some((p) => p.visible) ||
    node.image ||
    !s.radius ||
    s.corners ||
    childrenOf(doc, node.id).length
  )
    return fallback;
  const sourceColor = (n: DesignNode) => {
    const c = displayColor(n.style.fill, doc.colorProfile),
      a = n.style.fillOpacity ?? 1;
    return `var(${paintVar(n.id)}, ${a === 1 ? c : `color-mix(in srgb, ${c} ${100 * a}%, transparent)`})`;
  };
  let x = 0,
    y = 0,
    current: DesignNode | undefined = node;
  let plate: GlassSample["source"] | undefined,
    backing = floor?.color ?? "#ffffff",
    sampled = floor?.sample ?? backing,
    ancestor: string | undefined;
  while (current?.parentId) {
    if (current.style.rotation || current.style.flipX || current.style.flipY)
      return fallback;
    x += current.style.x;
    y += current.style.y;
    const raw = findLayer(doc, current.parentId);
    if (!raw) break;
    current = resolveNode(doc, raw);

    if (current.style.fillOpacity === 0 || current.type === "group") continue;
    if (!flatSurface(current)) return fallback;
    if (plate) {
      if (current.type === "section") {
        const paint = sectionGlassBackdrop(doc, current.id);
        backing = paint.glassEnvironment;
        sampled = paint.glassSampleEnvironment ?? backing;
      } else {
        const alpha = current.style.fillOpacity ?? 1;
        backing = compositeSurface(current.style.fill, alpha, backing);
        sampled = compositeSurface(current.style.fill, alpha, sampled);
      }
      break;
    }
    const p = current.style;
    if (p.layout !== "free" || p.rotation || p.corners || !p.width || !p.height)
      return fallback;
    // Interior-only panels have no contrast boundary for this optical pass.
    if (
      x >= p.radius + g.refractionRadius &&
      y >= p.radius + g.refractionRadius &&
      x + s.width <= p.width - p.radius - g.refractionRadius &&
      y + s.height <= p.height - p.radius - g.refractionRadius
    )
      return fallback;
    plate = {
      position: "absolute",
      left: -x,
      top: -y,
      width: p.width,
      height: p.height,
      borderRadius: p.radius,
      background: sourceColor(current),
      filter: `blur(${g.refractionIntensity * g.bevelSize}px)`,
    };
    ancestor = current.id;
  }
  if (!plate || !ancestor) return fallback;
  // A refractive face low-passes the contrasting backing near its boundary.
  // Attenuate this contribution along the bevel; the independent stroke and
  // source reflections then composite over the face at their native coverage.
  const rim = Math.min(g.refractionRadius / 2, s.width / 2, s.height / 2);
  const w = s.width,
    h = s.height;
  const mask = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><defs><filter id="b"><feGaussianBlur stdDeviation="${g.bevelSize}"/></filter></defs><rect x="${rim}" y="${rim}" width="${w - 2 * rim}" height="${h - 2 * rim}" rx="${Math.max(0, Math.min(s.radius, w / 2, h / 2) - rim)}" filter="url(#b)"/></svg>`;
  const face: CSSProperties = {
    position: "absolute",
    inset: 0,
    borderRadius: "inherit",
    background: css.background,
    pointerEvents: "none",
  };
  css.background = "transparent";
  css.overflow = "visible";
  return {
    environment: backing,
    blurSigma: g.refractionIntensity * g.bevelSize,
    capturedEnvironment: !!floor,
    paintedAncestor: floor?.paintedAncestor,
    ancestor,
    source: plate,
    face,
    layer: {
      position: "absolute",
      inset: 0,
      borderRadius: "inherit",
      overflow: "hidden",
      background: sampled,
      opacity:
        1 -
        (1 - Math.min(1, g.refractionIntensity / g.density)) *
          (1 - Math.min(1, Math.max(0, g.opacity ?? 0))),
      maskImage: 'url("data:image/svg+xml,' + encodeURIComponent(mask) + '")',
      maskSize: "100% 100%",
      pointerEvents: "none",
    },
  };
}

// Precompute the same source-only backing for renderers without a browser DOM.
// The selected node can be a child of the source that supplied its ambient color.
export function glassUnderlays(
  doc: DesignDocument,
  bounds: Map<string, { x: number; y: number; width: number; height: number }>,
  root?: string,
) {
  const out = new Map<string, { style: CSSProperties; node: DesignNode }[]>();
  for (const n of doc.nodes) {
    if (!n.style.figmaGlass?.visible) continue;
    const floor = glassFloor(n, doc);
    if (!floor) continue;
    const chain = new Set<string>();
    let item: DesignNode | undefined = n;
    while (item) {
      chain.add(item.id);
      if (item.id === root) break;
      item = findLayer(doc, item.parentId);
    }
    if (root && !chain.has(root)) continue;
    if (
      floor.paintedAncestor &&
      chain.has(floor.paintedAncestor) &&
      findLayer(doc, floor.paintedAncestor)?.type === "section"
    )
      continue;
    const anchor = chain.has(floor.anchor) ? floor.anchor : root;
    const anchorBox = anchor && bounds.get(anchor),
      lens = bounds.get(n.id);
    if (!anchor || !anchorBox || !lens) continue;
    const list = out.get(anchor) ?? [];
    list.push({
      node: n,
      style: {
        position: "absolute",
        pointerEvents: "none",
        left: lens.x - anchorBox.x,
        top: lens.y - anchorBox.y,
        width: lens.width,
        height: lens.height,
        borderRadius: n.style.radius,
        background: floor.color,
      },
    });
    out.set(anchor, list);
  }
  return out;
}
