import { useEffect, useRef, useState } from "react";
import { Cable, Copy, Unplug } from "lucide-react";
import { validateProposal, type Transaction } from "../agent/provider";
import type { DesignDocument } from "../domain/document";
type Pair = { key: string; editor: string };
const route = "/api/agent/sessions";
function headers(p: Pair) {
  return { Authorization: "Bearer " + p.key, "X-Forma-Editor": p.editor };
}
async function close(p: Pair) {
  await fetch(route, {
    method: "DELETE",
    headers: headers(p),
    keepalive: true,
  }).catch(() => {});
}
export function ExternalAgentSession({
  document,
  selection,
  receive,
}: {
  document: DesignDocument;
  selection: string | null;
  receive: (t: Transaction) => void;
}) {
  const [pair, setPair] = useState<Pair | null>(null),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(false),
    [error, setError] = useState("");
  const mounted = useRef(true);
  const docRef = useRef(document),
    selectionRef = useRef(selection),
    receiveRef = useRef(receive);
  docRef.current = document;
  selectionRef.current = selection;
  receiveRef.current = receive;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!pair) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await fetch(route + "/proposal", { headers: headers(pair) }),
          data = await r.json();
        if (stopped) return;
        if (!r.ok) throw new Error(data.error ?? "会话不可用");
        if (data.proposal) {
          receiveRef.current(
            validateProposal(
              {
                document: docRef.current,
                selection: selectionRef.current,
                prompt: "",
              },
              data.proposal.transaction,
            ),
          );
          setPair(null);
          return;
        }
        timer = setTimeout(poll, 1000);
      } catch (err) {
        if (!stopped) {
          setError(err instanceof Error ? err.message : String(err));
          setPair(null);
        }
      }
    };
    void poll();
    const leave = () => void close(pair);
    window.addEventListener("pagehide", leave);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener("pagehide", leave);
      void close(pair);
    };
  }, [pair]);
  async function connect() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(route, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ document, selection }),
        }),
        data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "会话不可用");
      if (mounted.current) setPair(data);
      else await close(data);
    } catch (err) {
      if (mounted.current)
        setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div className="external-session">
      {pair ? (
        <>
          <label>
            FORMA_SESSION
            <input
              aria-label="MCP 会话密钥"
              readOnly
              value={pair.key}
              onFocus={(ev) => ev.target.select()}
            />
          </label>
          <button
            className="icon-btn icon-btn-sm"
            title={copied ? "已复制会话密钥" : "复制会话密钥"}
            aria-label="复制会话密钥"
            data-tip={copied ? "已复制" : "复制会话密钥"}
            onClick={() =>
              navigator.clipboard
                .writeText(pair.key)
                .then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1600);
                })
                .catch(() => setError("请选择并复制会话密钥"))
            }
          >
            <Copy size={14} />
          </button>
          <button
            className="icon-btn icon-btn-sm"
            title="关闭会话"
            aria-label="关闭会话"
            data-tip="关闭会话"
            onClick={() => setPair(null)}
          >
            <Unplug size={14} />
          </button>
        </>
      ) : (
        <button className="wide" disabled={busy} onClick={connect}>
          <Cable size={14} />
          连接外部 Agent
        </button>
      )}
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
    </div>
  );
}
