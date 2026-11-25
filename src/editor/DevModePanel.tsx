import { useMemo, useState } from "react";
import {
  Check,
  CheckCircle2,
  Code2,
  Copy,
  FileCode2,
  MessageSquarePlus,
  Package,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import type {
  Annotation,
  DesignDocument,
  DesignNode,
} from "../domain/document";
import {
  inspectNodeForDev,
  type DevTokenBinding,
  type DevUnit,
} from "../compiler/dev-inspect";
import "./figma-panels.css";

export interface DevModePanelProps {
  document: DesignDocument;
  selectedIds: string[];
  onSelectNode(id: string): void;
  onUpdateNode(id: string, patch: Partial<DesignNode>): void;
  onOpenFullCode(): void;
  onExportReact(): void;
}

type SnippetTab = "css" | "tailwind" | "react";
type PlatformTab = "web" | "react" | "ios" | "android";
type DevStatus = NonNullable<DesignNode["devStatus"]>;

const NODE_TYPE_LABELS: Record<DesignNode["type"], string> = {
  frame: "画板",
  group: "组",
  section: "分区",
  slice: "切片",
  rectangle: "矩形",
  ellipse: "椭圆",
  text: "文本",
  button: "按钮",
  vector: "矢量",
};

const ANNOTATION_CATEGORIES: {
  key: Annotation["category"];
  label: string;
}[] = [
  { key: "spec", label: "规范 Spec" },
  { key: "dev", label: "开发 Dev" },
  { key: "interaction", label: "交互 Interaction" },
  { key: "a11y", label: "无障碍 A11y" },
];

const ANNOTATION_PROP_TAGS = [
  "尺寸",
  "间距",
  "圆角",
  "字体",
  "颜色",
  "阴影",
] as const;

const DEV_STATUS_OPTIONS: { value: DevStatus; label: string }[] = [
  { value: "none", label: "未标记" },
  { value: "ready", label: "Ready for dev" },
  { value: "completed", label: "Completed" },
];

function fmtVal(px: number, unit: DevUnit): string {
  if (px === 0) return "0";
  if (unit === "rem") {
    const r = Math.round((px / 16) * 1000) / 1000;
    return `${r}rem`;
  }
  const v = Math.round(px * 100) / 100;
  return `${v}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = window.document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      window.document.body.appendChild(ta);
      ta.select();
      const ok = window.document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function isColorString(v: string | number | boolean): v is string {
  return typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v.trim());
}

export function DevModePanel({
  document,
  selectedIds,
  onSelectNode,
  onUpdateNode,
  onOpenFullCode,
  onExportReact,
}: DevModePanelProps) {
  const [unit, setUnit] = useState<DevUnit>("px");
  const [snippetTab, setSnippetTab] = useState<SnippetTab>("css");
  const [platform, setPlatform] = useState<PlatformTab>("web");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const [addingNote, setAddingNote] = useState(false);
  const [noteCategory, setNoteCategory] =
    useState<Annotation["category"]>("spec");
  const [noteText, setNoteText] = useState("");
  const [noteProps, setNoteProps] = useState<string[]>([]);

  const primaryNode = useMemo(() => {
    const id = selectedIds[0];
    return id ? (document.nodes.find((n) => n.id === id) ?? null) : null;
  }, [document.nodes, selectedIds]);

  const inspection = useMemo(() => {
    if (!primaryNode) return null;
    try {
      return inspectNodeForDev(document, primaryNode.id, unit);
    } catch {
      return null;
    }
  }, [document, primaryNode, unit]);

  const readyItems = useMemo(() => {
    const items = document.nodes.filter(
      (n) => n.devStatus === "ready" || n.devStatus === "completed",
    );
    return items.sort((a, b) => {
      if (a.devStatus === b.devStatus) return 0;
      return a.devStatus === "ready" ? -1 : 1;
    });
  }, [document.nodes]);

  const rootContainers = useMemo(
    () =>
      document.nodes.filter(
        (n) =>
          !n.parentId &&
          (n.type === "frame" || n.type === "section") &&
          !n.hidden,
      ),
    [document.nodes],
  );

  const handleCopy = async (key: string, text: string) => {
    const ok = await copyText(text);
    if (ok) {
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((prev) => (prev === key ? null : prev));
      }, 1600);
    }
  };

  const canSetDevStatus =
    primaryNode &&
    (primaryNode.type === "frame" ||
      primaryNode.type === "section" ||
      Boolean(primaryNode.instance) ||
      Boolean(primaryNode.componentSet));

  const submitAnnotation = () => {
    if (!primaryNode) return;
    const text = noteText.trim();
    if (!text) return;
    const next: Annotation = {
      id: crypto.randomUUID(),
      category: noteCategory,
      text,
      ...(noteProps.length ? { properties: noteProps } : {}),
    };
    const existing = primaryNode.annotations ?? [];
    onUpdateNode(primaryNode.id, {
      annotations: [...existing, next],
    });
    setNoteText("");
    setNoteProps([]);
    setAddingNote(false);
  };

  const removeAnnotation = (annotationId: string) => {
    if (!primaryNode) return;
    const next = (primaryNode.annotations ?? []).filter(
      (a) => a.id !== annotationId,
    );
    onUpdateNode(primaryNode.id, { annotations: next });
  };

  const toggleNoteProp = (tag: string) => {
    setNoteProps((prev) =>
      prev.includes(tag) ? prev.filter((item) => item !== tag) : [...prev, tag],
    );
  };

  return (
    <div className="fp-dev-panel" aria-label="开发模式检视器">
      <div className="fp-dev-banner">
        <span className="fp-dev-pill">
          <Code2 size={12} aria-hidden="true" />
          Dev Mode
        </span>
        <div className="fp-dev-banner-actions">
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="查看完整 React 代码"
            title="完整 React 代码"
            data-tip="完整 React 代码"
            data-tip-desc="在代码预览弹窗中查看完整组件与 Token CSS"
            data-tip-side="bottom"
            onClick={onOpenFullCode}
          >
            <FileCode2 size={13} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="导出 React 工程"
            title="导出 React 工程"
            data-tip="导出 React 工程"
            data-tip-desc="打包可直接运行的 Vite + React + TypeScript ZIP 工程"
            data-tip-side="bottom"
            onClick={onExportReact}
          >
            <Package size={13} />
          </button>
        </div>
      </div>

      {!primaryNode || !inspection ? (
        <div className="fp-dev-empty-wrap">
          <section className="fp-section">
            <div className="section-title">
              <span className="fp-section-heading">
                就绪画板与分区
                <span className="fp-count-pill">{readyItems.length}</span>
              </span>
            </div>

            {readyItems.length === 0 ? (
              <div className="fp-empty-inline">
                当前页面尚未标记 <strong>Ready for dev</strong>{" "}
                画板。选择任意画板或分区即可标记开发状态并检视代码。
              </div>
            ) : (
              <div className="fp-dev-ready-list">
                {readyItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="fp-dev-ready-card"
                    onClick={() => onSelectNode(item.id)}
                  >
                    <div className="fp-dev-ready-top">
                      <span className="fp-dev-type-tag">
                        {NODE_TYPE_LABELS[item.type]}
                      </span>
                      <strong className="truncate">{item.name}</strong>
                      <span
                        className={`fp-dev-status-chip is-${item.devStatus ?? "none"}`}
                      >
                        {item.devStatus === "completed"
                          ? "Completed"
                          : "Ready for dev"}
                      </span>
                    </div>
                    <div className="fp-dev-ready-meta">
                      <span>
                        {Math.round(item.style.width)} ×{" "}
                        {Math.round(item.style.height)} px
                      </span>
                      {(item.annotations?.length ?? 0) > 0 && (
                        <span>{item.annotations!.length} 条标注</span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>

          {rootContainers.length > 0 && (
            <section className="fp-section">
              <div className="section-title">
                <span className="fp-section-heading">页面画板速览</span>
              </div>
              <div className="fp-dev-ready-list">
                {rootContainers.slice(0, 12).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="fp-dev-ready-card is-compact"
                    onClick={() => onSelectNode(item.id)}
                  >
                    <span className="fp-dev-type-tag">
                      {NODE_TYPE_LABELS[item.type]}
                    </span>
                    <span className="truncate">{item.name}</span>
                    <small>
                      {Math.round(item.style.width)}×
                      {Math.round(item.style.height)}
                    </small>
                  </button>
                ))}
              </div>
            </section>
          )}

          <section className="fp-section fp-dev-quick-footer">
            <button
              type="button"
              className="fp-dev-action-btn"
              onClick={onOpenFullCode}
            >
              <FileCode2 size={13} aria-hidden="true" />
              完整 React 代码
            </button>
            <button
              type="button"
              className="fp-dev-action-btn is-green"
              onClick={onExportReact}
            >
              <Package size={13} aria-hidden="true" />
              导出 React 工程
            </button>
          </section>
        </div>
      ) : (
        <div className="fp-dev-inspector-body">
          {/* Layer Header + Dev Status + Unit Switcher */}
          <section className="fp-section fp-dev-layer-head">
            <div className="fp-dev-layer-title-row">
              <span className="fp-dev-type-tag">
                {NODE_TYPE_LABELS[primaryNode.type]}
              </span>
              <strong className="truncate" title={primaryNode.name}>
                {primaryNode.name}
              </strong>
              <div
                className="fp-unit-switch"
                role="group"
                aria-label="代码尺寸单位"
              >
                {(["px", "rem"] as const).map((u) => (
                  <button
                    key={u}
                    type="button"
                    className={unit === u ? "is-active" : ""}
                    aria-pressed={unit === u}
                    onClick={() => setUnit(u)}
                  >
                    {u}
                  </button>
                ))}
              </div>
            </div>

            <div className="fp-dev-dim-line">
              <span>
                {fmtVal(inspection.boxModel.width, unit)}
                {unit === "px" ? "px" : ""} ×{" "}
                {fmtVal(inspection.boxModel.height, unit)}
                {unit === "px" ? "px" : ""}
              </span>
              {selectedIds.length > 1 && (
                <span className="fp-count-pill">
                  已选 {selectedIds.length} 项 · 检视首项
                </span>
              )}
            </div>

            {canSetDevStatus && (
              <div
                className="fp-dev-status-bar"
                role="group"
                aria-label="开发交付状态"
              >
                {DEV_STATUS_OPTIONS.map((opt) => {
                  const active =
                    (primaryNode.devStatus ?? "none") === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      className={`fp-dev-status-btn is-${opt.value} ${active ? "is-active" : ""}`}
                      aria-pressed={active}
                      onClick={() =>
                        onUpdateNode(primaryNode.id, { devStatus: opt.value })
                      }
                    >
                      {opt.value === "ready" && (
                        <Sparkles size={11} aria-hidden="true" />
                      )}
                      {opt.value === "completed" && (
                        <CheckCircle2 size={11} aria-hidden="true" />
                      )}
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {/* Visual CSS Box Model */}
          <section className="fp-section" aria-label="CSS 盒模型">
            <div className="section-title">
              <span className="fp-section-heading">盒模型 (Box Model)</span>
              <span className="fp-dev-layout-tag">
                {inspection.boxModel.layout === "free"
                  ? "绝对定位"
                  : inspection.boxModel.layout === "row"
                    ? "Flex Row"
                    : inspection.boxModel.layout === "column"
                      ? "Flex Column"
                      : "CSS Grid"}
              </span>
            </div>

            <div className="fp-box-model">
              <div className="fp-bm-ring is-border">
                <span className="fp-bm-label">border</span>
                <span className="fp-bm-val is-top">
                  {fmtVal(inspection.boxModel.border.top, unit)}
                </span>
                <span className="fp-bm-val is-right">
                  {fmtVal(inspection.boxModel.border.right, unit)}
                </span>
                <span className="fp-bm-val is-bottom">
                  {fmtVal(inspection.boxModel.border.bottom, unit)}
                </span>
                <span className="fp-bm-val is-left">
                  {fmtVal(inspection.boxModel.border.left, unit)}
                </span>

                <div className="fp-bm-ring is-padding">
                  <span className="fp-bm-label">padding</span>
                  <span className="fp-bm-val is-top">
                    {fmtVal(inspection.boxModel.padding.top, unit)}
                  </span>
                  <span className="fp-bm-val is-right">
                    {fmtVal(inspection.boxModel.padding.right, unit)}
                  </span>
                  <span className="fp-bm-val is-bottom">
                    {fmtVal(inspection.boxModel.padding.bottom, unit)}
                  </span>
                  <span className="fp-bm-val is-left">
                    {fmtVal(inspection.boxModel.padding.left, unit)}
                  </span>

                  <div className="fp-bm-core">
                    {fmtVal(inspection.boxModel.width, unit)} ×{" "}
                    {fmtVal(inspection.boxModel.height, unit)}
                  </div>
                </div>
              </div>
            </div>

            {(inspection.boxModel.gap > 0 ||
              inspection.boxModel.rowGap !== undefined) && (
              <div className="fp-bm-meta-row">
                {inspection.boxModel.gap > 0 && (
                  <span>
                    gap:{" "}
                    <strong>
                      {fmtVal(inspection.boxModel.gap, unit)}
                      {unit === "px" ? "px" : ""}
                    </strong>
                  </span>
                )}
                {inspection.boxModel.rowGap !== undefined && (
                  <span>
                    row-gap:{" "}
                    <strong>
                      {fmtVal(inspection.boxModel.rowGap, unit)}
                      {unit === "px" ? "px" : ""}
                    </strong>
                  </span>
                )}
              </div>
            )}
          </section>

          {/* Bound Design Tokens & Multi-Platform Code Syntax */}
          <section className="fp-section" aria-label="绑定设计变量">
            <div className="section-title">
              <span className="fp-section-heading">
                设计变量与样式
                {inspection.tokens.length > 0 && (
                  <span className="fp-count-pill">
                    {inspection.tokens.length}
                  </span>
                )}
              </span>
              {inspection.tokens.length > 0 && (
                <div
                  className="fp-platform-pills"
                  role="tablist"
                  aria-label="代码语法平台"
                >
                  {(
                    [
                      ["web", "Web"],
                      ["react", "React"],
                      ["ios", "iOS"],
                      ["android", "Android"],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      aria-selected={platform === key}
                      className={platform === key ? "is-active" : ""}
                      onClick={() => setPlatform(key)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {inspection.tokens.length === 0 ? (
              <div className="fp-empty-inline">
                当前图层未绑定设计变量或共享样式
              </div>
            ) : (
              <div className="fp-token-table">
                {inspection.tokens.map((tok: DevTokenBinding) => {
                  const syntax = tok.codeSyntax[platform];
                  const copyId = `tok:${tok.id}:${tok.property}:${platform}`;
                  return (
                    <div
                      key={`${tok.id}-${tok.property}`}
                      className="fp-token-row"
                    >
                      <div className="fp-token-row-head">
                        <span className="fp-token-prop">{tok.property}</span>
                        {isColorString(tok.resolvedValue) && (
                          <i
                            className="fp-token-swatch"
                            style={{ backgroundColor: tok.resolvedValue }}
                            aria-hidden="true"
                          />
                        )}
                        <span className="fp-token-name truncate">
                          {tok.name}
                        </span>
                        <span className="fp-token-val">
                          {String(tok.resolvedValue)}
                        </span>
                      </div>
                      <div className="fp-token-syntax-row">
                        <code className="truncate" title={syntax}>
                          {syntax}
                        </code>
                        <button
                          type="button"
                          className="icon-btn icon-btn-sm"
                          aria-label={`复制 ${tok.name} 代码语法`}
                          title="复制代码语法"
                          data-tip={
                            copiedKey === copyId ? "已复制" : "复制代码语法"
                          }
                          data-tip-side="left"
                          onClick={() => void handleCopy(copyId, syntax)}
                        >
                          {copiedKey === copyId ? (
                            <Check size={12} />
                          ) : (
                            <Copy size={12} />
                          )}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Code Snippets (CSS / Tailwind / React TSX) */}
          <section className="fp-section" aria-label="代码片段">
            <div className="fp-code-tabs-bar">
              <div
                className="fp-segmented"
                role="tablist"
                aria-label="代码格式"
              >
                {(
                  [
                    ["css", "CSS"],
                    ["tailwind", "Tailwind"],
                    ["react", "React TSX"],
                  ] as const
                ).map(([tab, label]) => (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={snippetTab === tab}
                    className={snippetTab === tab ? "is-active" : ""}
                    onClick={() => setSnippetTab(tab)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label="复制当前代码片段"
                title="复制代码"
                data-tip={
                  copiedKey === `snippet:${snippetTab}`
                    ? "已复制代码"
                    : "复制代码"
                }
                data-tip-side="left"
                onClick={() =>
                  void handleCopy(
                    `snippet:${snippetTab}`,
                    inspection.snippets[snippetTab],
                  )
                }
              >
                {copiedKey === `snippet:${snippetTab}` ? (
                  <Check size={13} />
                ) : (
                  <Copy size={13} />
                )}
              </button>
            </div>

            <div className="fp-code-block" role="tabpanel">
              <pre>
                {inspection.snippets[snippetTab].split("\n").map((line, i) => (
                  <div key={i} className="fp-code-line">
                    <span className="fp-code-ln" aria-hidden="true">
                      {i + 1}
                    </span>
                    <code>{line || " "}</code>
                  </div>
                ))}
              </pre>
            </div>
          </section>

          {/* Persistent Dev Annotations */}
          <section className="fp-section" aria-label="开发标注">
            <div className="section-title">
              <span className="fp-section-heading">
                开发标注
                {inspection.annotations.length > 0 && (
                  <span className="fp-count-pill">
                    {inspection.annotations.length}
                  </span>
                )}
              </span>
              <button
                type="button"
                className={`icon-btn icon-btn-sm ${addingNote ? "active" : ""}`}
                aria-label="添加开发标注"
                aria-expanded={addingNote}
                title="添加开发标注"
                data-tip="添加开发标注"
                data-tip-desc="为开发同学记录规格、交互逻辑或无障碍注意事项"
                data-tip-side="left"
                onClick={() => setAddingNote((v) => !v)}
              >
                <Plus size={14} />
              </button>
            </div>

            {addingNote && (
              <div className="fp-annotation-form">
                <div
                  className="fp-filter-chips"
                  role="group"
                  aria-label="标注分类"
                >
                  {ANNOTATION_CATEGORIES.map((cat) => (
                    <button
                      key={cat.key}
                      type="button"
                      className={`fp-chip is-cat-${cat.key} ${noteCategory === cat.key ? "is-active" : ""}`}
                      aria-pressed={noteCategory === cat.key}
                      onClick={() => setNoteCategory(cat.key)}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>

                <textarea
                  aria-label="标注内容"
                  placeholder="填写规格说明、接口字段、交互边界或无障碍要求…"
                  rows={3}
                  value={noteText}
                  onChange={(ev) => setNoteText(ev.target.value)}
                />

                <div
                  className="fp-annotation-props"
                  role="group"
                  aria-label="关联属性标签"
                >
                  {ANNOTATION_PROP_TAGS.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      className={`fp-prop-tag ${noteProps.includes(tag) ? "is-active" : ""}`}
                      aria-pressed={noteProps.includes(tag)}
                      onClick={() => toggleNoteProp(tag)}
                    >
                      {tag}
                    </button>
                  ))}
                </div>

                <div className="fp-annotation-form-actions">
                  <button
                    type="button"
                    className="fp-dev-action-btn is-green"
                    disabled={!noteText.trim()}
                    onClick={submitAnnotation}
                  >
                    <MessageSquarePlus size={12} aria-hidden="true" />
                    保存标注
                  </button>
                  <button
                    type="button"
                    className="fp-dev-action-btn"
                    onClick={() => {
                      setAddingNote(false);
                      setNoteText("");
                      setNoteProps([]);
                    }}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}

            {inspection.annotations.length === 0 && !addingNote ? (
              <div className="fp-empty-inline">
                暂无开发标注，点击右上角 <strong>+</strong> 添加规格或无障碍说明
              </div>
            ) : (
              <div className="fp-annotations-list">
                {inspection.annotations.map((ann) => {
                  const catLabel =
                    ANNOTATION_CATEGORIES.find((c) => c.key === ann.category)
                      ?.label ?? ann.category;
                  return (
                    <div
                      key={ann.id}
                      className={`fp-annotation-card is-cat-${ann.category}`}
                    >
                      <div className="fp-annotation-head">
                        <span
                          className={`fp-annotation-badge is-cat-${ann.category}`}
                        >
                          {catLabel}
                        </span>
                        <button
                          type="button"
                          className="icon-btn icon-btn-sm"
                          aria-label="删除标注"
                          title="删除标注"
                          data-tip="删除标注"
                          data-tip-side="left"
                          onClick={() => removeAnnotation(ann.id)}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                      <p className="fp-annotation-text">{ann.text}</p>
                      {ann.properties && ann.properties.length > 0 && (
                        <div className="fp-annotation-chips">
                          {ann.properties.map((p) => (
                            <span key={p} className="fp-prop-chip">
                              {p}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="fp-section fp-dev-quick-footer">
            <button
              type="button"
              className="fp-dev-action-btn"
              onClick={onOpenFullCode}
            >
              <FileCode2 size={13} aria-hidden="true" />
              完整 React 代码
            </button>
            <button
              type="button"
              className="fp-dev-action-btn is-green"
              onClick={onExportReact}
            >
              <Package size={13} aria-hidden="true" />
              导出 React 工程
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
