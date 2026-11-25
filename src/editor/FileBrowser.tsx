import { readNativeDocument } from "../infrastructure/native-document";
import { preferredProfile } from "./ColorProfileDialog";
import { useEffect, useRef, useState } from "react";
import {
  File,
  FilePlus2,
  Copy,
  LayoutGrid,
  List,
  Pencil,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  readLocalDocument,
  readLocalPreview,
  cachedRecentFiles,
  createLocalFile,
  deleteLocalFile,
  fileUrl,
  recentFiles,
  renameLocalFile,
  type FileSummary,
} from "../infrastructure/storage";
import { createStarter } from "../domain/seed";
import { exportNodeToSvg } from "../infrastructure/static-export";
import { cloneDocument, type DesignDocument } from "../domain/document";
import { useModalDialog } from "./useModalDialog";

import {
  acceptedDesignFiles,
  isExternalDesign,
  checkDesignFileSize,
} from "../infrastructure/design-import/types";
export async function newBlankFile() {
  const doc = createStarter();
  doc.colorProfile = preferredProfile();
  doc.name = "无标题设计";
  doc.nodes = [];
  doc.revision = 0;
  location.assign(await createLocalFile(doc));
}

function FileThumbnail({
  file,
  current,
}: {
  file: FileSummary;
  current?: DesignDocument;
}) {
  const holder = useRef<HTMLButtonElement>(null);
  const [src, setSrc] = useState("");
  useEffect(() => {
    let active = true;
    let url = "";
    setSrc("");
    const load = async () => {
      const doc = current ?? (await readLocalPreview(file.key));
      if (!active || !doc) return;
      const root =
        doc.nodes.find((n) => !n.parentId && !n.hidden && n.type === "frame") ??
        doc.nodes.find((n) => !n.parentId && !n.hidden);
      if (!root) return;
      const svg = exportNodeToSvg(doc, root.id);
      url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      setSrc(url);
    };
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      void load().catch(() => {
        /* A file can still be opened when its preview is unavailable. */
      });
    });
    observer.observe(holder.current!);
    return () => {
      active = false;
      observer.disconnect();
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.key, file.updatedAt, current]);
  return (
    <button
      ref={holder}
      className="file-card-thumb"
      aria-label={`打开 ${file.name}`}
      data-tip="打开设计文件"
      onClick={() => location.assign(fileUrl(file.key))}
    >
      {src ? <img alt="" src={src} /> : <File size={26} strokeWidth={1.4} />}
    </button>
  );
}
export function FileBrowser({
  close,
  currentKey,
  current,
  renameCurrent,
  externalImport,
}: {
  close(): void;
  currentKey: string;
  current: DesignDocument;
  renameCurrent(name: string): void;
  externalImport(file: File): void;
}) {
  const ref = useModalDialog(true, close),
    input = useRef<HTMLInputElement>(null),
    searchRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<FileSummary[]>(cachedRecentFiles),
    [query, search] = useState(""),
    [view, setView] = useState<"grid" | "list">("grid"),
    [renaming, setRenaming] = useState<string | null>(null),
    [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    recentFiles()
      .then((f) => {
        if (active) setFiles(f);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      });
    requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      active = false;
    };
  }, []);

  const filtered = files.filter((f) =>
    f.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  const removeFile = async (key: string) => {
    try {
      await deleteLocalFile(key);
      if (key === currentKey) {
        const remaining = files.find((f) => f.key !== key);
        if (remaining) location.replace(fileUrl(remaining.key));
        else await newBlankFile();
        return;
      }
      setFiles((cur) => cur.filter((f) => f.key !== key));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const commitRename = async (key: string, nextName: string) => {
    const trimmed = nextName.trim();
    setRenaming(null);
    if (!trimmed || files.find((f) => f.key === key)?.name === trimmed) return;
    try {
      if (key === currentKey) renameCurrent(trimmed);
      else await renameLocalFile(key, trimmed);
      setFiles((cur) =>
        cur.map((f) => (f.key === key ? { ...f, name: trimmed } : f)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  async function duplicateFile(f: FileSummary) {
    try {
      const original =
        f.key === currentKey ? current : await readLocalDocument(f.key);
      if (!original) throw new Error("文件已移除");
      const copy = cloneDocument(original);
      copy.id = crypto.randomUUID();
      copy.revision = 0;
      copy.name = original.name.slice(0, 116) + " 副本";
      for (const library of Object.values(copy.libraries ?? {}))
        for (const component of library.components)
          if (component.master?.documentId === original.id)
            component.master.documentId = copy.id;
      await createLocalFile(copy);
      setFiles(await recentFiles());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  const duplicateButton = (f: FileSummary) => (
    <button
      className="icon-btn icon-btn-sm"
      aria-label={`复制 ${f.name}`}
      data-tip="创建独立副本"
      onClick={() => void duplicateFile(f)}
    >
      <Copy size={12} />
    </button>
  );
  const renameInput = (f: FileSummary) => (
    <input
      autoFocus
      aria-label="重命名文件"
      data-escape-local
      defaultValue={f.name}
      maxLength={120}
      onFocus={(ev) => ev.currentTarget.select()}
      onBlur={(ev) => void commitRename(f.key, ev.target.value)}
      onKeyDown={(ev) => {
        if (ev.nativeEvent.isComposing) return;
        if (ev.key === "Enter") ev.currentTarget.blur();
        if (ev.key === "Escape") {
          ev.preventDefault();
          ev.currentTarget.value = f.name;
          ev.currentTarget.blur();
        }
      }}
    />
  );
  return (
    <div
      className="modal-backdrop"
      onPointerDown={(ev) => {
        if (ev.target === ev.currentTarget) close();
      }}
    >
      <div
        className="file-browser file-browser-wide"
        role="dialog"
        aria-modal="true"
        aria-label="本机文件"
        tabIndex={-1}
        ref={ref}
      >
        <div className="panel-heading">
          <strong>本机文件</strong>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <button
              className="icon-btn icon-btn-sm"
              aria-label="网格视图"
              data-tip="网格视图"
              aria-pressed={view === "grid"}
              onClick={() => setView("grid")}
            >
              <LayoutGrid size={14} />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              aria-label="列表视图"
              data-tip="列表视图"
              aria-pressed={view === "list"}
              onClick={() => setView("list")}
            >
              <List size={14} />
            </button>
            <span className="toolbar-sep" aria-hidden="true" />
            <button
              className="icon-btn icon-btn-sm"
              title="导入为独立文件"
              aria-label="导入为独立文件"
              data-tip="导入为独立文件"
              data-tip-desc="从 Forma、Sketch 或 Figma 原生文件创建本机副本"
              data-tip-side="bottom"
              onClick={() => input.current?.click()}
            >
              <Upload size={15} />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              title="新建设计文件"
              aria-label="新建设计文件"
              data-tip="新建设计文件"
              data-tip-desc="创建一个空白设计文件并立即切换"
              data-tip-side="bottom"
              onClick={() =>
                newBlankFile().catch((err) =>
                  setError(err instanceof Error ? err.message : String(err)),
                )
              }
            >
              <FilePlus2 size={16} />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              aria-label="关闭本机文件"
              data-tip="关闭本机文件"
              data-tip-kbd="Esc"
              data-tip-side="bottom"
              onClick={close}
            >
              <X size={16} />
            </button>
          </div>
        </div>
        <label className="search">
          <Search size={14} />
          <input
            ref={searchRef}
            aria-label="搜索文件"
            placeholder="搜索本机设计文件…"
            value={query}
            onChange={(ev) => search(ev.target.value)}
          />
          {query && (
            <button
              type="button"
              className="icon-btn icon-btn-sm"
              aria-label="清空搜索"
              data-tip="清空搜索"
              onClick={() => search("")}
            >
              <X size={12} />
            </button>
          )}
        </label>
        {!filtered.length ? (
          <p className="compact-empty" role="status">
            {query ? "未找到匹配的本机文件" : "暂无已保存的本机文件"}
          </p>
        ) : view === "grid" ? (
          <div className="recent-files file-grid">
            {filtered.map((f) => (
              <div className="file-card" key={f.key}>
                <FileThumbnail
                  file={f}
                  current={f.key === currentKey ? current : undefined}
                />
                <div className="file-card-meta">
                  {renaming === f.key ? (
                    renameInput(f)
                  ) : (
                    <a href={fileUrl(f.key)} title={f.name}>
                      {f.name}
                    </a>
                  )}
                  <button
                    type="button"
                    className="icon-btn icon-btn-sm"
                    aria-label={`重命名 ${f.name}`}
                    data-tip="重命名文件"
                    onClick={() => setRenaming(f.key)}
                  >
                    <Pencil size={12} />
                  </button>
                  {duplicateButton(f)}
                  <button
                    type="button"
                    className="icon-btn icon-btn-sm"
                    aria-label={`删除 ${f.name}`}
                    data-tip="删除文件"
                    onClick={() => void removeFile(f.key)}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
                <div
                  style={{
                    padding: "0 10px 8px",
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 10,
                    color: "var(--text-muted)",
                  }}
                >
                  <span>{f.pages} 页</span>
                  <time>
                    {f.updatedAt
                      ? new Date(f.updatedAt).toLocaleString([], {
                          month: "numeric",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : ""}
                  </time>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="recent-files">
            {filtered.map((f) => (
              <div
                key={f.key}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  paddingRight: 8,
                }}
              >
                {renaming === f.key ? (
                  renameInput(f)
                ) : (
                  <a href={fileUrl(f.key)} style={{ flex: 1, minWidth: 0 }}>
                    <File size={15} />
                    <span className="truncate">{f.name}</span>
                    <small>{f.pages} 页</small>
                    <time>
                      {f.updatedAt
                        ? new Date(f.updatedAt).toLocaleDateString()
                        : null}
                    </time>
                  </a>
                )}
                <button
                  type="button"
                  className="icon-btn icon-btn-sm"
                  aria-label={`重命名 ${f.name}`}
                  data-tip="重命名文件"
                  onClick={() => setRenaming(f.key)}
                >
                  <Pencil size={12} />
                </button>
                {duplicateButton(f)}
                <button
                  type="button"
                  className="icon-btn icon-btn-sm"
                  aria-label={`删除 ${f.name}`}
                  data-tip="删除文件"
                  onClick={() => void removeFile(f.key)}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {error && <p role="alert">{error}</p>}
        <input
          type="file"
          hidden
          ref={input}
          data-testid="browser-design-file-input"
          accept={acceptedDesignFiles}
          onChange={async (ev) => {
            const file = ev.target.files?.[0];
            ev.target.value = "";
            if (!file) return;
            try {
              const external = await isExternalDesign(file);
              checkDesignFileSize(file.size, external);
              if (external) {
                externalImport(file);
                return;
              }
              location.assign(
                await createLocalFile(await readNativeDocument(file)),
              );
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
        />
      </div>
    </div>
  );
}
