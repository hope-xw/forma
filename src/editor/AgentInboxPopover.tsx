import { useEffect, useRef, useState } from "react";
import { Inbox, LoaderCircle, Settings2, X } from "lucide-react";
import {
  formatSkillLabel,
  formatTaskStateLabel,
  sortInboxTasks,
  type BridgeInboxTask,
} from "../application/external-bridge";
import { useModalDialog } from "./useModalDialog";
import "./external-bridge.css";

export interface AgentInboxPopoverProps {
  open: boolean;
  onClose(): void;
  connected: boolean;
  tasks: BridgeInboxTask[];
  onOpenIntegrations(): void;
  onPreviewTaskProposal?: (task: BridgeInboxTask) => void;
  onCompleteTask: (taskId: string) => Promise<void>;
  onRejectTask: (taskId: string, reason?: string) => Promise<void>;
}

export function AgentInboxPopover({
  open,
  onClose,
  connected,
  tasks,
  onOpenIntegrations,
  onPreviewTaskProposal,
  onCompleteTask,
  onRejectTask,
}: AgentInboxPopoverProps) {
  const dialog = useModalDialog(open, onClose, false);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const outside = (ev: PointerEvent) => {
      if (
        ev.target instanceof Node &&
        !dialog.current?.contains(ev.target) &&
        !(
          ev.target instanceof Element &&
          ev.target.closest('[aria-expanded="true"][aria-haspopup="dialog"]')
        )
      )
        close.current();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, dialog]);
  if (!open) return null;
  return (
    <div
      ref={dialog}
      role="dialog"
      aria-label="外部 Agent 任务收件箱"
      className="bridge-inbox"
      tabIndex={-1}
    >
      <header className="bridge-inbox-head">
        <h2>外部 Agent 任务</h2>
        <span className="bridge-connection-pill" data-connected={connected}>
          {connected ? "已连接" : "未连接"}
        </span>
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          aria-label="连接设置"
          data-tip="连接设置"
          onClick={() => {
            onClose();
            onOpenIntegrations();
          }}
        >
          <Settings2 size={15} />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          aria-label="关闭任务收件箱"
          data-tip="关闭"
          data-tip-kbd="Esc"
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </header>
      <div className="bridge-inbox-body">
        {tasks.length === 0 ? (
          <div className="bridge-empty">
            <Inbox size={23} aria-hidden="true" />
            <h3>暂无外部任务</h3>
            <p>
              通过 A2A
              委派的界面生成、画板精修等任务会显示在这里。你可以在画布上审阅、修改，再确认回传产物。
            </p>
          </div>
        ) : (
          sortInboxTasks(tasks).map((task) => (
            <InboxTaskCard
              key={task.id}
              task={task}
              connected={connected}
              onPreviewTaskProposal={onPreviewTaskProposal}
              onCompleteTask={onCompleteTask}
              onRejectTask={onRejectTask}
            />
          ))
        )}
      </div>
    </div>
  );
}

const timeFormat = new Intl.DateTimeFormat("zh-CN", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function InboxTaskCard({
  task,
  connected,
  onPreviewTaskProposal,
  onCompleteTask,
  onRejectTask,
}: Pick<
  AgentInboxPopoverProps,
  "connected" | "onPreviewTaskProposal" | "onCompleteTask" | "onRejectTask"
> & { task: BridgeInboxTask }) {
  const [busy, setBusy] = useState<"complete" | "reject" | null>(null);
  const [error, setError] = useState("");
  const time = Date.parse(task.updatedAt);

  async function respond(action: "complete" | "reject") {
    if (busy || !connected) return;
    setBusy(action);
    setError("");
    try {
      if (action === "complete") await onCompleteTask(task.id);
      else await onRejectTask(task.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="bridge-task" aria-busy={Boolean(busy)}>
      <div className="bridge-row">
        <span className="bridge-skill">{formatSkillLabel(task.skill)}</span>
        <span className="bridge-state" data-state={task.state}>
          {formatTaskStateLabel(task.state)}
        </span>
      </div>
      <p className="bridge-prompt">{task.prompt}</p>
      {task.summary && task.summary !== task.prompt && (
        <p className="bridge-summary">{task.summary}</p>
      )}
      <div className="bridge-task-meta">
        <span>{task.sourceClient || "A2A 客户端"}</span>
        <time dateTime={task.updatedAt}>
          {Number.isFinite(time) ? timeFormat.format(time) : task.updatedAt}
        </time>
      </div>
      {(error || task.error) && (
        <p className="bridge-task-error" role="alert">
          {error || task.error}
        </p>
      )}
      {task.state === "input-required" && (
        <div className="bridge-task-actions">
          <button
            type="button"
            className="bridge-deliver"
            aria-label="确认并回传产物"
            data-tip="确认并回传产物"
            disabled={!connected || !!busy}
            onClick={() => void respond("complete")}
          >
            {busy === "complete" && (
              <LoaderCircle
                className="bridge-spinner"
                size={13}
                aria-hidden="true"
              />
            )}
            确认并回传产物
          </button>
          {task.proposalId && onPreviewTaskProposal && (
            <button
              type="button"
              disabled={!!busy}
              onClick={() => onPreviewTaskProposal(task)}
            >
              预览方案
            </button>
          )}
          <button
            type="button"
            className="bridge-reject"
            disabled={!connected || !!busy}
            onClick={() => void respond("reject")}
          >
            拒绝
          </button>
        </div>
      )}
    </article>
  );
}
