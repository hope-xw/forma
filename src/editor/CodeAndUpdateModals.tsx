import { useMemo, useState } from "react";
import { Check, Copy, Download, FileDiff, X } from "lucide-react";
import type { DesignDocument } from "../domain/document";
import { exportInteractiveReact, pageForExport } from "../compiler/runtime";
import { exportTokenFiles } from "../compiler/design-tokens";
import { exportReact } from "../compiler/react";
import { download } from "../infrastructure/storage";
import { applyReactProjectUpdate } from "../infrastructure/export-project";
import type { ProjectRevisionPreview } from "../infrastructure/project-revision";
import { useModalDialog } from "./useModalDialog";

const KW_RE =
  /\b(import|export|from|default|function|return|const|let|var|type|interface|if|else|for|of|in|new|true|false|null|undefined|as|extends|switch|case|break)\b/g;

function highlightLine(line: string, isCss: boolean): React.ReactNode {
  if (/^\s*(\/\/|\/\*|\*)/.test(line)) {
    return <span className="tok-cmt">{line}</span>;
  }
  const tokens: React.ReactNode[] = [];
  const pattern = isCss
    ? /(--[a-zA-Z0-9_-]+)|("[^"]*"|'[^']*')|(#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|rem|em|%|ms|deg)?\b)/g
    : /("[^"]*"|'[^']*'|`[^`]*`)|(\/\/.*$)|(\b(?:import|export|from|default|function|return|const|let|var|type|interface|if|else|for|of|in|new|true|false|null|undefined|as)\b)|(\b\d+(?:\.\d+)?\b)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(line)) !== null) {
    if (match.index > last) tokens.push(line.slice(last, match.index));
    const text = match[0];
    if (isCss) {
      const cls = match[1] ? "tok-kw" : match[2] ? "tok-str" : "tok-num";
      tokens.push(
        <span key={key++} className={cls}>
          {text}
        </span>,
      );
    } else {
      const cls = match[1]
        ? "tok-str"
        : match[2]
          ? "tok-cmt"
          : match[3] || KW_RE.test(text)
            ? "tok-kw"
            : "tok-num";
      KW_RE.lastIndex = 0;
      tokens.push(
        <span key={key++} className={cls}>
          {text}
        </span>,
      );
    }
    last = match.index + text.length;
  }
  if (last < line.length) tokens.push(line.slice(last));
  return tokens.length ? tokens : " ";
}

export function CodePreviewModal({
  doc,
  selection,
  close,
}: {
  doc: DesignDocument;
  selection: string[];
  close: () => void;
}) {
  const ref = useModalDialog(true, close);
  const [activeTab, setActiveTab] = useState<"page" | "tokens" | "static">(
    "page",
  );
  const [copyError, setCopyError] = useState("");
  const [copied, setCopied] = useState(false);

  const files = useMemo(() => {
    const scoped = pageForExport(doc, selection);
    const pageCode = exportInteractiveReact(scoped);
    const tokenFiles = exportTokenFiles(scoped);
    const tokensCss =
      tokenFiles["src/tokens.css"] ??
      Object.values(tokenFiles)[0] ??
      "/* 当前文件暂无导出变量 Token */\n";
    let staticCode = "";
    try {
      staticCode = exportReact(scoped);
    } catch {
      staticCode = "// 静态 JSX 预览不可用\n";
    }
    return {
      page: { filename: "DesignPage.tsx", code: pageCode, isCss: false },
      tokens: { filename: "tokens.css", code: tokensCss, isCss: true },
      static: {
        filename: "StaticComponent.tsx",
        code: staticCode,
        isCss: false,
      },
    };
  }, [doc, selection]);

  const current = files[activeTab];
  const lines = useMemo(() => current.code.split("\n"), [current.code]);

  async function copyCode() {
    setCopyError("");
    try {
      await navigator.clipboard.writeText(current.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopyError("浏览器未允许复制，可以下载当前源码文件。");
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget) close();
      }}
    >
      <div
        ref={ref}
        tabIndex={-1}
        className="code-modal"
        aria-modal="true"
        role="dialog"
        aria-label="React 代码"
      >
        <div className="code-modal-header">
          <div className="code-file-tabs" role="tablist" aria-label="代码文件">
            {(
              [
                ["page", "DesignPage.tsx"],
                ["tokens", "tokens.css"],
                ["static", "StaticComponent.tsx"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                tabIndex={activeTab === key ? 0 : -1}
                onKeyDown={(ev) => {
                  const tabs = Array.from(
                    ev.currentTarget.parentElement!.querySelectorAll("button"),
                  );
                  const i = tabs.indexOf(ev.currentTarget);
                  const next =
                    ev.key === "Home"
                      ? 0
                      : ev.key === "End"
                        ? tabs.length - 1
                        : ev.key === "ArrowLeft"
                          ? (i + tabs.length - 1) % tabs.length
                          : ev.key === "ArrowRight"
                            ? (i + 1) % tabs.length
                            : -1;
                  if (next < 0) return;
                  ev.preventDefault();
                  tabs[next].focus();
                  tabs[next].click();
                }}
                aria-selected={activeTab === key}
                className={activeTab === key ? "active" : ""}
                onClick={() => {
                  setCopyError("");
                  setActiveTab(key);
                  setCopied(false);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="复制当前代码"
            data-tip={copied ? "已复制到剪贴板" : "复制代码"}
            data-tip-side="bottom"
            onClick={() => void copyCode()}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="关闭代码"
            data-tip="关闭代码预览"
            data-tip-kbd="Esc"
            data-tip-side="bottom"
            onClick={close}
          >
            <X size={16} />
          </button>
        </div>
        {copyError && <p role="alert">{copyError}</p>}
        <pre role="tabpanel" aria-label={current.filename}>
          {lines.map((line, i) => (
            <div className="code-line" key={i}>
              <span className="code-ln" aria-hidden="true">
                {i + 1}
              </span>
              <span>{highlightLine(line, current.isCss)}</span>
            </div>
          ))}
        </pre>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            className="primary"
            onClick={() =>
              download(current.filename, current.code, "text/plain")
            }
          >
            <Download size={13} /> 下载源码文件
          </button>
        </div>
      </div>
    </div>
  );
}

export function ProjectUpdateModal({
  doc,
  zipBytes,
  preview,
  close,
  onError,
}: {
  doc: DesignDocument;
  zipBytes: Uint8Array;
  preview: ProjectRevisionPreview;
  close: () => void;
  onError: (message: string) => void;
}) {
  const ref = useModalDialog(true, close);
  const [resolutions, setResolutions] = useState<
    Record<string, "local" | "incoming">
  >({});
  const [busy, setBusy] = useState(false);

  const unresolved = preview.conflicts.filter((c) => !resolutions[c.path]);

  function resolveAll(choice: "local" | "incoming") {
    const next: Record<string, "local" | "incoming"> = {};
    for (const c of preview.conflicts) next[c.path] = choice;
    setResolutions(next);
  }

  async function applyMerge() {
    setBusy(true);
    try {
      await applyReactProjectUpdate(doc, zipBytes, resolutions);
      close();
    } catch (error) {
      onError(String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget) close();
      }}
    >
      <div
        ref={ref}
        tabIndex={-1}
        className="library-update-dialog review-wide"
        role="dialog"
        aria-modal="true"
        aria-label="审阅 React 工程冲突"
      >
        <div className="review-sticky-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <FileDiff size={16} />
            <div>
              <strong style={{ fontSize: 13 }}>React 工程增量更新冲突</strong>
              <div style={{ color: "var(--text-secondary)", marginTop: 2 }}>
                新增 {preview.added.length} · 更新 {preview.modified.length} ·
                保留开发文件 {preview.preserved.length} · 冲突{" "}
                {preview.conflicts.length}
              </div>
            </div>
          </div>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="关闭错误"
            data-tip="关闭"
            data-tip-kbd="Esc"
            onClick={close}
          >
            <X size={16} />
          </button>
        </div>
        <div className="review-scroll-body">
          <p role="alert" style={{ marginTop: 0 }}>
            检测到 {preview.conflicts.length} 处生成文件被本地修改（
            {preview.conflicts.map((c) => c.path).join("、")}
            ）。请为每个冲突文件选择保留本地版本或采用设计新版：
          </p>
          <div
            style={{
              display: "flex",
              gap: 6,
              justifyContent: "flex-end",
              marginBottom: 10,
            }}
          >
            <button type="button" onClick={() => resolveAll("local")}>
              全部保留本地
            </button>
            <button type="button" onClick={() => resolveAll("incoming")}>
              全部采用设计新版
            </button>
          </div>
          {preview.conflicts.map((conflict) => (
            <section
              key={conflict.path}
              style={{
                padding: "10px 0",
                borderTop: "1px solid var(--border-subtle)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <strong style={{ fontFamily: "ui-monospace, monospace" }}>
                  {conflict.path}
                </strong>
                <select
                  aria-label={`解决冲突 ${conflict.path}`}
                  value={resolutions[conflict.path] ?? ""}
                  onChange={(ev) =>
                    setResolutions({
                      ...resolutions,
                      [conflict.path]: ev.target.value as "local" | "incoming",
                    })
                  }
                >
                  <option value="" disabled>
                    选择处理方式
                  </option>
                  <option value="local">保留本地修改</option>
                  <option value="incoming">采用设计新版</option>
                </select>
              </div>
              <div className="conflict-diff-grid">
                <div>
                  <small style={{ color: "var(--text-muted)" }}>
                    本地已有代码
                  </small>
                  <pre className="conflict-diff-pane">
                    {conflict.localContent.slice(0, 2400)}
                  </pre>
                </div>
                <div>
                  <small style={{ color: "var(--text-muted)" }}>
                    设计最新生成
                  </small>
                  <pre className="conflict-diff-pane">
                    {conflict.incomingContent.slice(0, 2400)}
                  </pre>
                </div>
              </div>
            </section>
          ))}
        </div>
        <footer className="review-sticky-footer">
          <button type="button" onClick={close}>
            取消
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || unresolved.length > 0}
            onClick={() => void applyMerge()}
          >
            {busy
              ? "正在生成 ZIP…"
              : unresolved.length > 0
                ? `还有 ${unresolved.length} 处冲突未选择`
                : "合并并下载更新后的 ZIP"}
          </button>
        </footer>
      </div>
    </div>
  );
}
