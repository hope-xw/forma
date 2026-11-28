import { type KeyboardEvent, useEffect, useMemo, useState } from "react";
import { Maximize2, X } from "lucide-react";
import type { DesignDocument } from "../domain/document";
import type { Operation } from "../domain/commands";
import { layoutBounds, union } from "../domain/geometry";
import { instanceAncestor, isLocked, selectionRoots } from "../domain/tree";
import { planScaleSelection, type ScaleAnchor } from "../domain/scale-tool";
import { commitEditorOperations } from "../application/geometry-preview";
import "./figma-panels.css";

export interface ScalePanelProps {
  document: DesignDocument;
  selectedIds: string[];
  previewBlocked?: boolean;
  onApplyOperations(ops: Operation[]): void;
  onExitScale(): void;
}

const MIN_FACTOR = 0.01;
const MAX_FACTOR = 100;
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
  return String(rounded);
}

function selectionBox(document: DesignDocument, ids: string[]) {
  const bounds = layoutBounds(document);
  return union(ids.flatMap((id) => bounds.get(id) ?? []));
}

export function ScalePanel({
  document,
  selectedIds,
  previewBlocked = false,
  onApplyOperations,
  onExitScale,
}: ScalePanelProps) {
  type ScaleField = "factor" | "width" | "height";
  const [draft, setDraft] = useState<{
    field: ScaleField;
    raw: string;
    error?: string;
  }>({
    field: "factor",
    raw: "1",
  });
  const [anchor, setAnchor] = useState<ScaleAnchor>("tl");

  const { baseBox, scalableIds, lockedOnly } = useMemo(() => {
    const roots = selectionRoots(document, selectedIds);
    const editable = roots.filter(
      (n) => !isLocked(document, n.id) && !instanceAncestor(document, n.id),
    );
    const scalableIds = editable.map((n) => n.id);
    return {
      baseBox: selectionBox(
        document,
        editable.length ? scalableIds : roots.map((n) => n.id),
      ),
      scalableIds,
      lockedOnly: roots.length > 0 && editable.length === 0,
    };
  }, [document, selectedIds]);

  const baseW = baseBox?.width ?? 0;
  const baseH = baseBox?.height ?? 0;
  const selectionKey = selectedIds.join(",");
  const resetDraft = (error?: string) =>
    setDraft({ field: "factor", raw: "1", error });
  useEffect(() => resetDraft(), [selectionKey, baseW, baseH]);

  // Single-layer geometry is stored at two decimals in the domain's 1–10000 px range.
  const single = scalableIds.length === 1;
  const dimension = (base: number, factor: number) => {
    if (factor === 1) return fmt(base);
    const value = base * factor;
    return fmt(
      single && draft.field !== "factor"
        ? Math.max(1, Math.min(10000, value))
        : value,
    );
  };
  const minDimension = (base: number) =>
    Math.max(single ? 1 : 0, base * MIN_FACTOR);
  const maxDimension = (base: number) =>
    Math.min(single ? 10000 : Infinity, base * MAX_FACTOR);
  const parsed = Number(draft.raw);
  const base = draft.field === "width" ? baseW : baseH;
  const factor = draft.field === "factor" ? parsed : parsed / base;
  const validFactor =
    Number.isFinite(factor) && factor >= MIN_FACTOR && factor <= MAX_FACTOR;
  const validDrafts =
    validFactor &&
    (draft.field === "factor" ||
      (parsed >= minDimension(base) &&
        parsed <= maxDimension(base) &&
        parsed === Number(dimension(base, factor))));
  const draftError =
    draft.error ??
    (!validDrafts && draft.field !== "factor"
      ? `目标${draft.field === "width" ? "宽度" : "高度"}须在 ${minDimension(base)}–${maxDimension(base)} px 范围内，最多两位小数`
      : undefined);
  const factorDraft =
    draft.field === "factor"
      ? draft.raw
      : Number.isFinite(factor) && factor > 0
        ? String(factor)
        : "";
  const derivedDimension = (field: "width" | "height", size: number) =>
    draft.field === field
      ? draft.raw
      : validFactor
        ? dimension(size, factor)
        : "";
  const widthDraft = derivedDimension("width", baseW);
  const heightDraft = derivedDimension("height", baseH);
  const canApply =
    !previewBlocked &&
    validDrafts &&
    Boolean(baseBox) &&
    scalableIds.length > 0 &&
    Math.abs(factor - 1) >= 1e-4;

  const applyScale = () => {
    if (!canApply) return;
    let ops: Operation[];
    try {
      ops = planScaleSelection(document, selectedIds, factor, anchor);
      if (!ops.length) return;
      const result = commitEditorOperations(document, ops, document.revision);
      const box = selectionBox(result, scalableIds);
      if (
        !box ||
        Number(fmt(box.width)) !== Number(widthDraft) ||
        Number(fmt(box.height)) !== Number(heightDraft)
      ) {
        resetDraft(
          "当前布局或图层尺寸限制无法达到目标尺寸" +
            (box ? `，实际可得 ${fmt(box.width)} × ${fmt(box.height)} px` : ""),
        );
        return;
      }
    } catch (error) {
      resetDraft(error instanceof Error ? error.message : "无法应用此目标尺寸");
      return;
    }
    onApplyOperations(ops);
    resetDraft();
  };

  const finishKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" || event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") resetDraft();
      else if (!validDrafts) resetDraft(draftError);
      else applyScale();
    }
  };
  const restoreInvalid = () => {
    if (!validDrafts) resetDraft(draftError);
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
                disabled={lockedOnly || previewBlocked}
                aria-pressed={Math.abs(factor - preset) < 0.005}
                onClick={() =>
                  setDraft({ field: "factor", raw: String(preset) })
                }
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
                  min={MIN_FACTOR}
                  max={MAX_FACTOR}
                  aria-label="缩放倍率"
                  disabled={lockedOnly || previewBlocked}
                  value={factorDraft}
                  onChange={(ev) =>
                    setDraft({ field: "factor", raw: ev.target.value })
                  }
                  onBlur={restoreInvalid}
                  onKeyDown={finishKey}
                />
                <em>×</em>
              </label>

              <div className="fp-scale-wh">
                <label className="fp-inline-field">
                  <span>W</span>
                  <input
                    type="number"
                    min={minDimension(baseW)}
                    max={maxDimension(baseW)}
                    step="any"
                    aria-invalid={draft.field === "width" && !validDrafts}
                    aria-label="目标宽度"
                    disabled={lockedOnly || previewBlocked}
                    value={widthDraft}
                    onChange={(ev) =>
                      setDraft({ field: "width", raw: ev.target.value })
                    }
                    onBlur={restoreInvalid}
                    onKeyDown={finishKey}
                  />
                </label>
                <label className="fp-inline-field">
                  <span>H</span>
                  <input
                    type="number"
                    min={minDimension(baseH)}
                    max={maxDimension(baseH)}
                    step="any"
                    aria-invalid={draft.field === "height" && !validDrafts}
                    aria-label="目标高度"
                    disabled={lockedOnly || previewBlocked}
                    value={heightDraft}
                    onChange={(ev) =>
                      setDraft({ field: "height", raw: ev.target.value })
                    }
                    onBlur={restoreInvalid}
                    onKeyDown={finishKey}
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
                    disabled={lockedOnly || previewBlocked}
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
          ) : draftError ? (
            <div className="fp-scale-note is-warn" role="status">
              {draftError}
            </div>
          ) : (
            <div className="fp-scale-note">
              同步缩放字号、圆角、描边、间距与阴影
              {canApply && (
                <strong>
                  {" "}
                  · {Math.round(baseBox.width)}×{Math.round(baseBox.height)} →{" "}
                  {widthDraft}×{heightDraft}
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
