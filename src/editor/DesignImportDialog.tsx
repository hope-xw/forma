import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  LocateFixed,
  Search,
  X,
} from "lucide-react";
import {
  classifyImportIssue,
  importIssueCategoryLabels,
  importSummary,
  issueWeight,
  type ImportIssueCategory,
  type ImportSummary,
} from "../infrastructure/design-import/summary";
import type {
  DesignDocument,
  ImportIssue,
  ImportReport,
} from "../domain/document";
import { download } from "../infrastructure/storage";
import { SourceName } from "./SourceName";
import { useModalDialog } from "./useModalDialog";
import "./design-import.css";

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function groupDetailKey(detail: string): string {
  const paren = detail.indexOf("（共 ");
  if (paren > 0) return detail.slice(0, paren);
  const colon = detail.indexOf("：");
  if (
    colon > 0 &&
    /覆盖路径|共享样式缺失|换件主件|颜色变量缺失|未映射覆盖/.test(detail)
  )
    return detail.slice(0, colon);
  const guidAt = detail.indexOf(" fig-");
  if (guidAt > 0) return detail.slice(0, guidAt);
  return detail;
}

interface GroupedIssue {
  key: string;
  label: string;
  category: ImportIssueCategory;
  total: number;
  items: ImportIssue[];
}

export function DesignImportDialog({
  file,
  existing,
  close,
  locate,
}: {
  file?: File;
  existing?: DesignDocument;
  close(): void;
  locate?(pageId: string, nodeId: string): void;
}) {
  const [preview, setPreview] = useState<{
    report: ImportReport;
    summary: ImportSummary;
  }>();
  const reader = useRef<Worker>(undefined);
  const [error, setError] = useState("");
  const [stage, setStage] = useState("正在读取设计文件");
  const [saving, setSaving] = useState(false);
  const [limit, setLimit] = useState(50);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<ImportIssueCategory | "all">("all");
  const [viewMode, setViewMode] = useState<"auto" | "grouped" | "flat">("auto");
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(
    {},
  );
  const savingRef = useRef(false);
  const dismiss = () => {
    if (!savingRef.current) close();
  };
  const modal = useModalDialog(true, dismiss);

  useEffect(() => {
    if (!file) return;
    setPreview(undefined);
    setError("");
    setStage("正在读取设计文件");
    setCategory("all");
    setQuery("");
    setLimit(50);
    setViewMode("auto");
    setExpandedGroups({});
    let worker: Worker | undefined;
    try {
      worker = new Worker(
        new URL("../infrastructure/design-import/worker.ts", import.meta.url),
        { type: "module" },
      );
      reader.current = worker;
      worker.onmessage = ({ data }) => {
        if (data.stage) {
          setStage(data.stage);
          return;
        }
        if (data.error) {
          setError(data.error);
          savingRef.current = false;
          setSaving(false);
        } else if (data.url) {
          worker?.terminate();
          location.assign(data.url);
        } else {
          setPreview(data);
        }
      };
      worker.onerror = () => {
        setError("设计读取器未能完成转换。");
        savingRef.current = false;
        setSaving(false);
        setPreview(undefined);
        worker?.terminate();
      };
      worker.postMessage(file);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    return () => worker?.terminate();
  }, [file]);

  const report = existing?.importReport ?? preview?.report;
  const summary = useMemo(
    () => (existing ? importSummary(existing) : preview?.summary),
    [existing, preview],
  );

  const resolveLabel = (nodeId: string) =>
    summary?.positions.get(nodeId)?.name ??
    summary?.labels?.get(nodeId) ??
    nodeId;

  const categoryCounts = useMemo(() => {
    const counts: Record<ImportIssueCategory, number> = {
      font: 0,
      style: 0,
      component: 0,
      layout: 0,
      other: 0,
    };
    for (const issue of report?.issues ?? []) {
      counts[classifyImportIssue(issue.detail)]++;
    }
    return counts;
  }, [report]);

  const visibleIssues = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const rows = report?.issues ?? [];
    return rows.filter((issue) => {
      if (
        category !== "all" &&
        classifyImportIssue(issue.detail) !== category
      ) {
        return false;
      }
      if (!needle) return true;
      const pos = summary?.positions.get(issue.node);
      const resolved = summary?.labels?.get(issue.node);
      return [
        issue.detail,
        issue.node,
        pos?.name,
        pos?.pageName,
        resolved,
      ].some((value) => value?.toLocaleLowerCase().includes(needle));
    });
  }, [report, query, category, summary]);

  const groupedIssues = useMemo<GroupedIssue[]>(() => {
    const map = new Map<string, GroupedIssue>();
    for (const issue of visibleIssues) {
      const key = groupDetailKey(issue.detail);
      const hit = map.get(key);
      if (hit) {
        hit.total += issueWeight(issue);
        hit.items.push(issue);
      } else {
        map.set(key, {
          key,
          label: key,
          category: classifyImportIssue(issue.detail),
          total: issueWeight(issue),
          items: [issue],
        });
      }
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [visibleIssues]);

  const effectiveMode: "grouped" | "flat" =
    viewMode !== "auto"
      ? viewMode
      : (report?.issues.length ?? 0) > 25 && !existing
        ? "grouped"
        : "flat";

  function commit() {
    if (!preview || savingRef.current || !reader.current) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    reader.current.postMessage("save");
  }

  function renderNodeTag(issue: ImportIssue) {
    const pos = summary?.positions.get(issue.node);
    const label = resolveLabel(issue.node);
    if (existing && locate && pos) {
      return (
        <button
          type="button"
          className="design-import-locate"
          data-tip={pos.pageName ? `定位到 ${pos.pageName}` : "在画布中定位"}
          onClick={() => locate(pos.page, issue.node)}
        >
          <LocateFixed size={12} />
          <span className="truncate">
            <SourceName name={label} />
          </span>
          {pos.pageName && (
            <small className="design-import-page-tag">
              <SourceName name={pos.pageName} />
            </small>
          )}
        </button>
      );
    }
    return (
      <b className="design-import-target">
        <SourceName name={label} />
        {pos?.pageName && (
          <small className="design-import-page-tag">
            <SourceName name={pos.pageName} />
          </small>
        )}
      </b>
    );
  }

  const totalIssues = report?.issues.length ?? 0;

  return (
    <div
      className="modal-backdrop"
      onPointerDown={(ev) => {
        if (ev.target === ev.currentTarget) dismiss();
      }}
    >
      <div
        className="file-browser design-import-dialog"
        ref={modal}
        role="dialog"
        aria-label="设计文件导入报告"
        aria-modal="true"
        tabIndex={-1}
      >
        <div className="panel-heading">
          <div className="design-import-heading">
            <strong>{existing ? "导入报告" : "导入设计文件"}</strong>
            {report && (
              <span
                className={`design-import-badge is-${report.format.toLowerCase()}`}
              >
                {report.format}
              </span>
            )}
          </div>
          <button
            className="icon-btn"
            aria-label="关闭导入报告"
            data-tip="关闭"
            data-tip-kbd="Esc"
            onClick={dismiss}
            disabled={saving}
          >
            <X size={15} />
          </button>
        </div>
        <div className="design-import-body">
          <div className="design-import-file">
            <h3 title={report?.filename ?? file?.name}>
              {report?.filename ?? file?.name}
            </h3>
            <p className="design-import-meta">
              {report
                ? `${report.format} · ${report.sourceNodes.toLocaleString()} 个源记录`
                : error
                  ? "解析未完成"
                  : "离线解析中"}
              {file ? ` · ${formatFileSize(file.size)}` : ""}
            </p>
          </div>
          {!report && !error && (
            <div className="design-import-status" role="status">
              <span className="design-import-spinner" aria-hidden="true" />
              <span>{stage}…</span>
            </div>
          )}
          {saving && (
            <div className="design-import-status" role="status">
              <span className="design-import-spinner" aria-hidden="true" />
              <span>正在写入本机工作空间，大文件可能需要数秒…</span>
            </div>
          )}
          {report && summary && (
            <>
              <dl className="design-import-stats">
                {summary.values.map(([key, value]) => (
                  <div key={key} className="design-import-stat">
                    <dt>{key}</dt>
                    <dd>{value.toLocaleString()}</dd>
                  </div>
                ))}
              </dl>
              {totalIssues === 0 ? (
                <div className="design-import-clean">
                  <CheckCircle2 size={15} />
                  <div>
                    <h4>转换检查完成</h4>
                    <p>所有页面、图层、组件与样式均已映射，未发现兼容差异。</p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="design-import-issues-head">
                    <h4>
                      兼容性说明
                      <span className="design-import-count">
                        {totalIssues.toLocaleString()} 条
                      </span>
                    </h4>
                    {totalIssues > 15 && (
                      <div
                        className="design-import-mode"
                        role="group"
                        aria-label="问题显示方式"
                      >
                        <button
                          type="button"
                          aria-pressed={effectiveMode === "grouped"}
                          onClick={() => {
                            setViewMode("grouped");
                            setLimit(50);
                          }}
                        >
                          归类 ({groupedIssues.length})
                        </button>
                        <button
                          type="button"
                          aria-pressed={effectiveMode === "flat"}
                          onClick={() => {
                            setViewMode("flat");
                            setLimit(50);
                          }}
                        >
                          明细
                        </button>
                      </div>
                    )}
                  </div>
                  {totalIssues > 5 && (
                    <div
                      className="design-import-chips"
                      role="group"
                      aria-label="按类别筛选"
                    >
                      <button
                        type="button"
                        className={category === "all" ? "active" : ""}
                        onClick={() => {
                          setCategory("all");
                          setLimit(50);
                        }}
                      >
                        {importIssueCategoryLabels.all}
                        <span>{totalIssues.toLocaleString()}</span>
                      </button>
                      {(
                        [
                          "font",
                          "style",
                          "component",
                          "layout",
                          "other",
                        ] as ImportIssueCategory[]
                      )
                        .filter((key) => categoryCounts[key] > 0)
                        .map((key) => (
                          <button
                            key={key}
                            type="button"
                            className={category === key ? "active" : ""}
                            onClick={() => {
                              setCategory(key);
                              setLimit(50);
                            }}
                          >
                            {importIssueCategoryLabels[key]}
                            <span>{categoryCounts[key].toLocaleString()}</span>
                          </button>
                        ))}
                    </div>
                  )}
                  {totalIssues > 10 && (
                    <div className="design-import-search">
                      <Search size={13} aria-hidden="true" />
                      <input
                        type="search"
                        aria-label="筛选导入问题"
                        placeholder="按图层、样式、变量或说明筛选…"
                        value={query}
                        onChange={(event) => {
                          setQuery(event.target.value);
                          setLimit(50);
                        }}
                      />
                      {query && (
                        <button
                          type="button"
                          className="icon-btn icon-btn-sm"
                          aria-label="清空问题筛选"
                          data-tip="清空筛选"
                          onClick={() => {
                            setQuery("");
                            setLimit(50);
                          }}
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                  )}
                  {visibleIssues.length === 0 && (
                    <p className="design-import-empty">没有匹配的问题</p>
                  )}
                  {visibleIssues.length > 0 && effectiveMode === "grouped" && (
                    <ul className="design-import-groups">
                      {groupedIssues.slice(0, limit).map((group) => {
                        const open = !!expandedGroups[group.key];
                        return (
                          <li key={group.key} className="design-import-group">
                            <button
                              type="button"
                              className="design-import-group-toggle"
                              aria-expanded={open}
                              onClick={() =>
                                setExpandedGroups((cur) => ({
                                  ...cur,
                                  [group.key]: !cur[group.key],
                                }))
                              }
                            >
                              {open ? (
                                <ChevronDown size={13} />
                              ) : (
                                <ChevronRight size={13} />
                              )}
                              <span className="design-import-group-label">
                                {group.label}
                              </span>
                              <span className="design-import-group-count">
                                {group.total.toLocaleString()} 处
                              </span>
                            </button>
                            {open && (
                              <ul className="design-import-group-items">
                                {group.items.slice(0, 30).map((issue, idx) => (
                                  <li key={idx}>
                                    {renderNodeTag(issue)}
                                    {issue.detail !== group.label && (
                                      <span className="design-import-detail">
                                        {issue.detail}
                                      </span>
                                    )}
                                  </li>
                                ))}
                                {group.items.length > 30 && (
                                  <li className="design-import-more-note">
                                    还有{" "}
                                    {(group.items.length - 30).toLocaleString()}{" "}
                                    条同类记录，可下载完整 JSON
                                    报告或切换「明细」查看
                                  </li>
                                )}
                              </ul>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {visibleIssues.length > 0 && effectiveMode === "flat" && (
                    <ul className="design-import-list">
                      {visibleIssues.slice(0, limit).map((issue, i) => (
                        <li key={i}>
                          {renderNodeTag(issue)}
                          <span className="design-import-detail">
                            {issue.detail}
                            {issue.count && issue.count > 1
                              ? " × " + issue.count.toLocaleString()
                              : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {effectiveMode === "flat" && visibleIssues.length > limit && (
                    <button
                      type="button"
                      className="design-import-more"
                      onClick={() => setLimit(limit + 50)}
                    >
                      显示更多（剩余{" "}
                      {(visibleIssues.length - limit).toLocaleString()}）
                    </button>
                  )}
                  {effectiveMode === "grouped" &&
                    groupedIssues.length > limit && (
                      <button
                        type="button"
                        className="design-import-more"
                        onClick={() => setLimit(limit + 50)}
                      >
                        显示更多分类（剩余{" "}
                        {(groupedIssues.length - limit).toLocaleString()}）
                      </button>
                    )}
                </>
              )}
            </>
          )}
          {error && (
            <div className="design-import-error" role="alert">
              <AlertCircle size={15} aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}
        </div>
        <div className="design-import-actions">
          {report && (
            <button
              className="icon-btn"
              data-tip="下载导入报告"
              data-tip-desc="保存完整兼容性诊断 JSON 以便核对"
              aria-label="下载导入报告"
              onClick={() =>
                download(
                  report.filename + ".import.json",
                  JSON.stringify(report, null, 2),
                )
              }
            >
              <Download size={15} />
            </button>
          )}
          <button type="button" onClick={dismiss} disabled={saving}>
            {existing ? "关闭" : "取消"}
          </button>
          {!existing && (
            <button
              type="button"
              className="primary"
              disabled={!preview || saving}
              onClick={() => void commit()}
            >
              {saving ? "正在保存…" : "导入为新文件"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
