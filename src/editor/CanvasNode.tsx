import { strokePaintLayers } from "../compiler/stroke-paints";
import { exposeSurface, sampleGlass } from "../compiler/figma-glass";
import { separateCapsuleFill } from "../compiler/capsule-fill";
import { blendedStrokePaint, linearBurnLayer } from "../compiler/layer-blend";
import { siblingMaskPaint } from "../infrastructure/static-export";
import { maskSiblings } from "../runtime/FormaRuntime";
import { independentShadows } from "../compiler/material-composite";
import { symbolPaintForView } from "../domain/symbol-background";
import { textInkPaints } from "../compiler/paints";
import { currentTextLayout, currentTextShape } from "../domain/text-shape";
import { InlineText } from "./InlineText";
import { imagePaint } from "../domain/images";
import { displayNode } from "../domain/color-profile";
import { resolveNode } from "../domain/design-system";
import { childrenOf, unchangedBranch } from "../domain/scene-index";
import { memo, type CSSProperties } from "react";
import { Scissors } from "lucide-react";
import { nodeCss } from "../compiler/react";
import { rgba } from "../compiler/paints";
import { gridBreakpoint } from "../domain/sizing";
import {
  BoxShadows,
  CapsulePaint,
  LinearBurn,
  GlassFace,
  ImagePaint,
  LayerText,
  separateImageOverlay,
  useContainerLayout,
  vectorPathProps,
  VectorPaint,
} from "../runtime/FormaRuntime";
import { textParts } from "../domain/rich-text";
import { booleanVector } from "../domain/boolean-shapes";
import { ancestors } from "../domain/tree";
import type {
  DesignDocument,
  DesignNode,
  LayoutGuide,
} from "../domain/document";
interface Props {
  node: DesignNode;
  document: DesignDocument;
  selection: string[];
  editing: string | null;
  showLayoutGuides?: boolean;
  outlineMode?: boolean;
  aiPreviewNodeIds?: ReadonlySet<string>;
}
const branches = new WeakMap<
  string[],
  { doc: DesignDocument; ids: Set<string> }
>();
function selectedBranches(p: Props) {
  const cached = branches.get(p.selection);
  if (cached?.doc === p.document) return cached.ids;
  const ids = new Set<string>();
  for (const id of p.selection) {
    ids.add(id);
    for (const parent of ancestors(p.document, id)) ids.add(parent.id);
  }
  branches.set(p.selection, { doc: p.document, ids });
  return ids;
}
function LayoutGuideOverlay({ guides }: { guides: LayoutGuide[] }) {
  const active = guides.filter((g) => g.visible !== false);
  if (!active.length) return null;
  return (
    <div
      aria-hidden="true"
      className="layout-guides-overlay"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        overflow: "hidden",
        borderRadius: "inherit",
        zIndex: 1,
      }}
    >
      {active.map((g) => {
        const fill = rgba(g.color, g.opacity);
        if (g.kind === "grid") {
          const step = Math.max(2, g.size);
          return (
            <div
              key={g.id}
              style={{
                position: "absolute",
                inset: 0,
                backgroundImage: `linear-gradient(to right, ${fill} 1px, transparent 1px), linear-gradient(to bottom, ${fill} 1px, transparent 1px)`,
                backgroundSize: `${step}px ${step}px`,
              }}
            />
          );
        }
        const isCols = g.kind === "columns";
        const count = Math.max(1, Math.min(64, Math.round(g.count)));
        const justify =
          g.alignment === "min"
            ? "flex-start"
            : g.alignment === "max"
              ? "flex-end"
              : g.alignment === "center"
                ? "center"
                : "stretch";
        return (
          <div
            key={g.id}
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: isCols ? "row" : "column",
              justifyContent: justify,
              gap: g.gutter,
              padding:
                g.alignment === "stretch"
                  ? isCols
                    ? `0 ${g.offset}px`
                    : `${g.offset}px 0`
                  : g.alignment === "min"
                    ? isCols
                      ? `0 0 0 ${g.offset}px`
                      : `${g.offset}px 0 0 0`
                    : g.alignment === "max"
                      ? isCols
                        ? `0 ${g.offset}px 0 0`
                        : `0 0 ${g.offset}px 0`
                      : 0,
            }}
          >
            {Array.from({ length: count }).map((_, idx) => (
              <div
                key={idx}
                style={{
                  background: fill,
                  ...(g.alignment === "stretch"
                    ? { flex: 1 }
                    : isCols
                      ? { width: Math.max(1, g.size), flexShrink: 0 }
                      : { height: Math.max(1, g.size), flexShrink: 0 }),
                }}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
export const CanvasNode = memo(
  function CanvasNodeView({
    node,
    document,
    selection,
    editing,
    showLayoutGuides = true,
    outlineMode = false,
    aiPreviewNodeIds,
  }: Props) {
    const resolved = symbolPaintForView(resolveNode(document, node), "canvas");
    node = displayNode(resolved, document.colorProfile);
    const layout = useContainerLayout(
      node.hidden ? undefined : gridBreakpoint(node),
    );
    if (node.hidden) return null;
    const vector = node.booleanOperation
      ? booleanVector(document, node)
      : node.vector;

    const inspectOperands =
      !!node.booleanOperation &&
      selection.some((id) =>
        ancestors(document, id).some((p) => p.id === node.id),
      );
    const directChildren = childrenOf(document, node.id).filter(
      (n) => n.id !== node.maskSourceId,
    );
    const children = maskSiblings(
      directChildren.map((child) => ({
        id: child.id,
        mask:
          !outlineMode && editing !== child.id
            ? siblingMaskPaint(document, resolved, child)
            : undefined,
        content: (
          <CanvasNode
            key={child.id}
            {...{
              document,
              selection,
              editing,
              showLayoutGuides,
              outlineMode,
              aiPreviewNodeIds,
            }}
            node={child}
          />
        ),
      })),
    );
    const style = nodeCss(resolved, document, "canvas") as CSSProperties;
    exposeSurface(node, style);
    const glass = !outlineMode && sampleGlass(node, document, style);
    const burn = !outlineMode && linearBurnLayer(node, document);
    const boxPaint =
      !outlineMode && !burn && blendedStrokePaint(node, document);
    const capsule =
      !outlineMode && !burn && !boxPaint && separateCapsuleFill(node, style);
    const editingText =
      editing === node.id && (node.type === "text" || node.type === "button");
    const overlay = node.image ? separateImageOverlay(style) : undefined;
    const isAiPreview = Boolean(aiPreviewNodeIds?.has(node.id));
    const isSection = node.type === "section";
    const isSlice = node.type === "slice";
    const appliedStyle: CSSProperties = {
      margin: 0,
      ...layout.apply(style),
      ...(isSlice
        ? {
            background: "rgba(13, 153, 255, 0.04)",
            border: "1.5px dashed #0d99ff",
            boxSizing: "border-box",
          }
        : {}),
      ...(isSection && !resolved.style.strokeWidth
        ? {
            border: "1px solid rgba(82, 88, 102, 0.45)",
            boxSizing: "border-box",
          }
        : {}),
      ...(outlineMode
        ? {
            background: "transparent",
            backgroundImage: "none",
            boxShadow: "none",
            outline: "1px solid rgba(13, 153, 255, 0.6)",
            outlineOffset: -1,
          }
        : {}),
      ...(isAiPreview
        ? {
            outline: "2px dashed #9747ff",
            outlineOffset: 2,
          }
        : {}),
    };
    return (
      <div
        ref={layout.ref}
        data-node-id={node.id}
        data-node-type={node.type}
        data-editing-text={editingText || undefined}
        data-component-set={node.componentSet ? node.name : undefined}
        className={`design-node ${selection.includes(node.id) ? "selected" : ""} ${node.type === "button" ? "design-button" : ""} ${isAiPreview ? "is-ai-preview" : ""}`}
        style={appliedStyle}
      >
        {isSection && (
          <div
            aria-hidden="true"
            className="section-title-pill"
            style={{
              position: "absolute",
              left: 0,
              top: -28,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "3px 8px",
              borderRadius: 6,
              background: selection.includes(node.id)
                ? "#0d99ff"
                : "rgba(44, 47, 54, 0.9)",
              color: "#ffffff",
              fontSize: 11,
              fontWeight: 600,
              lineHeight: 1.2,
              whiteSpace: "nowrap",
              pointerEvents: "none",
              boxShadow: "0 1px 4px rgba(0,0,0,0.18)",
            }}
          >
            <span>{node.name}</span>
            {(node.devStatus === "ready" || node.devStatus === "completed") && (
              <span
                style={{
                  padding: "1px 5px",
                  borderRadius: 4,
                  fontSize: 9,
                  fontWeight: 700,
                  background: "#14ae5c",
                  color: "#ffffff",
                }}
              >
                {node.devStatus === "completed" ? "Completed" : "Ready for dev"}
              </span>
            )}
          </div>
        )}
        {isSlice && (
          <div
            aria-hidden="true"
            className="slice-badge-pill"
            style={{
              position: "absolute",
              left: 0,
              top: -22,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 6px",
              borderRadius: 4,
              background: "#0d99ff",
              color: "#ffffff",
              fontSize: 10,
              fontWeight: 600,
              lineHeight: 1.2,
              whiteSpace: "nowrap",
              pointerEvents: "none",
            }}
          >
            <Scissors size={10} />
            <span>{node.name}</span>
          </div>
        )}
        {node.image && !outlineMode && (
          <ImagePaint
            paint={imagePaint(
              node.image,
              document.images?.[node.image.assetId],
            )}
            source={document.images?.[node.image.assetId]?.data}
            overlay={overlay}
          />
        )}
        {glass && <GlassFace sample={glass} />}
        {burn && <LinearBurn paint={burn} />}
        {boxPaint && <BoxShadows layers={boxPaint} />}
        {capsule && <CapsulePaint capsule={capsule} />}
        {!outlineMode && <BoxShadows layers={strokePaintLayers(node)} />}
        {!outlineMode && <BoxShadows layers={independentShadows(node)} />}
        {!outlineMode && editing !== node.id && vector?.fillFromStyle && (
          <VectorPaint vector={vector} />
        )}
        {vector && (
          <svg
            width={node.style.width === 0 ? vector.width : "100%"}
            height={node.style.height === 0 ? vector.height : "100%"}
            preserveAspectRatio={vector.stretch ? "none" : undefined}
            viewBox={`0 0 ${vector.width} ${vector.height}`}
            overflow={vector.overflowVisible ? "visible" : undefined}
            aria-hidden="true"
            style={{
              display: "block",
              pointerEvents: "none",
              visibility: editing === node.id ? "hidden" : undefined,
            }}
          >
            {vector.paths.map((path, index) => (
              <path
                key={index}
                {...vectorPathProps(path, vector.fillFromStyle)}
                {...(outlineMode
                  ? {
                      fill: "none",
                      stroke: "#0d99ff",
                      strokeWidth: Math.max(1, path.strokeWidth || 1),
                    }
                  : {})}
              />
            ))}
          </svg>
        )}
        {editingText ? (
          <InlineText node={resolved} />
        ) : (
          (node.type === "text" || node.text) && (
            <LayerText
              text={node.text}
              inkPaints={textInkPaints(resolved)}
              inkShadows={
                node.type === "text" &&
                resolved.style.textEffectClip === "glyphs" &&
                !resolved.style.tint
                  ? resolved.style.shadows?.filter((s) => s.visible !== false)
                  : undefined
              }
              backdrop={
                (style as Record<string, string>)["--forma-text-backdrop"]
              }
              sourceTextLayout={currentTextLayout(resolved)}
              sourceTextShape={currentTextShape(resolved)}
              parts={node.textRuns?.length ? textParts(node) : undefined}
              style={{
                pointerEvents: "none",
                ...(node.style.leadingTrim === "cap"
                  ? {
                      display: "block",
                      textBoxTrim: "trim-both",
                      textBoxEdge: "cap alphabetic",
                    }
                  : {}),
              }}
            />
          )
        )}
        {node.booleanOperation
          ? inspectOperands && (
              <div style={{ position: "absolute", inset: 0, opacity: 0.35 }}>
                {children}
              </div>
            )
          : children}
        {showLayoutGuides &&
          (node.type === "frame" || node.type === "section") &&
          resolved.style.layoutGuides &&
          resolved.style.layoutGuides.length > 0 && (
            <LayoutGuideOverlay guides={resolved.style.layoutGuides} />
          )}
      </div>
    );
  },
  (before, after) => {
    if (
      before.node !== after.node ||
      !unchangedBranch(before.document, after.document, after.node.id) ||
      before.editing !== after.editing ||
      before.showLayoutGuides !== after.showLayoutGuides ||
      before.outlineMode !== after.outlineMode ||
      before.aiPreviewNodeIds !== after.aiPreviewNodeIds
    )
      return false;
    return (
      before.selection === after.selection ||
      (!selectedBranches(before).has(after.node.id) &&
        !selectedBranches(after).has(after.node.id))
    );
  },
);
