import type { ReactNode } from "react";
import { ArrowUp, ArrowDown, Eye, EyeOff, Minus, Plus } from "lucide-react";
import type { DesignSystem } from "../domain/design-system-schema";
import type { NodeStyle } from "../domain/document";
import { blendModes } from "../domain/node";
import { ColorField } from "./ColorField";
import { GradientControls } from "./GradientEditor";
type Paint = NonNullable<NodeStyle["paints"]>[number];
export function PaintStack({
  layers = [],
  kind = "fill",
  hideHeader = false,
  system,
  disabled: locked = false,
  previewBlocked = false,
  palette,
  update: write,
  cancelPreview,
  headerActions,
}: {
  layers?: Paint[];
  kind?: "fill" | "stroke";
  hideHeader?: boolean;
  system?: DesignSystem;
  disabled?: boolean;
  previewBlocked?: boolean;
  palette?: string[] | (() => string[]);
  update(paints: Paint[], preview?: boolean): void;
  cancelPreview?(): void;
  headerActions?: ReactNode;
}) {
  const disabled = locked || previewBlocked;
  const update = (paints: Paint[], preview = false) => {
    if (!disabled) write(paints, preview);
  };
  const label = kind === "stroke" ? "描边" : "填充";
  const change = (index: number, patch: Partial<Paint>, preview = false) =>
    update(
      layers.map((p, i) =>
        i === index
          ? {
              ...p,
              ...(patch.color !== undefined && { colorVariableId: undefined }),
              ...(patch.opacity !== undefined && {
                opacityVariableId: undefined,
              }),
              ...patch,
            }
          : p,
      ),
      preview,
    );
  const move = (index: number, direction: number) => {
    const reordered = layers.slice();
    reordered.splice(index + direction, 0, ...reordered.splice(index, 1));
    update(reordered);
  };
  return (
    <div className="stack-editor">
      {!hideHeader && (
        <div className="section-title">
          <span>{label}</span>
          <div className="section-actions">
            {headerActions}
            <button
              className="icon-btn icon-btn-sm"
              title={`添加${label}层`}
              aria-label={`添加${label}层`}
              data-tip={`添加${label}层`}
              data-tip-desc={`添加纯色或渐变${label}（最多 16 层）`}
              data-tip-side="left"
              disabled={disabled || layers.length >= 16}
              onClick={() =>
                update([
                  {
                    id: crypto.randomUUID(),
                    color: "#000000",
                    opacity: 0.16,
                    visible: true,
                  },
                  ...layers,
                ])
              }
            >
              <Plus size={14} />
            </button>
          </div>
        </div>
      )}
      {layers.map((paint, index) => (
        <div key={paint.id} className="paint-layer">
          <ColorField
            label={`${label}层 ${index + 1}`}
            color={paint.color}
            alpha={paint.opacity}
            disabled={disabled}
            palette={palette}
            onCancelPreview={disabled ? undefined : cancelPreview}
            onPreview={
              cancelPreview
                ? (color, opacity, channel) =>
                    change(
                      index,
                      channel === "alpha" ? { opacity } : { color },
                      true,
                    )
                : undefined
            }
            onChange={(color, opacity, channel) =>
              change(index, {
                ...(channel !== "alpha" && { color }),
                ...(channel !== "color" && { opacity }),
              })
            }
          />
          <div className="paint-layer-actions">
            <button
              className="icon-btn icon-btn-sm"
              title={`上移${label}`}
              aria-label={`上移${label}`}
              data-tip={`上移${label}`}
              disabled={disabled || !index}
              onClick={() => move(index, -1)}
            >
              <ArrowUp size={13} />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              title={`下移${label}`}
              aria-label={`下移${label}`}
              data-tip={`下移${label}`}
              disabled={disabled || index === layers.length - 1}
              onClick={() => move(index, 1)}
            >
              <ArrowDown size={13} />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              title={`切换${label}可见性`}
              aria-label={`切换${label}可见性`}
              data-tip={`切换${label}可见性`}
              disabled={disabled}
              aria-pressed={paint.visible}
              onClick={() => change(index, { visible: !paint.visible })}
            >
              {paint.visible ? <Eye size={13} /> : <EyeOff size={13} />}
            </button>
            <button
              className="icon-btn icon-btn-sm"
              title={`删除${label}层`}
              aria-label={`删除${label}层`}
              data-tip={`删除${label}层`}
              disabled={disabled}
              onClick={() => update(layers.filter((_, i) => index !== i))}
            >
              <Minus size={13} />
            </button>
          </div>
          <details>
            <summary>
              {paint.gradient
                ? {
                    linear: "线性渐变",
                    radial: "径向渐变",
                    angular: "角度渐变",
                    diamond: "菱形渐变",
                  }[paint.gradient.type]
                : "纯色"}
            </summary>
            <select
              aria-label={`${label}层 ${index + 1} 混合模式`}
              disabled={disabled}
              value={paint.blendMode ?? "normal"}
              onChange={(ev) =>
                change(index, {
                  blendMode:
                    ev.target.value === "normal"
                      ? undefined
                      : (ev.target.value as Paint["blendMode"]),
                })
              }
            >
              {blendModes
                .filter((m) => m !== "pass-through")
                .map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
            </select>
            {system && kind === "stroke" && (
              <>
                {(["color", "opacity"] as const).map((channel) => {
                  const prop =
                    channel === "color"
                      ? "colorVariableId"
                      : "opacityVariableId";
                  const title = channel === "color" ? "颜色变量" : "透明度变量";
                  const allowed = Object.values(system.variables).filter(
                    (v) =>
                      v.type === (channel === "color" ? "color" : "number") &&
                      (!v.scopes.length ||
                        v.scopes.includes(
                          channel === "color" ? "stroke" : "strokeOpacity",
                        ) ||
                        v.id === paint[prop]),
                  );
                  return (
                    <label key={prop}>
                      {title}
                      <select
                        aria-label={`${label}层 ${index + 1} ${title}`}
                        disabled={disabled}
                        value={paint[prop] ?? ""}
                        onChange={(e) =>
                          change(index, { [prop]: e.target.value || undefined })
                        }
                      >
                        <option value="">未绑定</option>
                        {allowed.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                })}
              </>
            )}
            <GradientControls
              system={system}
              disabled={disabled}
              color={paint.color}
              gradient={paint.gradient}
              cancelPreview={disabled ? undefined : cancelPreview}
              update={(gradient, preview) =>
                change(index, { gradient }, preview)
              }
            />
          </details>
        </div>
      ))}
    </div>
  );
}
