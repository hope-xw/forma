import { RevisionPreview, DefinitionDiff } from "./LibraryDiff";
import { referencedComponents } from "../domain/component-slots";
import { useMemo, useState } from "react";
import { X } from "lucide-react";
import type { ComponentLibrary } from "../domain/library-schema";
import type { DesignDocument } from "../domain/document";
import { installLibrary } from "../domain/library";
import { transact, type Operation } from "../domain/commands";
import {
  changedComponents,
  definitionConflicts,
  sameDefinition,
  type ReviewOptions,
} from "../domain/library-review";
import { useModalDialog } from "./useModalDialog";
import type { EditorController } from "./useEditor";

const KIND_BADGE: Record<string, { label: string; cls: string }> = {
  added: { label: "新增", cls: "added" },
  changed: { label: "已更新", cls: "modified" },
  modified: { label: "已更新", cls: "modified" },
  removed: { label: "已移除", cls: "removed" },
};

export function LibraryReview({
  editor: e,
  base,
  incoming,
  close,
}: {
  editor: EditorController;
  base: DesignDocument;
  incoming: ComponentLibrary;
  close: () => void;
}) {
  const ref = useModalDialog(true, close);
  const old = base.libraries![incoming.id];
  const changes = useMemo(
    () => changedComponents(old, incoming),
    [old, incoming],
  );
  const conflicts = useMemo(
    () => definitionConflicts(base, old, incoming),
    [base, old, incoming],
  );
  const [selected, setSelected] = useState(() => changes.map((c) => c.id));
  const [decisions, setDecisions] = useState<
    NonNullable<ReviewOptions["decisions"]>
  >({});
  const operation = useMemo(
    () =>
      ({
        type: "updateLibrary",
        library: incoming,
        expectedRevision: old.revision,
        componentIds: selected,
        decisions,
      }) satisfies Operation,
    [incoming, old.revision, selected, decisions],
  );
  const issue = useMemo(() => {
    try {
      transact(base, { baseRevision: base.revision, operations: [operation] });
      return "";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, [base, operation]);
  const activePageId = base.activePage ?? base.pages?.[0]?.id ?? "first";
  const affected = [
    ...base.nodes.map((node) => ({ node, pageId: activePageId })),
    ...(base.pages ?? []).flatMap((p) =>
      (p.nodes ?? []).map((node) => ({ node, pageId: p.id })),
    ),
  ].filter(
    ({ node: n }) =>
      n.instance &&
      referencedComponents(n.instance).some(
        (ref) =>
          ref.libraryId === old.id &&
          (selected.includes(ref.componentId) ||
            !sameDefinition(old.designSystem, incoming.designSystem)),
      ),
  );
  function resolveAllConflicts(choice: "local" | "incoming") {
    const next: NonNullable<ReviewOptions["decisions"]> = { ...decisions };
    for (const c of conflicts) next[c.key] = choice;
    setDecisions(next);
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
        className="library-update-dialog review-wide"
        role="dialog"
        aria-modal="true"
        aria-label="查看组件库更新"
        tabIndex={-1}
      >
        <div className="review-sticky-header">
          <div>
            <strong style={{ fontSize: 13 }}>{incoming.name}</strong>
            <div style={{ color: "var(--text-secondary)", marginTop: 2 }}>
              版本 r{old.revision} → r{incoming.revision} · {affected.length}{" "}
              个关联实例
            </div>
          </div>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="关闭组件库更新"
            data-tip="关闭"
            data-tip-kbd="Esc"
            onClick={close}
          >
            <X size={16} />
          </button>
        </div>
        <div className="review-scroll-body">
          {changes.map((c) => {
            const badge = KIND_BADGE[c.kind] ?? {
              label: c.kind,
              cls: "modified",
            };
            return (
              <div
                key={c.id}
                style={{
                  padding: "8px 0",
                  borderBottom: "1px solid var(--border-subtle)",
                }}
              >
                <label className="review-change">
                  <input
                    type="checkbox"
                    aria-label={"更新 " + c.name}
                    checked={selected.includes(c.id)}
                    onChange={(ev) =>
                      setSelected(
                        ev.target.checked
                          ? [...selected, c.id]
                          : selected.filter((id) => id !== c.id),
                      )
                    }
                  />
                  <span>{c.name}</span>
                  <span className={`review-badge ${badge.cls}`}>
                    {badge.label}
                  </span>
                </label>
                <RevisionPreview previous={old} incoming={incoming} id={c.id} />
              </div>
            );
          })}
          {!sameDefinition(old.designSystem, incoming.designSystem) && (
            <p style={{ color: "var(--text-secondary)", margin: "10px 0" }}>
              此修订含共享样式或变量，应用后会同步到引用它们的图层。
            </p>
          )}
          {conflicts.length > 0 && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                margin: "12px 0 6px",
              }}
            >
              <strong>定义冲突 ({conflicts.length})</strong>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  onClick={() => resolveAllConflicts("local")}
                >
                  全部保留本地
                </button>
                <button
                  type="button"
                  onClick={() => resolveAllConflicts("incoming")}
                >
                  全部采用库版本
                </button>
              </div>
            </div>
          )}
          {conflicts.map((c) => (
            <section
              key={c.key}
              style={{
                padding: "8px 0",
                borderBottom: "1px solid var(--border-subtle)",
              }}
            >
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  marginBottom: 6,
                }}
              >
                <strong>{c.name}</strong>
                <select
                  aria-label={"处理冲突 " + c.name}
                  value={decisions[c.key] ?? ""}
                  onChange={(ev) =>
                    setDecisions({
                      ...decisions,
                      [c.key]: ev.target.value as "local" | "incoming",
                    })
                  }
                >
                  <option value="" disabled>
                    选择保留的版本
                  </option>
                  <option value="local">保留本地</option>
                  <option value="incoming">采用库版本</option>
                </select>
              </label>
              <DefinitionDiff
                local={c.local}
                remote={c.remote}
                localSystem={base.designSystem}
                remoteSystem={incoming.designSystem}
                colorProfile={base.colorProfile}
              />
            </section>
          ))}
          {!!affected.length && (
            <details style={{ marginTop: 10 }}>
              <summary>受影响的实例 · {affected.length}</summary>
              <ul style={{ margin: "6px 0", paddingLeft: 16 }}>
                {affected.map(({ node: n, pageId }) => (
                  <li key={n.id} style={{ marginBottom: 3 }}>
                    <button
                      type="button"
                      style={{ padding: "2px 6px", borderRadius: 4 }}
                      onClick={() => {
                        if (pageId !== activePageId) e.switchPage(pageId);
                        e.setSelection([n.id]);
                        requestAnimationFrame(() => e.api.current?.fit([n.id]));
                        close();
                      }}
                    >
                      {n.name}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {issue && <p role="alert">{issue}</p>}
        </div>
        <footer className="review-sticky-footer">
          <button onClick={close}>取消</button>
          <button
            onClick={() =>
              e.attempt(() => {
                e.apply(
                  [
                    {
                      type: "putLibrary",
                      library: installLibrary(base, incoming),
                    },
                  ],
                  base.revision,
                );
                close();
              })
            }
          >
            导入独立副本
          </button>
          <button
            className="primary"
            disabled={!!issue}
            onClick={() =>
              e.attempt(() => {
                e.apply([operation], base.revision);
                close();
              })
            }
          >
            应用组件库更新
          </button>
        </footer>
      </div>
    </div>
  );
}
