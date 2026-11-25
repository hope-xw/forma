import { X } from "lucide-react";
import { releaseNotes } from "./release-notes";
import { useModalDialog } from "./useModalDialog";

export function ReleaseNotesDialog({
  version,
  close,
}: {
  version: string;
  close: () => void;
}) {
  const ref = useModalDialog(true, close);
  return (
    <div
      className="modal-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={ref}
        className="file-browser release-notes-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="release-notes-title"
        tabIndex={-1}
      >
        <div className="panel-heading">
          <div className="release-notes-heading">
            <strong id="release-notes-title">版本日志</strong>
            <span>当前版本 v{version}</span>
          </div>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="关闭版本日志"
            data-tip="关闭"
            data-tip-kbd="Esc"
            onClick={close}
          >
            <X size={15} />
          </button>
        </div>
        <ol className="release-notes-list" tabIndex={0} aria-label="历次更新">
          {releaseNotes.map((entry) => (
            <li key={entry.version}>
              <div className="release-number">
                <span>v{entry.version}</span>
                <time dateTime={entry.date}>{entry.date}</time>
              </div>
              <div className="release-notes-body">
                <h3>{entry.title}</h3>
                <div className="release-notes-changes">
                  {entry.changes.map((change) => (
                    <p key={change}>{change}</p>
                  ))}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
