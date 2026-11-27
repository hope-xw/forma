import { lazy, Suspense, useEffect, useState } from "react";
import { Cable, Plus, X } from "lucide-react";
import { loadFonts } from "../infrastructure/font-import";
import { readNativeDocument } from "../infrastructure/native-document";
import {
  fetchAgentStatus,
  hasConfiguredAgentHint,
  type AgentStatusResponse,
} from "./agent-client";
import { compactModelLabel } from "./agent/agent-copy";
import { ErrorBoundary } from "./ErrorBoundary";
import { createBrowserFile, newDesignFile } from "./file-actions";
import {
  createDesignTab,
  createDocumentTab,
  type OpenFileTab,
} from "./FileBrowser";
import { useModalDialog } from "./useModalDialog";
import { WorkspaceHome, type WorkspaceHomeProps } from "./WorkspaceHome";

export interface WorkspaceHomeShellProps {
  onOpenFileTab?: OpenFileTab;
  onOpenExampleTab?: WorkspaceHomeProps["onOpenExampleTab"];
  openFileKeys?: ReadonlySet<string>;
}

const ModelConfigModal = lazy(() =>
  import("./ModelConfigModal").then((m) => ({ default: m.ModelConfigModal })),
);
const ReleaseNotesDialog = lazy(() =>
  import("./ReleaseNotesDialog").then((m) => ({
    default: m.ReleaseNotesDialog,
  })),
);

function HomeIntegrationsGuideDialog({
  open,
  onClose,
  onOpenFileTab,
}: {
  open: boolean;
  onClose(): void;
  onOpenFileTab?: OpenFileTab;
}) {
  const dialogRef = useModalDialog(open, onClose);
  const [creating, setCreating] = useState(false);
  if (!open) return null;
  return (
    <div
      className="agent-config-backdrop agent-integrations-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="agent-config-modal agent-integrations-modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="外部工具集成"
        tabIndex={-1}
      >
        <header className="agent-config-head">
          <div className="agent-config-title-wrap">
            <span className="agent-config-icon-ring">
              <Cable size={15} />
            </span>
            <h2>外部工具集成（MCP）</h2>
          </div>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="关闭外部工具集成"
            data-tip="关闭"
            data-tip-kbd="Esc"
            data-tip-side="bottom"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </header>
        <div className="agent-config-body">
          <section>
            <h3>在打开的设计文件中配对外部 Agent</h3>
            <p>
              外部工具集成（MCP）用于将 Claude Code、Codex 或 Cursor
              连接到具体画布，读写当前图层结构并发送可预览提案。请在任意设计文件内通过左上角「Forma
              菜单 → 外部工具集成（MCP）…」生成配对密钥。
            </p>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button
                type="button"
                className="primary"
                disabled={creating}
                onClick={() => {
                  setCreating(true);
                  const create = onOpenFileTab
                    ? createDesignTab(onOpenFileTab, "blank").then(onClose)
                    : newDesignFile({ preset: "blank" });
                  void create.catch(() => setCreating(false));
                }}
              >
                <Plus size={14} />
                新建设计并进入画布
              </button>
              <button type="button" onClick={onClose}>
                返回工作台
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

export function WorkspaceHomeShell({
  onOpenFileTab,
  onOpenExampleTab,
  openFileKeys,
}: WorkspaceHomeShellProps = {}) {
  const [agentStatus, setAgentStatus] = useState<AgentStatusResponse | null>(
    null,
  );
  const [modelConfigOpen, setModelConfigOpen] = useState(false);
  const [integrationsOpen, setIntegrationsOpen] = useState(false);
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const appVersion = window.formaDesktop?.version || __FORMA_VERSION__;

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void (async () => {
      let shouldHydrate = hasConfiguredAgentHint();
      if (!shouldHydrate && window.formaDesktop?.hasConfiguredAgent) {
        try {
          shouldHydrate = await window.formaDesktop.hasConfiguredAgent();
        } catch {
          shouldHydrate = false;
        }
      }
      if (!shouldHydrate || !active) return;
      try {
        const status = await fetchAgentStatus(controller.signal);
        if (active) setAgentStatus(status);
      } catch {
        /* Keep home usable when local agent service is offline. */
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  const agentConnectedLabel =
    agentStatus?.configured && agentStatus.activeProfile
      ? compactModelLabel(agentStatus.activeProfile.selectedModel)
      : null;

  return (
    <>
      <WorkspaceHome
        onOpenFileTab={onOpenFileTab}
        onOpenExampleTab={onOpenExampleTab}
        openFileKeys={openFileKeys}
        agentConnectedLabel={agentConnectedLabel}
        onOpenModelConfig={() => setModelConfigOpen(true)}
        onOpenIntegrations={() => setIntegrationsOpen(true)}
        onOpenReleaseNotes={() => setReleaseNotesOpen(true)}
        onOpenNativeFile={async (file, projectId) => {
          const doc = await readNativeDocument(file);
          await loadFonts(doc.fonts);
          if (onOpenFileTab)
            await createDocumentTab(onOpenFileTab, doc, projectId);
          else location.assign(await createBrowserFile(doc, projectId));
        }}
      />
      {modelConfigOpen && (
        <ErrorBoundary
          scope="modal"
          title="模型配置窗口异常"
          onReset={() => setModelConfigOpen(false)}
        >
          <Suspense
            fallback={
              <div role="status" className="toast">
                加载模型配置…
              </div>
            }
          >
            <ModelConfigModal
              open={modelConfigOpen}
              onClose={() => setModelConfigOpen(false)}
              status={agentStatus}
              onStatusChange={setAgentStatus}
            />
          </Suspense>
        </ErrorBoundary>
      )}
      {integrationsOpen && (
        <HomeIntegrationsGuideDialog
          open={integrationsOpen}
          onOpenFileTab={onOpenFileTab}
          onClose={() => setIntegrationsOpen(false)}
        />
      )}
      {releaseNotesOpen && (
        <ErrorBoundary
          scope="modal"
          title="版本日志加载异常"
          onReset={() => setReleaseNotesOpen(false)}
        >
          <Suspense
            fallback={
              <div role="status" className="toast">
                加载版本日志…
              </div>
            }
          >
            <ReleaseNotesDialog
              version={appVersion}
              close={() => setReleaseNotesOpen(false)}
            />
          </Suspense>
        </ErrorBoundary>
      )}
    </>
  );
}
