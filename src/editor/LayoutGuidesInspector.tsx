import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Columns3,
  Eye,
  EyeOff,
  Grid3X3,
  Minus,
  Plus,
  Rows3,
} from "lucide-react";
import type { DesignNode, LayoutGuide } from "../domain/node";
import "./figma-panels.css";

export interface LayoutGuidesInspectorProps {
  node: DesignNode;
  locked: boolean;
  onChange(guides: NonNullable<DesignNode["style"]["layoutGuides"]>): void;
}

const MAX_GUIDES = 16;

const KIND_LABELS: Record<LayoutGuide["kind"], string> = {
  grid: "网格 (Grid)",
  columns: "列 (Columns)",
  rows: "行 (Rows)",
};

const COLUMN_ALIGN_LABELS: Record<LayoutGuide["alignment"], string> = {
  stretch: "拉伸 (Stretch)",
  min: "左对齐 (Left)",
  center: "居中 (Center)",
  max: "右对齐 (Right)",
};

const ROW_ALIGN_LABELS: Record<LayoutGuide["alignment"], string> = {
  stretch: "拉伸 (Stretch)",
  min: "顶对齐 (Top)",
  center: "居中 (Center)",
  max: "底对齐 (Bottom)",
};

function createDefaultGuide(): LayoutGuide {
  return {
    id: crypto.randomUUID(),
    kind: "columns",
    visible: true,
    color: "#F24822",
    opacity: 0.12,
    size: 8,
    count: 12,
    gutter: 16,
    offset: 16,
    alignment: "stretch",
  };
}

function clampInt(raw: string, min: number, max: number, fallback: number) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampNum(raw: string, min: number, max: number, fallback: number) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n * 100) / 100));
}

function normalizeHex(raw: string, fallback: string): string {
  const cleaned = raw.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(cleaned)) return `#${cleaned.toUpperCase()}`;
  if (/^[0-9a-fA-F]{3}$/.test(cleaned)) {
    return (
      "#" +
      cleaned
        .split("")
        .map((c) => c + c)
        .join("")
        .toUpperCase()
    );
  }
  return fallback;
}

function guideSummary(g: LayoutGuide): string {
  if (g.kind === "grid") return `${g.size}px`;
  return `${g.count} ${g.kind === "columns" ? "列" : "行"}`;
}

function GuideKindIcon({ kind }: { kind: LayoutGuide["kind"] }) {
  if (kind === "grid") return <Grid3X3 size={13} aria-hidden="true" />;
  if (kind === "rows") return <Rows3 size={13} aria-hidden="true" />;
  return <Columns3 size={13} aria-hidden="true" />;
}

function GuideHexInput({
  value,
  disabled,
  ariaLabel,
  onCommit,
}: {
  value: string;
  disabled: boolean;
  ariaLabel: string;
  onCommit(hex: string): void;
}) {
  const [draft, setDraft] = useState(value.toUpperCase());
  useEffect(() => {
    setDraft(value.toUpperCase());
  }, [value]);

  const commit = () => {
    const normalized = normalizeHex(draft, value);
    setDraft(normalized);
    if (normalized.toUpperCase() !== value.toUpperCase()) {
      onCommit(normalized);
    }
  };

  return (
    <input
      type="text"
      className="fp-mini-input fp-hex-input"
      aria-label={ariaLabel}
      disabled={disabled}
      value={draft}
      onChange={(ev) => setDraft(ev.target.value)}
      onBlur={commit}
      onKeyDown={(ev) => {
        if (ev.nativeEvent.isComposing) return;
        if (ev.key === "Enter") {
          ev.preventDefault();
          commit();
          ev.currentTarget.blur();
        } else if (ev.key === "Escape") {
          ev.preventDefault();
          setDraft(value.toUpperCase());
          ev.currentTarget.blur();
        }
      }}
    />
  );
}

export function LayoutGuidesInspector({
  node,
  locked,
  onChange,
}: LayoutGuidesInspectorProps) {
  const guides = node.style.layoutGuides ?? [];
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const canAdd = !locked && guides.length < MAX_GUIDES;

  const updateGuide = (id: string, patch: Partial<LayoutGuide>) => {
    onChange(guides.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  };

  const addGuide = () => {
    if (!canAdd) return;
    const next = createDefaultGuide();
    onChange([...guides, next]);
    setExpandedId(next.id);
  };

  const removeGuide = (id: string) => {
    if (locked) return;
    onChange(guides.filter((g) => g.id !== id));
    if (expandedId === id) setExpandedId(null);
  };

  return (
    <section
      className={`fp-section fp-guides-section ${guides.length === 0 ? "is-collapsed-section" : ""}`}
      aria-label="布局参考网格"
    >
      <div className="section-title">
        <span className="fp-section-heading">
          布局参考网格
          {guides.length > 0 && (
            <span className="fp-count-pill">{guides.length}</span>
          )}
        </span>
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          disabled={!canAdd}
          aria-label="添加布局参考网格"
          title="添加布局参考网格"
          data-tip="添加布局参考网格"
          data-tip-desc={
            locked
              ? "当前图层已锁定，解锁后可编辑参考网格"
              : guides.length >= MAX_GUIDES
                ? `最多可添加 ${MAX_GUIDES} 组参考网格`
                : "添加 12 列参考网格（#F24822 · 12%）"
          }
          data-tip-side="left"
          onClick={addGuide}
        >
          <Plus size={14} />
        </button>
      </div>

      {guides.length > 0 && (
        <div className="fp-guides-list">
          {guides.map((guide, idx) => {
            const expanded = expandedId === guide.id;
            const alignLabels =
              guide.kind === "rows" ? ROW_ALIGN_LABELS : COLUMN_ALIGN_LABELS;
            const opacityPct = Math.round(guide.opacity * 100);

            return (
              <div
                key={guide.id}
                className={`fp-guide-card ${!guide.visible ? "is-hidden" : ""} ${expanded ? "is-expanded" : ""}`}
              >
                <div className="fp-guide-row">
                  <button
                    type="button"
                    className="icon-btn icon-btn-sm fp-guide-expand"
                    aria-label={expanded ? "收起网格参数" : "展开网格参数"}
                    aria-expanded={expanded}
                    title={expanded ? "收起网格参数" : "展开网格参数"}
                    data-tip={expanded ? "收起网格参数" : "展开网格参数"}
                    data-tip-desc="编辑颜色、透明度、列数、间距、边距与对齐"
                    data-tip-side="left"
                    onClick={() => setExpandedId(expanded ? null : guide.id)}
                  >
                    {expanded ? (
                      <ChevronDown size={13} />
                    ) : (
                      <ChevronRight size={13} />
                    )}
                  </button>

                  <span
                    className="fp-guide-kind-badge"
                    style={{
                      color: guide.color,
                      background: `${guide.color}22`,
                    }}
                    aria-hidden="true"
                  >
                    <GuideKindIcon kind={guide.kind} />
                  </span>

                  <select
                    className="fp-guide-kind-select"
                    aria-label={`参考网格 ${idx + 1} 类型`}
                    disabled={locked}
                    value={guide.kind}
                    onChange={(ev) => {
                      const nextKind = ev.target.value as LayoutGuide["kind"];
                      updateGuide(guide.id, {
                        kind: nextKind,
                        size:
                          nextKind === "grid"
                            ? Math.max(1, Math.min(2000, guide.size || 8))
                            : Math.max(
                                1,
                                Math.min(
                                  2000,
                                  guide.size < 12 ? 48 : guide.size,
                                ),
                              ),
                      });
                    }}
                  >
                    <option value="columns">{KIND_LABELS.columns}</option>
                    <option value="rows">{KIND_LABELS.rows}</option>
                    <option value="grid">{KIND_LABELS.grid}</option>
                  </select>

                  <span className="fp-guide-meta">{guideSummary(guide)}</span>

                  <button
                    type="button"
                    className={`icon-btn icon-btn-sm ${!guide.visible ? "is-muted" : ""}`}
                    disabled={locked}
                    aria-label={guide.visible ? "隐藏参考网格" : "显示参考网格"}
                    aria-pressed={!guide.visible}
                    title={guide.visible ? "隐藏参考网格" : "显示参考网格"}
                    data-tip={guide.visible ? "隐藏参考网格" : "显示参考网格"}
                    data-tip-side="top"
                    onClick={() =>
                      updateGuide(guide.id, { visible: !guide.visible })
                    }
                  >
                    {guide.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                  </button>

                  <button
                    type="button"
                    className="icon-btn icon-btn-sm"
                    disabled={locked}
                    aria-label={`移除参考网格 ${idx + 1}`}
                    title="移除参考网格"
                    data-tip="移除参考网格"
                    data-tip-side="top"
                    onClick={() => removeGuide(guide.id)}
                  >
                    <Minus size={13} />
                  </button>
                </div>

                {expanded && (
                  <div className="fp-guide-details">
                    <div className="fp-guide-color-row">
                      <label className="fp-swatch-picker" title="参考网格颜色">
                        <span
                          className="fp-swatch-chip"
                          style={{
                            backgroundColor: guide.color,
                            opacity: Math.max(0.25, guide.opacity),
                          }}
                        />
                        <input
                          type="color"
                          aria-label={`参考网格 ${idx + 1} 颜色`}
                          disabled={locked}
                          value={guide.color}
                          onChange={(ev) =>
                            updateGuide(guide.id, {
                              color: normalizeHex(ev.target.value, guide.color),
                            })
                          }
                        />
                      </label>
                      <GuideHexInput
                        value={guide.color}
                        disabled={locked}
                        ariaLabel={`参考网格 ${idx + 1} 色值`}
                        onCommit={(color) => updateGuide(guide.id, { color })}
                      />
                      <label className="fp-inline-field fp-opacity-field">
                        <span>不透明</span>
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={1}
                          aria-label={`参考网格 ${idx + 1} 不透明度`}
                          disabled={locked}
                          value={opacityPct}
                          onChange={(ev) =>
                            updateGuide(guide.id, {
                              opacity:
                                clampInt(ev.target.value, 0, 100, opacityPct) /
                                100,
                            })
                          }
                        />
                        <em>%</em>
                      </label>
                    </div>

                    {guide.kind === "grid" ? (
                      <div className="fp-guide-grid">
                        <label className="fp-inline-field">
                          <span>间距</span>
                          <input
                            type="number"
                            min={1}
                            max={2000}
                            aria-label="网格大小"
                            disabled={locked}
                            value={guide.size}
                            onChange={(ev) =>
                              updateGuide(guide.id, {
                                size: clampNum(
                                  ev.target.value,
                                  1,
                                  2000,
                                  guide.size,
                                ),
                              })
                            }
                          />
                          <em>px</em>
                        </label>
                      </div>
                    ) : (
                      <div className="fp-guide-grid">
                        <label className="fp-inline-field">
                          <span>
                            {guide.kind === "columns" ? "列数" : "行数"}
                          </span>
                          <input
                            type="number"
                            min={1}
                            max={64}
                            aria-label={
                              guide.kind === "columns" ? "列数" : "行数"
                            }
                            disabled={locked}
                            value={guide.count}
                            onChange={(ev) =>
                              updateGuide(guide.id, {
                                count: clampInt(
                                  ev.target.value,
                                  1,
                                  64,
                                  guide.count,
                                ),
                              })
                            }
                          />
                        </label>

                        <label className="fp-inline-field fp-select-field">
                          <span>对齐</span>
                          <select
                            aria-label="参考网格对齐方式"
                            disabled={locked}
                            value={guide.alignment}
                            onChange={(ev) =>
                              updateGuide(guide.id, {
                                alignment: ev.target
                                  .value as LayoutGuide["alignment"],
                              })
                            }
                          >
                            {(["stretch", "min", "center", "max"] as const).map(
                              (mode) => (
                                <option key={mode} value={mode}>
                                  {alignLabels[mode]}
                                </option>
                              ),
                            )}
                          </select>
                        </label>

                        {guide.alignment !== "stretch" && (
                          <label className="fp-inline-field">
                            <span>
                              {guide.kind === "columns" ? "列宽" : "行高"}
                            </span>
                            <input
                              type="number"
                              min={1}
                              max={2000}
                              aria-label={
                                guide.kind === "columns" ? "列宽" : "行高"
                              }
                              disabled={locked}
                              value={guide.size}
                              onChange={(ev) =>
                                updateGuide(guide.id, {
                                  size: clampNum(
                                    ev.target.value,
                                    1,
                                    2000,
                                    guide.size,
                                  ),
                                })
                              }
                            />
                          </label>
                        )}

                        {guide.alignment !== "center" && (
                          <label className="fp-inline-field">
                            <span>
                              {guide.alignment === "stretch" ? "边距" : "偏移"}
                            </span>
                            <input
                              type="number"
                              min={0}
                              max={2000}
                              aria-label={
                                guide.alignment === "stretch"
                                  ? "网格边距"
                                  : "网格偏移"
                              }
                              disabled={locked}
                              value={guide.offset}
                              onChange={(ev) =>
                                updateGuide(guide.id, {
                                  offset: clampNum(
                                    ev.target.value,
                                    0,
                                    2000,
                                    guide.offset,
                                  ),
                                })
                              }
                            />
                          </label>
                        )}

                        <label className="fp-inline-field">
                          <span>槽宽</span>
                          <input
                            type="number"
                            min={0}
                            max={500}
                            aria-label="槽宽"
                            disabled={locked}
                            value={guide.gutter}
                            onChange={(ev) =>
                              updateGuide(guide.id, {
                                gutter: clampNum(
                                  ev.target.value,
                                  0,
                                  500,
                                  guide.gutter,
                                ),
                              })
                            }
                          />
                        </label>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
