import { useEffect, useMemo, useRef, useState } from "react";
import { zipSync, strToU8 } from "fflate";
import {
  Download,
  FolderArchive,
  Image as ImageIcon,
  Minus,
  Plus,
  Scissors,
  X,
} from "lucide-react";
import type {
  DesignDocument,
  DesignNode,
  ExportSetting,
} from "../domain/document";
import { layoutBounds } from "../domain/geometry";
import { isLocked } from "../domain/tree";
import {
  exportNodeAsRaster,
  exportNodeToSvg,
} from "../infrastructure/static-export";
import {
  collectExportTargets,
  exportTargetZip,
} from "../infrastructure/batch-export";
import { useModalDialog } from "./useModalDialog";
import "./figma-panels.css";

export interface ExportPanelProps {
  document: DesignDocument;
  node: DesignNode;
  previewBlocked?: boolean;
  onUpdateSettings(settings: NonNullable<DesignNode["exportSettings"]>): void;
  onOpenBatchExport?(): void;
}

export interface BatchExportModalProps {
  open: boolean;
  document: DesignDocument;
  onClose(): void;
}

const SCALE_OPTIONS = [0.5, 1, 1.5, 2, 3, 4] as const;
const MAX_EXPORT_ROWS = 16;

function safeFileStem(name: string): string {
  return (
    name
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .trim()
      .replace(/[. ]+$/, "") || "Forma"
  );
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = window.document.createElement("a");
  a.href = url;
  a.download = filename;
  try {
    a.click();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function nextPresetFor(existing: ExportSetting[]): ExportSetting {
  const has2x = existing.some((s) => s.scale === 2 && s.format === "png");
  const has3x = existing.some((s) => s.scale === 3 && s.format === "png");
  const hasSvg = existing.some((s) => s.format === "svg");
  if (!has2x) {
    return {
      id: crypto.randomUUID(),
      format: "png",
      scale: 2,
      suffix: "@2x",
    };
  }
  if (!has3x) {
    return {
      id: crypto.randomUUID(),
      format: "png",
      scale: 3,
      suffix: "@3x",
    };
  }
  if (!hasSvg) {
    return {
      id: crypto.randomUUID(),
      format: "svg",
      scale: 1,
      suffix: "",
    };
  }
  return {
    id: crypto.randomUUID(),
    format: "png",
    scale: 1,
    suffix: "",
  };
}

function exportFilename(nodeName: string, setting: ExportSetting): string {
  const stem = safeFileStem(nodeName);
  const cleanSuffix = setting.suffix
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .trim();
  if (cleanSuffix) return `${stem}${cleanSuffix}.${setting.format}`;
  return `${stem}@${setting.scale}x.${setting.format}`;
}

function ExportSuffix({
  label,
  suffix,
  disabled,
  commit,
}: {
  label: string;
  suffix: string;
  disabled: boolean;
  commit(value: string): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  useEffect(() => {
    setDraft(null);
  }, [suffix, disabled]);
  return (
    <input
      type="text"
      aria-label={label}
      placeholder="后缀 (如 @2x)"
      disabled={disabled}
      maxLength={64}
      value={draft ?? suffix}
      onChange={(ev) => setDraft(ev.currentTarget.value.slice(0, 64))}
      onKeyDown={(ev) => {
        if (ev.nativeEvent.isComposing) return;
        if (ev.key === "Escape" || ev.key === "Enter") {
          ev.preventDefault();
          ev.stopPropagation();
          cancelled.current = ev.key === "Escape";
          ev.currentTarget.blur();
        }
      }}
      onBlur={() => {
        if (
          !cancelled.current &&
          !disabled &&
          draft !== null &&
          draft !== suffix
        )
          commit(draft);
        cancelled.current = false;
        setDraft(null);
      }}
    />
  );
}

export function ExportPanel({
  document,
  node,
  previewBlocked = false,
  onUpdateSettings,
  onOpenBatchExport,
}: ExportPanelProps) {
  const fallbackRow = useMemo<ExportSetting>(
    () => ({
      id: crypto.randomUUID(),
      format: "png",
      scale: 1,
      suffix: "",
    }),
    [document.id, node.id],
  );
  const [previewOpen, setPreviewOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [localBatchOpen, setLocalBatchOpen] = useState(false);

  const layerLocked = useMemo(
    () => isLocked(document, node.id),
    [document, node.id],
  );
  const locked = previewBlocked || layerLocked;
  const hasSavedSettings = (node.exportSettings?.length ?? 0) > 0;
  const rows: ExportSetting[] = hasSavedSettings
    ? node.exportSettings!
    : [fallbackRow];

  const primaryRow = rows[0] ?? fallbackRow;

  // Live SVG preview (computed only when collapsible preview is open)
  const previewSvg = useMemo(() => {
    if (!previewOpen) return null;
    try {
      return exportNodeToSvg(document, node.id, 1);
    } catch {
      return null;
    }
  }, [previewOpen, document, node.id]);

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!previewSvg) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(
      new Blob([previewSvg], { type: "image/svg+xml;charset=utf-8" }),
    );
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [previewSvg]);

  const nodeBox = useMemo(() => {
    const box = layoutBounds(document).get(node.id);
    return {
      width: Math.round(box?.width ?? node.style.width),
      height: Math.round(box?.height ?? node.style.height),
    };
  }, [document, node.id, node.style.width, node.style.height]);

  const updateRow = (index: number, patch: Partial<ExportSetting>) => {
    if (locked) return;
    setError("");
    const next = rows.map((row, i) =>
      i === index ? { ...row, ...patch } : row,
    );
    onUpdateSettings(next);
  };

  const addRow = () => {
    if (locked || rows.length >= MAX_EXPORT_ROWS) return;
    setError("");
    onUpdateSettings([...rows, nextPresetFor(rows)]);
  };

  const removeRow = (index: number) => {
    if (locked || !hasSavedSettings) return;
    setError("");
    const next = rows.filter((_, i) => i !== index);
    onUpdateSettings(next);
  };

  const handleExport = async () => {
    setExporting(true);
    setError("");
    try {
      if (rows.length === 1) {
        const setting = rows[0]!;
        const blob =
          setting.format === "svg"
            ? new Blob([exportNodeToSvg(document, node.id, setting.scale)], {
                type: "image/svg+xml;charset=utf-8",
              })
            : await exportNodeAsRaster(document, node.id, {
                format: setting.format,
                scale: setting.scale,
              });
        triggerDownload(blob, exportFilename(node.name, setting));
      } else {
        const entries: Record<string, Uint8Array> = {};
        const used = new Set<string>();
        for (const setting of rows) {
          let filename = exportFilename(node.name, setting);
          if (used.has(filename)) {
            const dot = filename.lastIndexOf(".");
            const stem = dot >= 0 ? filename.slice(0, dot) : filename;
            const ext = dot >= 0 ? filename.slice(dot) : "";
            let n = 2;
            while (used.has(`${stem}-${n}${ext}`)) n++;
            filename = `${stem}-${n}${ext}`;
          }
          used.add(filename);
          if (setting.format === "svg") {
            entries[filename] = strToU8(
              exportNodeToSvg(document, node.id, setting.scale),
            );
          } else {
            const blob = await exportNodeAsRaster(document, node.id, {
              format: setting.format,
              scale: setting.scale,
            });
            entries[filename] = new Uint8Array(await blob.arrayBuffer());
          }
        }
        const zipped = zipSync(entries, { level: 6 });
        const zipCopy = new Uint8Array(zipped.byteLength);
        zipCopy.set(zipped);
        triggerDownload(
          new Blob([zipCopy], { type: "application/zip" }),
          `${safeFileStem(node.name)}-exports.zip`,
        );
      }
    } catch (err) {
      setError(
        `导出素材失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setExporting(false);
    }
  };

  const handleOpenBatch = () => {
    if (onOpenBatchExport) onOpenBatchExport();
    else setLocalBatchOpen(true);
  };

  return (
    <section className="fp-section fp-export-section" aria-label="导出设置">
      <div className="section-title">
        <span className="fp-section-heading">
          导出
          {hasSavedSettings && rows.length > 1 && (
            <span className="fp-count-pill">{rows.length}</span>
          )}
        </span>
        <div className="section-actions">
          <button
            type="button"
            className={`icon-btn icon-btn-sm ${previewOpen ? "active" : ""}`}
            aria-label="切换导出预览"
            aria-expanded={previewOpen}
            title="预览导出效果"
            data-tip="导出预览"
            data-tip-desc={`${Math.max(1, Math.round(nodeBox.width * primaryRow.scale))} × ${Math.max(1, Math.round(nodeBox.height * primaryRow.scale))} px`}
            data-tip-side="left"
            onClick={() => setPreviewOpen((v) => !v)}
          >
            <ImageIcon size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="批量导出切图与切片"
            title="批量导出…"
            data-tip="批量导出全部切图与切片"
            data-tip-kbd="⇧⌘E"
            data-tip-side="left"
            onClick={handleOpenBatch}
          >
            <FolderArchive size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            disabled={locked || rows.length >= MAX_EXPORT_ROWS}
            aria-label="添加导出配置"
            title="添加导出配置"
            data-tip="添加导出配置"
            data-tip-desc={
              locked
                ? "图层已锁定，无法新增持久化导出配置"
                : rows.length >= MAX_EXPORT_ROWS
                  ? `单图层最多配置 ${MAX_EXPORT_ROWS} 组导出规格`
                  : "新增多倍率或多格式导出预设（如 @2x PNG、SVG）"
            }
            data-tip-side="left"
            onClick={addRow}
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      <div className="fp-export-rows">
        {rows.map((row, idx) => {
          const isPrimary = idx === 0;
          return (
            <div key={row.id} className="fp-export-row">
              <select
                aria-label={isPrimary ? "导出倍率" : `导出倍率 ${idx + 1}`}
                disabled={locked}
                value={String(row.scale)}
                onChange={(ev) =>
                  updateRow(idx, { scale: Number(ev.target.value) || 1 })
                }
              >
                {SCALE_OPTIONS.map((s) => (
                  <option key={s} value={String(s)}>
                    {s}x
                  </option>
                ))}
                {!SCALE_OPTIONS.includes(
                  row.scale as (typeof SCALE_OPTIONS)[number],
                ) && <option value={String(row.scale)}>{row.scale}x</option>}
              </select>

              <ExportSuffix
                label={isPrimary ? "导出后缀" : `导出后缀 ${idx + 1}`}
                suffix={row.suffix}
                disabled={locked}
                commit={(suffix) => updateRow(idx, { suffix })}
              />

              <select
                aria-label={isPrimary ? "导出格式" : `导出格式 ${idx + 1}`}
                disabled={locked}
                value={row.format}
                onChange={(ev) =>
                  updateRow(idx, {
                    format: ev.target.value as ExportSetting["format"],
                  })
                }
              >
                <option value="png">PNG</option>
                <option value="jpeg">JPG</option>
                <option value="webp">WebP</option>
                <option value="svg">SVG</option>
              </select>

              <button
                type="button"
                className="icon-btn icon-btn-sm"
                disabled={locked || !hasSavedSettings}
                aria-label={
                  isPrimary ? "移除导出配置" : `移除导出配置 ${idx + 1}`
                }
                title="移除导出配置"
                data-tip="移除导出配置"
                data-tip-desc={
                  !hasSavedSettings
                    ? "默认单次导出行不可删除"
                    : "移除此条导出规格"
                }
                data-tip-side="left"
                onClick={() => removeRow(idx)}
              >
                <Minus size={13} />
              </button>
            </div>
          );
        })}
      </div>

      {previewOpen && (
        <div className="fp-export-preview-box">
          <div className="fp-export-preview-stage">
            {previewUrl ? (
              <img src={previewUrl} alt={`${node.name} 导出预览`} />
            ) : (
              <span className="fp-empty-inline">无法生成预览</span>
            )}
          </div>
          <div className="fp-export-preview-meta">
            <span className="truncate">
              {exportFilename(node.name, primaryRow)}
            </span>
            <span>
              {primaryRow.format.toUpperCase()} @{primaryRow.scale}x ·{" "}
              {Math.max(1, Math.round(nodeBox.width * primaryRow.scale))}×
              {Math.max(1, Math.round(nodeBox.height * primaryRow.scale))}
            </span>
          </div>
        </div>
      )}

      <button
        type="button"
        className="fp-export-primary-btn"
        aria-label="导出所选图层"
        title="导出所选图层"
        data-tip="导出所选图层"
        data-tip-desc={
          rows.length > 1
            ? `将 ${rows.length} 组导出规格打包为 ZIP 下载`
            : `按 ${primaryRow.format.toUpperCase()} @${primaryRow.scale}x 下载当前图层`
        }
        data-tip-side="top"
        disabled={exporting}
        onClick={() => void handleExport()}
      >
        <Download size={13} aria-hidden="true" />
        {exporting
          ? "正在导出…"
          : rows.length > 1
            ? `导出 ${node.name} (${rows.length} 项 ZIP)`
            : `导出 ${node.name}`}
      </button>

      {error && (
        <div className="fp-export-error" role="alert">
          {error}
        </div>
      )}

      {!onOpenBatchExport && (
        <BatchExportModal
          open={localBatchOpen}
          document={document}
          onClose={() => setLocalBatchOpen(false)}
        />
      )}
    </section>
  );
}

export function BatchExportModal({
  open,
  document,
  onClose,
}: BatchExportModalProps) {
  const dialogRef = useModalDialog(open, onClose, true);
  const targets = useMemo(
    () => (open ? collectExportTargets(document) : []),
    [open, document],
  );

  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setSelectedPaths(new Set(targets.map((t) => t.path)));
      setError("");
    }
  }, [open, targets]);

  if (!open) return null;

  const selectedTargets = targets.filter((t) => selectedPaths.has(t.path));
  const allChecked =
    targets.length > 0 && selectedPaths.size === targets.length;

  const toggleAll = () => {
    if (allChecked) setSelectedPaths(new Set());
    else setSelectedPaths(new Set(targets.map((t) => t.path)));
  };

  const toggleOne = (path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleBatchDownload = async () => {
    if (!selectedTargets.length) return;
    setBusy(true);
    setError("");
    try {
      const bytes = await exportTargetZip(document, selectedTargets);
      const zipCopy = new Uint8Array(bytes.byteLength);
      zipCopy.set(bytes);
      triggerDownload(
        new Blob([zipCopy], { type: "application/zip" }),
        `${safeFileStem(document.name)}-assets.zip`,
      );
      onClose();
    } catch (err) {
      setError(
        `批量导出失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="批量导出素材"
        tabIndex={-1}
        className="fp-modal-dialog"
      >
        <div className="fp-modal-header">
          <div className="fp-panel-title">
            <FolderArchive size={15} aria-hidden="true" />
            <strong>批量导出素材</strong>
            <span className="fp-count-pill">{targets.length}</span>
          </div>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="关闭批量导出"
            title="关闭批量导出"
            data-tip="关闭"
            data-tip-kbd="Esc"
            data-tip-side="left"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>

        {targets.length > 0 && (
          <div className="fp-modal-toolbar">
            <label className="compact-check" style={{ marginTop: 0 }}>
              <input
                type="checkbox"
                checked={allChecked}
                onChange={toggleAll}
              />
              全选（已选 {selectedTargets.length} / {targets.length} 项）
            </label>
            <span>名称含 / 将自动生成子文件夹</span>
          </div>
        )}

        <div className="fp-modal-body">
          {targets.length === 0 ? (
            <div className="fp-empty-state">
              <FolderArchive
                size={24}
                className="fp-empty-state-icon"
                aria-hidden="true"
              />
              <strong>暂无待批量导出的图层或切片</strong>
              <p>
                在右侧「导出」面板为图层点击 + 添加导出配置，或使用切片工具 (S)
                框选需要切图的区域
              </p>
            </div>
          ) : (
            <div className="fp-batch-list">
              {targets.map((target) => {
                const checked = selectedPaths.has(target.path);
                return (
                  <label
                    key={target.path}
                    className={`fp-batch-item ${checked ? "is-selected" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleOne(target.path)}
                    />
                    <div className="fp-batch-item-info">
                      <span className="fp-batch-filename truncate">
                        {target.path}
                      </span>
                      <span className="fp-batch-sub truncate">
                        来源图层：{target.nodeName}
                      </span>
                    </div>
                    <div className="fp-batch-badges">
                      {target.nodeType === "slice" && (
                        <span className="fp-format-badge is-slice">
                          <Scissors size={10} aria-hidden="true" /> 切片
                        </span>
                      )}
                      <span className="fp-format-badge">@{target.scale}x</span>
                      <span className="fp-format-badge">{target.format}</span>
                    </div>
                  </label>
                );
              })}
            </div>
          )}

          {error && (
            <div className="fp-export-error" role="alert">
              {error}
            </div>
          )}
        </div>

        <div className="fp-modal-footer">
          <button type="button" className="fp-scale-exit" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="primary fp-scale-apply"
            style={{ flex: "0 0 auto" }}
            disabled={busy || selectedTargets.length === 0}
            onClick={() => void handleBatchDownload()}
          >
            <Download size={13} aria-hidden="true" />
            {busy ? "正在打包 ZIP…" : `导出 ZIP (${selectedTargets.length} 项)`}
          </button>
        </div>
      </div>
    </div>
  );
}
