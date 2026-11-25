import { loadFonts } from "../infrastructure/font-import";
import { useEffect, useRef, useState } from "react";
import { Rss, X } from "lucide-react";
import type { ComponentLibrary } from "../domain/library-schema";
import {
  fetchLibrary,
  saveSubscription,
  subscriptions,
  type Subscription,
} from "../infrastructure/subscribed-libraries";
import { useModalDialog } from "./useModalDialog";
import type { EditorController } from "./useEditor";
type Status = { message: string; library?: ComponentLibrary };

export function LibrarySubscriptions({
  editor: e,
  review,
}: {
  editor: EditorController;
  review: (lib: ComponentLibrary) => void;
}) {
  const doc = e.doc.id;
  const [links, setLinks] = useState(() => subscriptions(doc));
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [message, setMessage] = useState(""),
    [address, setAddress] = useState(""),
    [busy, setBusy] = useState(false),
    [open, setOpen] = useState(false);
  const modal = useModalDialog(open, () => setOpen(false));
  const life = useRef(new AbortController());
  const current = e.historyRef;
  async function check(link: Subscription, signal: AbortSignal) {
    try {
      setStatus((s) => ({ ...s, [link.id]: { message: "检查中…" } }));
      const library = await fetchLibrary(link.url, signal);
      if (library.id !== link.id) throw Error("此地址已改为另一组件库");
      if (!signal.aborted)
        setStatus((s) => ({ ...s, [link.id]: { message: "", library } }));
    } catch (err) {
      if (!signal.aborted)
        setStatus((s) => ({
          ...s,
          [link.id]: {
            message:
              "检查失败 · " +
              (err instanceof Error ? err.message : String(err)),
          },
        }));
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    const saved = subscriptions(doc);
    setLinks(saved);
    setStatus({});
    setMessage("");
    setBusy(false);
    setOpen(false);
    for (const link of saved) void check(link, controller.signal);
    return () => controller.abort();
  }, [doc]);
  async function subscribe() {
    setBusy(true);
    setMessage("");
    const signal = life.current.signal;
    try {
      const url = new URL(address.trim()).href;
      const lib = await fetchLibrary(url, signal);
      await loadFonts(lib.fonts);
      if (signal.aborted || current.current.present.id !== doc) return;
      const old = current.current.present.libraries?.[lib.id];
      if (!old) e.apply([{ type: "putLibrary", library: lib }]);
      const link = { id: lib.id, url, name: lib.name };
      setLinks(saveSubscription(doc, lib.id, link));
      setStatus((s) => ({ ...s, [lib.id]: { library: lib, message: "" } }));
      setAddress("");
    } catch (err) {
      if (!signal.aborted)
        setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  const pending = links.filter(
    (l) =>
      (status[l.id]?.library?.revision ?? -1) >
      (e.doc.libraries?.[l.id]?.revision ?? -1),
  );
  return (
    <>
      <button
        className="icon-btn icon-btn-sm"
        aria-label="在线组件库"
        data-tip="在线组件库"
        data-tip-desc="订阅地址、检查修订并审阅更新"
        data-tip-side="bottom"
        onClick={() => setOpen(true)}
      >
        <Rss size={15} />
        {!!pending.length && <sup>{pending.length}</sup>}
      </button>
      {open && (
        <div
          className="modal-backdrop"
          onMouseDown={(ev) => {
            if (ev.target === ev.currentTarget) setOpen(false);
          }}
        >
          <div
            ref={modal}
            className="library-update-dialog review-wide"
            style={{ width: "min(540px, 92vw)" }}
            role="dialog"
            aria-modal="true"
            aria-label="在线组件库"
            tabIndex={-1}
          >
            <div className="review-sticky-header">
              <strong>在线组件库</strong>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label="关闭在线组件库"
                data-tip="关闭"
                data-tip-kbd="Esc"
                onClick={() => setOpen(false)}
              >
                <X size={16} />
              </button>
            </div>
            <div className="review-scroll-body">
              <form
                onSubmit={(ev) => {
                  ev.preventDefault();
                  void subscribe();
                }}
                style={{
                  display: "flex",
                  gap: 6,
                  alignItems: "flex-end",
                  marginBottom: 12,
                }}
              >
                <label style={{ flex: 1 }}>
                  组件库地址
                  <input
                    type="url"
                    required
                    aria-label="组件库地址"
                    placeholder="https://…/library.forma-library.json"
                    value={address}
                    onChange={(ev) => setAddress(ev.target.value)}
                  />
                </label>
                <button
                  className="primary"
                  style={{ height: 26, padding: "0 12px" }}
                  disabled={busy || !address.trim()}
                >
                  {busy ? "正在连接…" : "订阅"}
                </button>
              </form>
              {message && <p role="alert">{message}</p>}
              {!links.length && (
                <p
                  style={{
                    color: "var(--text-muted)",
                    margin: "16px 0",
                    textAlign: "center",
                  }}
                >
                  尚未订阅任何在线组件库。粘贴团队组件库地址即可自动跟踪修订与更新。
                </p>
              )}
              {links.map((link) => {
                const result = status[link.id],
                  lib = result?.library,
                  installed = e.doc.libraries?.[link.id];
                return (
                  <section
                    key={link.id}
                    style={{
                      padding: "10px 0",
                      borderTop: "1px solid var(--border-subtle)",
                    }}
                  >
                    <strong>{link.name}</strong>
                    <p
                      title={link.url}
                      style={{
                        margin: "4px 0 8px",
                        color: "var(--text-secondary)",
                      }}
                    >
                      {result?.message ||
                        (lib &&
                        (!installed || lib.revision > installed.revision)
                          ? "可用版本 r" + lib.revision
                          : lib &&
                              installed &&
                              lib.revision < installed.revision
                            ? "远端版本较早 r" + lib.revision
                            : lib &&
                                installed &&
                                JSON.stringify(installed) !==
                                  JSON.stringify(lib)
                              ? "修订号相同，快照内容不同"
                              : lib
                                ? "已是最新版本"
                                : "等待检查")}
                      {installed && " · 本地 r" + installed.revision}
                    </p>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button
                        disabled={result?.message === "检查中…"}
                        onClick={() => void check(link, life.current.signal)}
                      >
                        检查更新
                      </button>
                      {lib &&
                        (!installed || lib.revision > installed.revision) && (
                          <button
                            className="primary"
                            onClick={async () => {
                              try {
                                await loadFonts(lib.fonts);
                                if (
                                  life.current.signal.aborted ||
                                  current.current.present.id !== doc
                                )
                                  return;
                                setOpen(false);
                                review(lib);
                              } catch (err) {
                                setMessage(
                                  err instanceof Error
                                    ? err.message
                                    : String(err),
                                );
                              }
                            }}
                          >
                            {installed ? "查看更新" : "重新安装"}
                          </button>
                        )}
                      <button
                        onClick={() => {
                          setLinks(saveSubscription(doc, link.id));
                        }}
                      >
                        取消订阅
                      </button>
                    </div>
                  </section>
                );
              })}
            </div>
            <footer className="review-sticky-footer">
              <button onClick={() => setOpen(false)}>完成</button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}
