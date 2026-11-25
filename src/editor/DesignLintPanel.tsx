import { useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
  ShieldCheck,
  Wand2,
  X,
} from "lucide-react";
import type { DesignDocument } from "../domain/document";
import type { Operation } from "../domain/commands";
import {
  checkDesigns,
  type LintIssue,
  type LintIssueKind,
} from "../domain/design-lint";
import { useModalDialog } from "./useModalDialog";
import "./figma-panels.css";

export interface DesignLintPanelProps {
  open: boolean;
  document: DesignDocument;
  selectedIds: string[];
  onClose(): void;
  onFocusNode(id: string): void;
  onApplyOperations(ops: Operation[]): void;
}

type CategoryFilter = "all" | LintIssueKind;

const CATEGORY_CHIPS: { key: CategoryFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "unbound-color", label: "未绑定颜色" },
  { key: "unbound-typography", label: "未绑定字体" },
  { key: "low-contrast", label: "对比度告警" },
  { key: "generic-name", label: "图层命名" },
];

function SeverityIcon({ severity }: { severity: LintIssue["severity"] }) {
  if (severity === "error") {
    return (
      <AlertCircle
        size={13}
        className="fp-lint-icon is-error"
        aria-hidden="true"
      />
    );
  }
  if (severity === "warning") {
    return (
      <AlertTriangle
        size={13}
        className="fp-lint-icon is-warning"
        aria-hidden="true"
      />
    );
  }
  return <Info size={13} className="fp-lint-icon is-info" aria-hidden="true" />;
}

export function DesignLintPanel({
  open,
  document,
  selectedIds,
  onClose,
  onFocusNode,
  onApplyOperations,
}: DesignLintPanelProps) {
  const [scope, setScope] = useState<"page" | "selection">("page");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const dialogRef = useModalDialog(open, onClose, false);

  const effectiveScopeIds =
    scope === "selection" && selectedIds.length > 0 ? selectedIds : undefined;

  const allIssues = useMemo(
    () => (open ? checkDesigns(document, effectiveScopeIds) : []),
    [open, document, effectiveScopeIds],
  );

  const countsByKind = useMemo(() => {
    const map: Record<CategoryFilter, number> = {
      all: allIssues.length,
      "unbound-color": 0,
      "unbound-typography": 0,
      "low-contrast": 0,
      "generic-name": 0,
    };
    for (const issue of allIssues) map[issue.kind]++;
    return map;
  }, [allIssues]);

  const visibleIssues = useMemo(
    () =>
      category === "all"
        ? allIssues
        : allIssues.filter((issue) => issue.kind === category),
    [allIssues, category],
  );

  const fixableOps = useMemo(() => {
    const ops: Operation[] = [];
    for (const issue of visibleIssues) {
      if (issue.fixOperations?.length) ops.push(...issue.fixOperations);
    }
    return ops;
  }, [visibleIssues]);

  const fixableCount = useMemo(
    () => visibleIssues.filter((i) => Boolean(i.fixOperations?.length)).length,
    [visibleIssues],
  );

  if (!open) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="false"
      aria-label="设计规范校验"
      tabIndex={-1}
      className="fp-floating-panel fp-lint-panel"
    >
      <div className="fp-panel-header">
        <div className="fp-panel-title">
          <ShieldCheck size={14} aria-hidden="true" />
          <strong>设计规范校验</strong>
          <span className="fp-count-pill">{allIssues.length}</span>
        </div>
        <div className="fp-panel-header-actions">
          <button
            type="button"
            className="primary fp-lint-fix-all"
            disabled={fixableOps.length === 0}
            title="自动修复当前列表中所有可修复项"
            data-tip="全部自动修复"
            data-tip-desc={
              fixableCount > 0
                ? `一次性自动修复 ${fixableCount} 项未绑定变量与样式问题`
                : "当前列表暂无支持一键自动修复的问题"
            }
            data-tip-side="bottom"
            onClick={() => {
              if (fixableOps.length) onApplyOperations(fixableOps);
            }}
          >
            <Wand2 size={12} aria-hidden="true" />
            全部自动修复{fixableCount > 0 ? ` (${fixableCount})` : ""}
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="关闭设计规范校验"
            title="关闭设计规范校验"
            data-tip="关闭设计规范校验"
            data-tip-kbd="Esc"
            data-tip-side="left"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="fp-lint-controls">
        <div className="fp-segmented" role="tablist" aria-label="校验范围">
          <button
            type="button"
            role="tab"
            aria-selected={scope === "page"}
            className={scope === "page" ? "is-active" : ""}
            onClick={() => setScope("page")}
          >
            当前页面
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === "selection"}
            className={scope === "selection" ? "is-active" : ""}
            disabled={selectedIds.length === 0}
            title={
              selectedIds.length === 0
                ? "请先在画布中选中图层"
                : `仅检查当前选中的 ${selectedIds.length} 个图层`
            }
            onClick={() => setScope("selection")}
          >
            当前选区
            {selectedIds.length > 0 && <span>{selectedIds.length}</span>}
          </button>
        </div>

        <div className="fp-filter-chips" role="group" aria-label="问题分类">
          {CATEGORY_CHIPS.map((chip) => {
            const count = countsByKind[chip.key];
            return (
              <button
                key={chip.key}
                type="button"
                className={`fp-chip ${category === chip.key ? "is-active" : ""}`}
                aria-pressed={category === chip.key}
                onClick={() => setCategory(chip.key)}
              >
                {chip.label}
                {count > 0 && <span className="fp-chip-count">{count}</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="fp-lint-list">
        {visibleIssues.length === 0 ? (
          <div className="fp-empty-state">
            <CheckCircle2
              size={24}
              className="fp-empty-state-icon is-success"
              aria-hidden="true"
            />
            <strong>
              {allIssues.length === 0
                ? "未发现设计规范问题"
                : "当前分类下无问题"}
            </strong>
            <p>
              {allIssues.length === 0
                ? "颜色绑定、文字样式、WCAG 对比度与图层命名均符合规范"
                : "切换上方分类标签可查看其他建议项"}
            </p>
          </div>
        ) : (
          visibleIssues.map((issue) => (
            <div key={issue.id} className={`fp-lint-item is-${issue.severity}`}>
              <div className="fp-lint-item-top">
                <SeverityIcon severity={issue.severity} />
                <button
                  type="button"
                  className="fp-lint-layer-btn"
                  title={`定位到图层「${issue.nodeName}」`}
                  onClick={() => onFocusNode(issue.nodeId)}
                >
                  {issue.nodeName}
                </button>
                <span className={`fp-severity-badge is-${issue.severity}`}>
                  {issue.severity === "error"
                    ? "告警"
                    : issue.severity === "warning"
                      ? "建议"
                      : "提示"}
                </span>
              </div>

              <div className="fp-lint-message">{issue.message}</div>

              {issue.contrast && (
                <div className="fp-lint-contrast-meta">
                  <span
                    className="fp-contrast-swatch"
                    style={{
                      color: issue.contrast.fg,
                      background: issue.contrast.bg,
                    }}
                  >
                    Aa
                  </span>
                  <span>
                    对比度 {issue.contrast.ratio.toFixed(2)}:1 (未通过 WCAG AA)
                  </span>
                  <code>
                    {issue.contrast.fg} / {issue.contrast.bg}
                  </code>
                </div>
              )}

              {!issue.contrast && issue.detail && (
                <div className="fp-lint-detail">{issue.detail}</div>
              )}

              {issue.fixOperations && issue.fixOperations.length > 0 && (
                <div className="fp-lint-item-actions">
                  <button
                    type="button"
                    className="fp-lint-fix-btn"
                    onClick={() => onApplyOperations(issue.fixOperations!)}
                  >
                    <Wand2 size={11} aria-hidden="true" />
                    一键修复
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
