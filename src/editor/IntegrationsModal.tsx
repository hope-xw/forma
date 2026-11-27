import { useState } from "react";
import { Cable, Download, X } from "lucide-react";
import { validateProposal, type Transaction } from "../agent/provider";
import { extractCreatedRootIds } from "../application/agent-session";
import type { BridgeTabSummary } from "../application/external-bridge";
import type { DesignDocument } from "../domain/document";
import { download } from "../infrastructure/storage";
import type { PendingAgentProposal } from "./CanvasAgentBar";
import {
  ExternalAgentSession,
  type ExternalBridgeSnapshot,
  type ExternalProposalMeta,
} from "./ExternalAgentSession";
import { useModalDialog } from "./useModalDialog";
import "./agent-ui.css";
import "./external-bridge.css";

export type PendingIntegrationProposal = PendingAgentProposal & {
  proposalId?: string;
  taskId?: string;
  bridgeSource?: ExternalProposalMeta["source"];
};

export interface IntegrationsModalProps {
  open: boolean;
  onClose(): void;
  document: DesignDocument;
  selection: string | null;
  scopeProjectId: string;
  fileKey?: string;
  onPendingProposalChange(proposal: PendingIntegrationProposal): void;
  onSessionActiveChange?(active: boolean): void;
  tabs?: BridgeTabSummary[];
  activeTabId?: string | null;
  onAutoApplyTransaction?: (
    tx: Transaction,
    meta: { proposalId?: string; taskId?: string; summary?: string },
  ) => Promise<void> | void;
  onBridgeSnapshotChange?: (snapshot: ExternalBridgeSnapshot) => void;
}

export function IntegrationsModal({
  open,
  onClose,
  document,
  selection,
  scopeProjectId,
  fileKey,
  onPendingProposalChange,
  onSessionActiveChange,
  tabs,
  activeTabId,
  onAutoApplyTransaction,
  onBridgeSnapshotChange,
}: IntegrationsModalProps) {
  const dialog = useModalDialog(open, onClose);

  function preview(
    transaction: Transaction,
    source: "external" | "manual",
    meta?: ExternalProposalMeta,
  ) {
    const label =
      source === "external" ? "来自外部工具的设计方案" : "导入的设计方案";
    onPendingProposalChange({
      transaction,
      source,
      scopeProjectId,
      reply: "",
      summary:
        meta?.summary ?? `${label}（${transaction.operations.length} 项改动）`,
      createdRootIds: extractCreatedRootIds(transaction),
      proposalId: meta?.proposalId,
      taskId: meta?.taskId,
      bridgeSource: meta?.source,
    });
  }

  return (
    <div
      className="agent-config-backdrop agent-integrations-backdrop"
      hidden={!open}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="agent-config-modal agent-integrations-modal bridge-modal"
        ref={dialog}
        role="dialog"
        aria-modal={open || undefined}
        aria-label="外部工具集成"
        tabIndex={-1}
      >
        <header className="agent-config-head">
          <div className="agent-config-title-wrap">
            <span className="agent-config-icon-ring">
              <Cable size={15} />
            </span>
            <h2>外部工具集成（MCP &amp; A2A）</h2>
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
          <ExternalAgentSession
            document={document}
            selection={selection}
            tabs={tabs}
            activeTabId={activeTabId}
            receive={(tx, meta) => {
              if (meta?.autoApply && onAutoApplyTransaction)
                return onAutoApplyTransaction(tx, meta);
              preview(tx, "external", meta);
            }}
            onSessionActiveChange={onSessionActiveChange}
            onBridgeSnapshotChange={onBridgeSnapshotChange}
          />
          <ManualImport
            key={JSON.stringify([
              fileKey,
              document.id,
              document.activePage,
              scopeProjectId,
            ])}
            document={document}
            selection={selection}
            onImport={(tx) => {
              preview(tx, "manual");
              onClose();
            }}
          />
        </div>
      </div>
    </div>
  );
}

function ManualImport({
  document,
  selection,
  onImport,
}: {
  document: DesignDocument;
  selection: string | null;
  onImport: (transaction: Transaction) => void;
}) {
  const [manualInput, setManualInput] = useState("");
  const [error, setError] = useState("");

  function importTransaction() {
    try {
      const tx = validateProposal(
        { prompt: "", document, selection },
        JSON.parse(manualInput),
      );
      onImport(tx);
      setManualInput("");
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <details className="agent-external-details">
      <summary>手动事务导入与上下文导出（高级）</summary>
      <div className="agent-external-body">
        <button
          type="button"
          className="agent-btn-secondary"
          aria-label="导出画布上下文 JSON"
          data-tip="导出画布上下文 JSON"
          onClick={() =>
            download(
              "agent-context.json",
              JSON.stringify({ document, selection }, null, 2),
            )
          }
        >
          <Download size={13} />
          导出画布上下文 JSON
        </button>
        <label>
          事务 JSON
          <textarea
            aria-label="Agent 事务 JSON"
            value={manualInput}
            onChange={(event) => {
              setManualInput(event.target.value);
              setError("");
            }}
            placeholder={`粘贴设计变更 JSON（当前修订 ${document.revision}）`}
          />
        </label>
        {error && (
          <p role="alert" className="agent-config-error">
            {error}
          </p>
        )}
        <button
          type="button"
          className="agent-btn-primary"
          disabled={!manualInput.trim()}
          onClick={importTransaction}
        >
          校验并预览
        </button>
      </div>
    </details>
  );
}
