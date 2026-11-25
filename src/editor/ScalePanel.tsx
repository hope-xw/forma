import { useEffect, useMemo, useState } from "react";
import { Maximize2, X } from "lucide-react";
import type { DesignDocument } from "../domain/document";
import type { Operation } from "../domain/commands";
import { layoutBounds, union } from "../domain/geometry";
import { instanceAncestor, isLocked, selectionRoots } from "../domain/tree";
import { planScaleSelection, type ScaleAnchor } from "../domain/scale-tool";
import "./figma-panels.css";

export interface ScalePanelProps {
  document: DesignDocument;
  selectedIds: string[];
  onApplyOperations(ops: Operation[]): void;
  onExitScale(): void;
}

const PRESET_FACTORS = [0.5, 0.75, 1.5, 2, 3] as const;

const ANCHOR_POINTS: { id: ScaleAnchor; label: string }[] = [
  { id: "tl", label: "左上基准点" },
  { id: "tc", label: "上中基准点" },
  { id: "tr", label: "右上基准点" },
  { id: "ml", label: "左中基准点" },
  { id: "mc", label: "中心基准点" },
  { id: "mr", label: "右中基准点" },
  { id: "bl", label: "左下基准点" },
  { id: "bc", label: "下中基准点" },
  { id: "br", label: "右下基准点" },
];

function fmt(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

export function ScalePanel({
  document,
  selectedIds,
  onApplyOperations,
  onExitScale,
}: ScalePanelProps) {
  const [factor, setFactor] = useState(1);
  const [factorDraft, setFactorDraft] = useState("1");
  const [anchor, setAnchor] = useState<ScaleAnchor>("tl");

  const { baseBox, scalableCount, lockedOnly } = useMemo(() => {
    const roots = selectionRoots(document, selectedIds);
    const editable = roots.filter(
      (n) => !isLocked(document, n.id) && !instanceAncestor(document, n.id),
    );
    const bounds = layoutBounds(document);
    const boxes = (editable.length ? editable : roots)
      .map((n) => bounds.get(n.id))
      .filter((b): b is NonNullable<typeof b> => Boolean(b));
    return {
      baseBox: union(boxes),
      scalableCount: editable.length,
      lockedOnly: roots.length > 0 && editable.length === 0,
    };
  }, [document, selectedIds]);

  const [widthDraft, setWidthDraft] = useState(() =>
    baseBox ? fmt(baseBox.width) : "",
  );
  const [heightDraft, setHeightDraft] = useState(() =>
    baseBox ? fmt(baseBox.height) : "",
  );

  // Sync dimension drafts whenever selection box changes
  const baseW = baseBox?.width ?? 0;
  const baseH = baseBox?.height ?? 0;
  const selectionKey = selectedIds.join(",");

  useEffect(() => {
    setFactor(1);
    setFactorDraft("1");
    setWidthDraft(baseW ? fmt(baseW) : "");
    setHeightDraft(baseH ? fmt(baseH) : "");
  }, [selectionKey, baseW, baseH]);

  const setFactorAndSync = (nextFactor: number) => {
    const clamped = Math.max(
      0.01,
      Math.min(100, Math.round(nextFactor * 1000) / 1000),
    );
    setFactor(clamped);
    setFactorDraft(fmt(clamped));
    if (baseBox) {
      setWidthDraft(fmt(baseBox.width * clamped));
      setHeightDraft(fmt(baseBox.height * clamped));
    }
  };

  const handleFactorChange = (raw: string) => {
    setFactorDraft(raw);
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      const clamped = Math.max(0.01, Math.min(100, parsed));
      setFactor(clamped);
      if (baseBox) {
        setWidthDraft(fmt(baseBox.width * clamped));
        setHeightDraft(fmt(baseBox.height * clamped));
      }
    }
  };

  const handleWidthChange = (raw: string) => {
    setWidthDraft(raw);
    if (!baseBox || baseBox.width <= 0) return;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      const nextFactor = Math.max(0.01, Math.min(100, parsed / baseBox.width));
      setFactor(nextFactor);
      setFactorDraft(fmt(nextFactor));
      setHeightDraft(fmt(baseBox.height * nextFactor));
    }
  };

  const handleHeightChange = (raw: string) => {
    setHeightDraft(raw);
    if (!baseBox || baseBox.height <= 0) return;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      const nextFactor = Math.max(0.01, Math.min(100, parsed / baseBox.height));
      setFactor(nextFactor);
      setFactorDraft(fmt(nextFactor));
      setWidthDraft(fmt(baseBox.width * nextFactor));
    }
  };

  const canApply =
    Boolean(baseBox) &&
    scalableCount > 0 &&
    Number.isFinite(factor) &&
    factor > 0 &&
    Math.abs(factor - 1) >= 1e-4;

  const applyScale = () => {
    if (!canApply) return;
    const ops = planScaleSelection(document, selectedIds, factor, anchor);
    if (ops.length) {
      onApplyOperations(ops);
      setFactor(1);
      setFactorDraft("1");
    }
  };

  return (
    <section className="fp-section fp-scale-panel" aria-label="等比缩放工具">
      <div className="section-title">
        <span className="fp-section-heading">
          <Maximize2 size={12} aria-hidden="true" />
          比例缩放
          <kbd className="fp-kbd-inline">K</kbd>
        </span>
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          aria-label="退出缩放模式"
          title="退出缩放模式 (V)"
          data-tip="退出缩放模式"
          data-tip-kbd="V"
          data-tip-desc="切换回选择工具"
          data-tip-side="left"
          onClick={onExitScale}
        >
          <X size={13} />
        </button>
      </div>

      {!baseBox ? (
        <div className="fp-empty-inline">请先在画布中选择要等比缩放的图层</div>
      ) : (
        <>
          <div className="fp-scale-presets" role="group" aria-label="快捷倍率">
            {PRESET_FACTORS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={`fp-pill-btn ${Math.abs(factor - preset) < 0.005 ? "is-active" : ""}`}
                disabled={lockedOnly}
                aria-pressed={Math.abs(factor - preset) < 0.005}
                onClick={() => setFactorAndSync(preset)}
              >
                {preset}×
              </button>
            ))}
          </div>

          <div className="fp-scale-body">
            <div className="fp-scale-inputs">
              <label className="fp-inline-field">
                <span>倍率</span>
                <input
                  type="number"
                  step={0.1}
                  min={0.01}
                  max={100}
                  aria-label="缩放倍率"
                  disabled={lockedOnly}
                  value={factorDraft}
                  onChange={(ev) => handleFactorChange(ev.target.value)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" && !ev.nativeEvent.isComposing) {
                      ev.preventDefault();
                      applyScale();
                    }
                  }}
                />
                <em>×</em>
              </label>

              <div className="fp-scale-wh">
                <label className="fp-inline-field">
                  <span>W</span>
                  <input
                    type="number"
                    min={1}
                    max={10000}
                    aria-label="目标宽度"
                    disabled={lockedOnly}
                    value={widthDraft}
                    onChange={(ev) => handleWidthChange(ev.target.value)}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter") {
                        ev.preventDefault();
                        applyScale();
                      }
                    }}
                  />
                </label>
                <label className="fp-inline-field">
                  <span>H</span>
                  <input
                    type="number"
                    min={1}
                    max={10000}
                    aria-label="目标高度"
                    disabled={lockedOnly}
                    value={heightDraft}
                    onChange={(ev) => handleHeightChange(ev.target.value)}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter") {
                        ev.preventDefault();
                        applyScale();
                      }
                    }}
                  />
                </label>
              </div>
            </div>

            <div className="fp-anchor-wrap">
              <span className="fp-anchor-caption">基准点</span>
              <div
                className="fp-anchor-grid"
                role="group"
                aria-label="缩放基准点"
              >
                {ANCHOR_POINTS.map((pt) => (
                  <button
                    key={pt.id}
                    type="button"
                    className={`fp-anchor-cell ${anchor === pt.id ? "is-active" : ""}`}
                    disabled={lockedOnly}
                    aria-label={pt.label}
                    aria-pressed={anchor === pt.id}
                    title={pt.label}
                    data-tip={pt.label}
                    data-tip-side="top"
                    onClick={() => setAnchor(pt.id)}
                  >
                    <i aria-hidden="true" />
                  </button>
                ))}
              </div>
            </div>
          </div>

          {lockedOnly ? (
            <div className="fp-scale-note is-warn">
              当前选区已锁定或位于受保护组件内部，无法等比缩放
            </div>
          ) : (
            <div className="fp-scale-note">
              同步缩放字号、圆角、描边、间距与阴影
              {canApply && (
                <strong>
                  {" "}
                  · {Math.round(baseBox.width)}×{Math.round(baseBox.height)} →{" "}
                  {Math.round(baseBox.width * factor)}×
                  {Math.round(baseBox.height * factor)}
                </strong>
              )}
            </div>
          )}

          <div className="fp-scale-actions">
            <button
              type="button"
              className="primary fp-scale-apply"
              disabled={!canApply}
              onClick={applyScale}
            >
              应用等比缩放
            </button>
            <button
              type="button"
              className="fp-scale-exit"
              onClick={onExitScale}
            >
              退出缩放 (V)
            </button>
          </div>
        </>
      )}
    </section>
  );
}
