import { maxGradientStops } from "../domain/document-limits";
import { previewGeometry } from "../application/geometry-preview";
import { useContext } from "react";
import { displayColor } from "../domain/color-profile";
import { FileColorContext } from "./ColorProfileDialog";
import type { DesignSystem } from "../domain/design-system-schema";
import type { NodeStyle } from "../domain/document";
import { gradientCss } from "../compiler/paints";
import { resolveNode } from "../domain/design-system";
import { isLocked } from "../domain/tree";
import type { EditorController } from "./useEditor";
import { ColorField } from "./ColorField";
export function GradientEditor({
  editor: e,
  placement = "inline",
}: {
  editor: EditorController;
  placement?: "inline" | "header" | "body";
}) {
  const nodes = e.selected.map((n) => resolveNode(e.doc, n));
  if (
    !nodes.length ||
    nodes.some(
      (n) =>
        !n.vector?.fillFromStyle &&
        ["text", "vector", "group", "slice"].includes(n.type),
    )
  )
    return null;
  const locked = nodes.some((n) => isLocked(e.doc, n.id));
  return (
    <GradientControls
      system={e.doc.designSystem}
      disabled={locked}
      placement={placement}
      color={nodes[0].style.fill}
      gradient={nodes[0].style.gradient}
      selection={nodes.map((n) => n.style.gradient)}
      cancelPreview={() => e.setPreview(null)}
      apply={(change, preview) =>
        e.attempt(() => {
          const operations = nodes.map((n) => ({
            type: "update" as const,
            id: n.id,
            patch: {},
            style: { gradient: change(n.style.gradient, n.style.fill) },
          }));
          if (preview) e.setPreview(previewGeometry(e.committed, operations));
          else e.apply(operations);
        })
      }
    />
  );
}
type Gradient = NodeStyle["gradient"];
type GradientKind = NonNullable<Gradient>["type"];
type Edit = (value: Gradient, color: string) => Gradient;
export function GradientControls({
  gradient,
  system,
  disabled = false,
  placement = "inline",
  update,
  apply,
  cancelPreview,
  selection,
  color,
}: {
  gradient: NodeStyle["gradient"];
  system?: DesignSystem;
  disabled?: boolean;
  placement?: "inline" | "header" | "body";
  update?(value: Gradient, preview?: boolean): void;
  apply?(change: Edit, preview?: boolean): void;
  cancelPreview?(): void;
  selection?: Gradient[];
  color: string;
}) {
  const profile = useContext(FileColorContext);
  const edit = (change: Edit, preview = false) =>
    apply ? apply(change, preview) : update!(change(gradient, color), preview);
  const all = selection ?? [gradient];
  const common = <T,>(get: (g: Gradient) => T) =>
    all.every((g) => get(g) === get(gradient)) ? get(gradient) : undefined;
  const kind = common((g) => g?.type ?? "solid");
  const sharedStops = Math.min(...all.map((g) => g?.stops.length ?? 0));
  type Stop = NonNullable<Gradient>["stops"][number];
  const editStop = (index: number, patch: Partial<Stop>, preview = false) =>
    edit(
      (g) =>
        g && {
          ...g,
          stops: g.stops.map((s, i) => (i === index ? { ...s, ...patch } : s)),
        },
      preview,
    );
  const typeSelect = (
    <select
      className={placement === "header" ? "header-ghost-select" : undefined}
      aria-label="填充类型"
      title="填充类型"
      disabled={disabled}
      value={kind ?? ""}
      onChange={(ev) =>
        edit((g, baseColor) =>
          ev.target.value === "solid"
            ? undefined
            : {
                type: ev.target.value as GradientKind,
                angle: g?.angle ?? 135,
                stops: g?.stops ?? [
                  { offset: 0, color: baseColor, opacity: 1 },
                  { offset: 1, color: "#9383ff", opacity: 1 },
                ],
              },
        )
      }
    >
      <option value="" hidden>
        Mixed
      </option>
      <option value="solid">纯色</option>
      <option value="linear">线性渐变</option>
      <option value="radial">径向渐变</option>
      <option value="angular">角度渐变</option>
      <option value="diamond">菱形渐变</option>
    </select>
  );
  if (placement === "header") return typeSelect;
  if (placement === "body" && (!kind || !gradient)) return null;
  return (
    <fieldset
      className="gradient-editor"
      disabled={disabled}
      style={{ border: 0, padding: 0, margin: 0 }}
    >
      {placement === "inline" && (
        <label className="mode-row">
          <span>类型</span>
          {typeSelect}
        </label>
      )}
      {kind && gradient && (
        <>
          <div
            className="gradient-preview"
            style={{
              background: gradientCss(
                {
                  ...gradient,
                  stops: gradient.stops.map((stop) => ({
                    ...stop,
                    color: displayColor(stop.color, profile),
                  })),
                },
                1,
              ),
            }}
          />
          {(gradient.type === "linear" || gradient.type === "angular") && (
            <label className="mode-row">
              <span>角度</span>
              <input
                type="number"
                aria-label="渐变角度"
                min="0"
                max="360"
                placeholder="Mixed"
                value={common((g) => g?.angle) ?? ""}
                onChange={(ev) => {
                  const angle = Number(ev.target.value);
                  if (angle >= 0 && angle <= 360)
                    edit(
                      (g) =>
                        g && {
                          ...g,
                          angle,
                          linearProjection: undefined,
                          paintTransform: undefined,
                        },
                    );
                }}
              />
            </label>
          )}
          {gradient.stops.slice(0, sharedStops).map((stop, index) => (
            <div className="gradient-stop-row" key={index}>
              <ColorField
                label={`色标 ${index + 1}`}
                color={stop.color}
                alpha={stop.opacity}
                mixedColor={common((g) => g?.stops[index].color) === undefined}
                mixedAlpha={
                  common((g) => g?.stops[index].opacity) === undefined
                }
                onCancelPreview={cancelPreview}
                onPreview={
                  cancelPreview
                    ? (color, opacity, channel) =>
                        editStop(
                          index,
                          channel === "alpha"
                            ? { opacity }
                            : { color, variableId: undefined },
                          true,
                        )
                    : undefined
                }
                onChange={(color, opacity, channel) =>
                  editStop(index, {
                    ...(channel !== "alpha" && {
                      color,
                      variableId: undefined,
                    }),
                    ...(channel !== "color" && { opacity }),
                  })
                }
              />
              {system && (
                <select
                  className="gradient-variable"
                  aria-label={`色标 ${index + 1} 颜色变量`}
                  title="色标颜色变量"
                  value={
                    common((g) => g?.stops[index].variableId ?? "") ?? "mixed"
                  }
                  onChange={(event) => {
                    const variableId = event.target.value || undefined;
                    editStop(index, { variableId });
                  }}
                >
                  <option value="mixed" hidden>
                    Mixed
                  </option>
                  <option value="">直接颜色</option>
                  {Object.values(system.variables)
                    .filter(
                      (v) =>
                        v.type === "color" &&
                        (!v.scopes.length || v.scopes.includes("fill")),
                    )
                    .map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                </select>
              )}
              <input
                type="number"
                aria-label={`色标 ${index + 1} 位置`}
                title="位置 %"
                min="0"
                max="100"
                placeholder="Mixed"
                value={
                  common((g) => Math.round(g!.stops[index].offset * 100)) ?? ""
                }
                onChange={(ev) => {
                  const value = Number(ev.target.value);
                  if (value >= 0 && value <= 100)
                    editStop(index, { offset: value / 100 });
                }}
              />
              <button
                title="删除色标"
                aria-label={`删除色标 ${index + 1}`}
                data-tip="删除色标"
                disabled={sharedStops <= 2}
                onClick={() =>
                  edit(
                    (g) =>
                      g && {
                        ...g,
                        stops: g.stops.filter((_, i) => i !== index),
                      },
                  )
                }
              >
                −
              </button>
            </div>
          ))}
          <button
            className="wide"
            disabled={all.some((g) => g!.stops.length >= maxGradientStops)}
            onClick={() =>
              edit(
                (g, baseColor) =>
                  g && {
                    ...g,
                    stops: [
                      ...g.stops,
                      { offset: 0.5, color: baseColor, opacity: 1 },
                    ],
                  },
              )
            }
          >
            + 色标
          </button>
        </>
      )}
    </fieldset>
  );
}
