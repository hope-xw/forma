import { DraftNumberInput } from "./GridTracks";
import { isEditActionEnabled } from "./actions";
import { radialVector } from "../domain/shape-tools";
import { useState } from "react";
import { PenTool, Shapes } from "lucide-react";
import { ColorField } from "./ColorField";
import type { DesignNode } from "../domain/document";
import type { EditorController } from "./useEditor";
import { instanceOwner, isLocked } from "../domain/tree";
export function VectorInspector({
  node,
  editor: e,
}: {
  node: DesignNode;
  editor: EditorController;
}) {
  const [index, setIndex] = useState(0),
    vector = node.vector!;
  const i = Math.min(index, vector.paths.length - 1),
    path = vector.paths[i];
  const previewBlocked = Boolean(
    e.previewRef?.current && e.doc !== e.committed,
  );
  const disabled =
    previewBlocked ||
    !!instanceOwner(e.doc, node.id) ||
    isLocked(e.doc, node.id);
  function change(patch: Partial<typeof path>) {
    if (disabled || e.previewRef?.current) return;
    e.update({
      vector: {
        ...vector,
        paths: vector.paths.map((p, j) => (i === j ? { ...p, ...patch } : p)),
      },
    });
  }
  return (
    <section>
      <div className="section-title">
        矢量路径
        <div className="section-actions">
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="轮廓化描边"
            title="轮廓化描边 ⇧⌘O"
            data-tip="轮廓化描边"
            data-tip-kbd="⇧⌘O"
            data-tip-desc="将描边转为闭合填充的可编辑矢量轮廓"
            data-tip-side="left"
            disabled={
              disabled ||
              !isEditActionEnabled("outlineStroke", e.actionEligibility)
            }
            onClick={() => e.perform("outlineStroke")}
          >
            <Shapes size={14} />
          </button>
          <button
            className="icon-btn icon-btn-sm"
            aria-label="编辑锚点"
            title="编辑锚点 Enter"
            data-tip="编辑矢量锚点"
            data-tip-kbd="Enter"
            data-tip-desc="进入路径节点与贝塞尔手柄编辑模式"
            data-tip-side="left"
            disabled={disabled}
            onClick={() => e.setEditing(node.id)}
          >
            <PenTool size={14} />
          </button>
        </div>
      </div>
      <fieldset className="vector-properties" disabled={disabled}>
        {vector.radial &&
          (
            [
              "points",
              ...(vector.radial.kind === "star" ? ["innerRatio"] : []),
            ] as const
          ).map((key) => {
            const radial = vector.radial!;
            const isRatio = key === "innerRatio";
            const value =
              isRatio && radial.kind === "star"
                ? Math.round(radial.innerRatio * 100)
                : radial.points;
            const label = isRatio
              ? "内半径 %"
              : radial.kind === "star"
                ? "尖角数"
                : "边数";
            return (
              <label key={key}>
                {label}
                <DraftNumberInput
                  aria-label={label}
                  key={node.id + ":" + key + ":" + value}
                  disabled={disabled}
                  min={isRatio ? 1 : 3}
                  max={isRatio ? 99 : 64}
                  step={1}
                  value={value}
                  onCommit={(next) => {
                    if (disabled || e.previewRef?.current) return;
                    const data =
                      isRatio && radial.kind === "star"
                        ? { ...radial, innerRatio: next / 100 }
                        : { ...radial, points: next };
                    e.update({
                      vector: radialVector(
                        data,
                        vector.width,
                        vector.height,
                        vector,
                      ),
                    });
                  }}
                />
              </label>
            );
          })}
        {vector.paths.length > 1 && (
          <select
            aria-label="路径"
            value={i}
            onChange={(ev) => setIndex(Number(ev.target.value))}
          >
            {vector.paths.map((_, j) => (
              <option key={j} value={j}>
                路径 {j + 1}
              </option>
            ))}
          </select>
        )}
        <label>
          <input
            type="checkbox"
            checked={path.fill}
            onChange={(ev) => change({ fill: ev.target.checked })}
          />
          填充路径
        </label>
        {path.fill && (
          <ColorField
            disabled={disabled}
            label="路径填充"
            color={path.fillColor ?? node.style.color}
            alpha={path.fillOpacity ?? 1}
            onChange={(fillColor, fillOpacity) =>
              change({ fillColor, fillOpacity })
            }
          />
        )}
        <label>
          描边宽度
          <DraftNumberInput
            aria-label="路径描边宽度"
            key={node.id + ":" + i + ":" + path.strokeWidth}
            min={0}
            max={100}
            value={path.strokeWidth}
            disabled={disabled}
            onCommit={(strokeWidth) => change({ strokeWidth })}
          />
        </label>
        {!!path.strokeWidth && (
          <ColorField
            disabled={disabled}
            label="路径描边"
            color={path.strokeColor ?? node.style.color}
            alpha={path.strokeOpacity ?? 1}
            onChange={(strokeColor, strokeOpacity) =>
              change({ strokeColor, strokeOpacity })
            }
          />
        )}
        {path.fill && (
          <label>
            填充规则
            <select
              aria-label="填充规则"
              value={path.fillRule ?? "nonzero"}
              onChange={(ev) =>
                change({ fillRule: ev.target.value as typeof path.fillRule })
              }
            >
              <option value="nonzero">非零</option>
              <option value="evenodd">奇偶</option>
            </select>
          </label>
        )}
        {!!path.strokeWidth && (
          <div className="path-ends">
            {(["lineCap", "lineJoin"] as const).map((key) => (
              <div
                key={key}
                role="group"
                aria-label={key === "lineCap" ? "描边端点" : "描边连接"}
              >
                {(key === "lineCap"
                  ? (["butt", "round", "square"] as const)
                  : (["miter", "round", "bevel"] as const)
                ).map((value, index) => {
                  const label = (
                    key === "lineCap"
                      ? ["平端", "圆端", "方端"]
                      : ["尖角连接", "圆角连接", "斜角连接"]
                  )[index];
                  return (
                    <button
                      aria-label={label}
                      data-tip={label}
                      title={label}
                      key={value}
                      aria-pressed={(path[key] ?? "round") === value}
                      onClick={() => change({ [key]: value })}
                    >
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 18 18"
                        aria-hidden="true"
                      >
                        {key === "lineCap" ? (
                          <>
                            <path
                              d="M3 9H12"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="5"
                              strokeLinecap={
                                value as "butt" | "round" | "square"
                              }
                            />
                            <path
                              d="M12 2v14"
                              stroke="currentColor"
                              strokeWidth=".7"
                              opacity=".45"
                            />
                          </>
                        ) : (
                          <path
                            d="M3 14l6-10 6 10"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="3"
                            strokeLinejoin={
                              value as "bevel" | "round" | "miter"
                            }
                          />
                        )}
                      </svg>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </fieldset>
    </section>
  );
}
