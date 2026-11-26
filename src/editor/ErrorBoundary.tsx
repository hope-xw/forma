import { Component, type ErrorInfo, type ReactNode } from "react";
import type { DesignDocument } from "../domain/document";
import { nativeDocumentBlob } from "../infrastructure/native-document";
import { download } from "../infrastructure/storage";

export interface ErrorBoundaryProps {
  scope: "workspace" | "panel" | "modal";
  title?: string;
  resetKey?: string | number;
  getRecoveryDocument?: () => DesignDocument | null;
  onReset?: () => void;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  backupStatus: string;
}

const fallbackCopy = {
  workspace: {
    title: "画布视图遇到意外错误",
    body: "你的设计文件依然安全。可以尝试重新加载视图，或先立即导出本地备份。",
  },
  panel: {
    title: "此面板加载异常",
    body: "不会影响画布中的设计内容，可尝试重新加载此面板。",
  },
  modal: {
    title: "窗口暂时无法显示",
    body: "你可以重试或关闭此窗口继续编辑画布。",
  },
};

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null, backupStatus: "" };

  static getDerivedStateFromError(cause: unknown): ErrorBoundaryState {
    return {
      error: cause instanceof Error ? cause : new Error(String(cause)),
      backupStatus: "",
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Forma (${this.props.scope})`, error, info.componentStack);
  }

  componentDidUpdate(
    previous: ErrorBoundaryProps,
    previousState: ErrorBoundaryState,
  ) {
    if (
      previousState.error &&
      this.state.error &&
      previous.resetKey !== this.props.resetKey
    ) {
      this.setState({ error: null, backupStatus: "" });
    }
  }

  private retry = () => {
    this.setState({ error: null, backupStatus: "" });
    this.props.onReset?.();
  };

  private exportBackup = () => {
    try {
      const document = this.props.getRecoveryDocument?.();
      if (!document) {
        this.setState({ backupStatus: "暂时没有可导出的设计文件" });
        return;
      }
      const slug = document.name
        .trim()
        .replace(/[^\p{L}\p{N}_-]+/gu, "-")
        .replace(/^-|-$/g, "");
      download(
        `${slug || "forma-recovery"}.forma.json`,
        nativeDocumentBlob(document),
      );
      this.setState({ backupStatus: "已导出恢复备份文件" });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      this.setState({ backupStatus: `无法导出设计备份：${detail}` });
    }
  };

  render() {
    const { scope, title, getRecoveryDocument, children } = this.props;
    const { error, backupStatus } = this.state;
    if (!error) return children;
    const copy = fallbackCopy[scope];
    return (
      <section role="alert" className={`forma-error-boundary is-${scope}`}>
        <h2>{title ?? copy.title}</h2>
        <p>{copy.body}</p>
        <div className="forma-error-actions">
          <button type="button" className="primary" onClick={this.retry}>
            重新加载
          </button>
          {getRecoveryDocument && (
            <button type="button" onClick={this.exportBackup}>
              导出设计备份
            </button>
          )}
        </div>
        {backupStatus && <p role="status">{backupStatus}</p>}
        <details className="forma-error-details">
          <summary>查看错误详情</summary>
          <pre>{error.message}</pre>
        </details>
      </section>
    );
  }
}
