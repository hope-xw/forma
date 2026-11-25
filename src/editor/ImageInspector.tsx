import { useRef, useState } from "react";
import {
  ChevronRight,
  Crop,
  ImagePlus,
  RotateCcw,
  RotateCw,
  Trash2,
} from "lucide-react";
import type { EditorController } from "./useEditor";
import type { DesignNode } from "../domain/document";
import { isLocked } from "../domain/tree";
import { readImage } from "../infrastructure/image-import";
export function ImageFillTrigger({
  editor: e,
  node,
}: {
  editor: EditorController;
  node: DesignNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const locked = isLocked(e.doc, node.id);
  const hasImage = Boolean(node.image && e.doc.images?.[node.image.assetId]);
  return (
    <>
      <button
        type="button"
        className={`icon-btn icon-btn-sm ${hasImage ? "active" : ""}`}
        disabled={locked}
        title={hasImage ? "更换图像填充" : "添加图像填充"}
        aria-label="选择图像"
        data-tip={hasImage ? "更换图像填充" : "添加图像填充"}
        data-tip-desc="上传 PNG / JPG / WebP 作为图层图像填充"
        data-tip-side="left"
        onClick={() => input.current?.click()}
      >
        <ImagePlus size={13} />
      </button>
      <input
        ref={input}
        type="file"
        hidden
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={async (ev) => {
          const file = ev.target.files?.[0];
          ev.target.value = "";
          if (!file) return;
          const docId = e.committed.id;
          try {
            const { id, image } = await readImage(file);
            if (e.historyRef.current.present.id !== docId)
              throw new Error("文件已切换");
            e.apply([
              { type: "putImage", id, image },
              {
                type: "update",
                id: node.id,
                patch: {
                  image: { assetId: id, fit: "cover", zoom: 1, x: 50, y: 50 },
                },
              },
            ]);
          } catch (err) {
            e.setError(err instanceof Error ? err.message : String(err));
          }
        }}
      />
    </>
  );
}

export function ImageInspector({
  editor: e,
  node,
  hideWhenEmpty = false,
}: {
  editor: EditorController;
  node: DesignNode;
  hideWhenEmpty?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const fill = node.image,
    asset = fill && e.doc.images?.[fill.assetId];
  if (hideWhenEmpty && (!fill || !asset)) return null;
  return (
    <fieldset className="image-inspector" disabled={isLocked(e.doc, node.id)}>
      <div className="section-title">
        图像填充
        <div>
          {!hideWhenEmpty && (
            <button
              title="选择图像"
              aria-label="选择图像"
              data-tip="选择图像"
              onClick={() => input.current?.click()}
            >
              <ImagePlus size={14} />
            </button>
          )}
          {fill && fill.fit !== "tile" && (
            <button
              type="button"
              className="icon-btn icon-btn-sm"
              aria-label="在画布裁切"
              data-tip="在画布裁切"
              data-tip-desc="拖动图像调整焦点，拖右下角改变倍率，Enter 完成"
              aria-pressed={e.cropping === node.id}
              onClick={() => {
                e.setTool("select");
                e.setEditing(null);
                e.setCropping(e.cropping === node.id ? null : node.id);
              }}
            >
              <Crop size={14} />
            </button>
          )}
          {fill && (
            <button
              title="移除图像"
              aria-label="移除图像"
              data-tip="移除图像"
              onClick={() => e.update({ image: undefined })}
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>
      {!hideWhenEmpty && (
        <input
          ref={input}
          type="file"
          hidden
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={async (ev) => {
            const file = ev.target.files?.[0];
            ev.target.value = "";
            if (!file) return;
            const docId = e.committed.id;
            try {
              const { id, image } = await readImage(file);
              if (e.historyRef.current.present.id !== docId)
                throw new Error("文件已切换");
              e.apply([
                { type: "putImage", id, image },
                {
                  type: "update",
                  id: node.id,
                  patch: {
                    image: { assetId: id, fit: "cover", zoom: 1, x: 50, y: 50 },
                  },
                },
              ]);
            } catch (err) {
              e.setError(err instanceof Error ? err.message : String(err));
            }
          }}
        />
      )}
      {fill && asset && (
        <>
          <div className="image-meta">
            <img src={asset.data} alt="" />
            <span title={asset.width + " × " + asset.height}>{asset.name}</span>
            <select
              aria-label="图像适配"
              value={fill.fit}
              onChange={(ev) =>
                e.update({
                  image: { ...fill, fit: ev.target.value as typeof fill.fit },
                })
              }
            >
              <option value="cover">填充</option>
              <option value="contain">适应</option>
              <option value="fill">拉伸</option>
              <option value="tile">平铺</option>
            </select>
            <button
              type="button"
              className="icon-btn icon-btn-sm"
              title="顺时针旋转 90°"
              aria-label="顺时针旋转 90°"
              data-tip="顺时针旋转 90°"
              data-tip-desc="将图像填充顺时针旋转 90°"
              data-tip-side="left"
              onClick={() => {
                const cur =
                  ((Math.round(fill.rotation ?? 0) % 360) + 360) % 360;
                const next = (cur + 90) % 360;
                e.update({
                  image: {
                    ...fill,
                    rotation: next === 0 ? undefined : next,
                  },
                });
              }}
              style={{
                width: "auto",
                padding: "0 5px",
                gap: 3,
                fontSize: 10,
                fontVariantNumeric: "tabular-nums",
                flexShrink: 0,
              }}
            >
              <RotateCw size={12} />
              <span>
                {((Math.round(fill.rotation ?? 0) % 360) + 360) % 360}°
              </span>
            </button>
          </div>
          <div className="image-crop">
            {(
              ["x", "y", fill.fit === "tile" ? "tileScale" : "zoom"] as const
            ).map((k, i) => {
              const scale = i === 2;
              return (
                <ImageNumber
                  key={k}
                  label={
                    [
                      "水平焦点",
                      "垂直焦点",
                      fill.fit === "tile" ? "图块倍率" : "裁切倍率",
                    ][i]
                  }
                  prefix={["X", "Y", "×"][i]}
                  value={fill[k] ?? 1}
                  min={scale ? (k === "tileScale" ? 0.1 : 1) : 0}
                  max={scale ? 8 : 100}
                  step={0.1}
                  commit={(n) => e.update({ image: { ...fill, [k]: n } })}
                />
              );
            })}
          </div>
          <details className="advanced-properties image-adjustments">
            <summary>图像调色</summary>
            <div className="image-adjustment-fields">
              <ImageNumber
                label="图像不透明度"
                prefix="不透明度"
                value={Math.round((fill.opacity ?? 1) * 100)}
                min={0}
                max={100}
                step={1}
                suffix="%"
                commit={(value) =>
                  e.update({
                    image: {
                      ...fill,
                      opacity: value === 100 ? undefined : value / 100,
                    },
                  })
                }
              />
              {(["brightness", "contrast", "saturation"] as const).map(
                (key, i) => (
                  <ImageNumber
                    key={key}
                    label={["亮度", "对比度", "饱和度"][i]}
                    prefix={["亮度", "对比度", "饱和度"][i]}
                    value={Math.round((fill[key] ?? 1) * 100)}
                    min={0}
                    max={200}
                    step={1}
                    suffix="%"
                    commit={(n) =>
                      e.update({
                        image: {
                          ...fill,
                          [key]: n === 100 ? undefined : n / 100,
                        },
                      })
                    }
                  />
                ),
              )}
              <button
                className="icon-btn icon-btn-sm"
                title="重置图像调色"
                aria-label="重置图像调色"
                data-tip="重置图像调色"
                data-tip-desc="恢复默认亮度、对比度、饱和度、高级调色与旋转角度"
                disabled={
                  [fill.brightness, fill.contrast, fill.saturation].every(
                    (v) => (v ?? 1) === 1,
                  ) &&
                  [
                    fill.exposure,
                    fill.temperature,
                    fill.tint,
                    fill.highlights,
                    fill.shadows,
                    fill.rotation,
                  ].every((v) => !v)
                }
                onClick={() =>
                  e.update({
                    image: {
                      ...fill,
                      brightness: undefined,
                      contrast: undefined,
                      saturation: undefined,
                      exposure: undefined,
                      temperature: undefined,
                      tint: undefined,
                      highlights: undefined,
                      shadows: undefined,
                      rotation: undefined,
                    },
                  })
                }
              >
                <RotateCcw size={13} />
              </button>
            </div>
            <div className="advanced-properties" style={{ marginTop: 6 }}>
              <button
                type="button"
                aria-expanded={advancedOpen}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "2px 0",
                  fontSize: 11,
                  color: "var(--text-secondary)",
                  background: "transparent",
                }}
                onClick={() => setAdvancedOpen((v) => !v)}
              >
                <ChevronRight
                  size={12}
                  style={{
                    transform: advancedOpen ? "rotate(90deg)" : "none",
                    transition: "transform 120ms ease",
                  }}
                />
                <span>高级调色</span>
              </button>
              {advancedOpen && (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                    marginTop: 6,
                  }}
                >
                  {(
                    [
                      ["exposure", "曝光"],
                      ["temperature", "色温"],
                      ["tint", "色调"],
                      ["highlights", "高光"],
                      ["shadows", "阴影"],
                    ] as const
                  ).map(([key, label]) => {
                    const pct = Math.round((fill[key] ?? 0) * 100);
                    return (
                      <label
                        key={key}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "36px 1fr 38px",
                          alignItems: "center",
                          gap: 6,
                          fontSize: 11,
                        }}
                      >
                        <span style={{ color: "var(--text-secondary)" }}>
                          {label}
                        </span>
                        <input
                          type="range"
                          aria-label={label}
                          min={-100}
                          max={100}
                          step={1}
                          value={pct}
                          onChange={(ev) => {
                            const v = Number(ev.target.value);
                            e.update({
                              image: {
                                ...fill,
                                [key]: v === 0 ? undefined : v / 100,
                              },
                            });
                          }}
                        />
                        <span
                          style={{
                            textAlign: "right",
                            fontVariantNumeric: "tabular-nums",
                            color: "var(--text-muted)",
                          }}
                        >
                          {pct > 0 ? `+${pct}%` : `${pct}%`}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </details>
        </>
      )}
    </fieldset>
  );
}

function ImageNumber({
  label,
  prefix,
  value,
  min,
  max,
  step,
  suffix,
  commit,
}: {
  label: string;
  prefix: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  commit: (value: number) => void;
}) {
  return (
    <label className="property-field" data-tip={label}>
      <span>{prefix}</span>
      <input
        type="number"
        aria-label={label}
        key={value}
        defaultValue={value}
        min={min}
        max={max}
        step={step}
        onBlur={(ev) => {
          const el = ev.currentTarget,
            next = el.valueAsNumber;
          if (!el.validity.valid || !Number.isFinite(next))
            el.value = String(value);
          else if (next !== value) commit(next);
        }}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") ev.currentTarget.blur();
          if (ev.key === "Escape") {
            ev.currentTarget.value = String(value);
            ev.currentTarget.blur();
            ev.stopPropagation();
          }
        }}
      />
      {suffix && <small>{suffix}</small>}
    </label>
  );
}
