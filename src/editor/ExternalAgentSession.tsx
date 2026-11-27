import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Cable, Copy, Unplug } from "lucide-react";
import { z } from "zod";
import { validateProposal, type Transaction } from "../agent/provider";
import {
  bridgeApprovalModeSchema,
  bridgeConnectedClientSchema,
  bridgeInboxTaskSchema,
  buildClientConfigSnippet,
  resolveBridgeEndpoints,
  type BridgeApprovalMode,
  type BridgeClientTarget,
  type BridgeConnectedClient,
  type BridgeEndpoints,
  type BridgeInboxTask,
  type BridgeTabSummary,
} from "../application/external-bridge";
import type { DesignDocument } from "../domain/document";

export interface ExternalBridgeSnapshot {
  connected: boolean;
  key: string;
  editor: string;
  endpoints: BridgeEndpoints | null;
  approvalMode: BridgeApprovalMode;
  writeEnabled: boolean;
  connectedClients: BridgeConnectedClient[];
  tasks: BridgeInboxTask[];
  completeTask: (
    taskId: string,
    note?: string,
    documentOverride?: DesignDocument,
  ) => Promise<void>;
  rejectTask: (taskId: string, reason?: string) => Promise<void>;
  ackProposal: (
    proposalId: string,
    status: "applied" | "discarded",
  ) => Promise<void>;
}

export interface ExternalProposalMeta {
  proposalId?: string;
  source?: "mcp" | "a2a";
  taskId?: string;
  summary?: string;
  autoApply?: boolean;
}

interface SessionProps {
  document: DesignDocument;
  selection: string | null;
  receive: (tx: Transaction, meta?: ExternalProposalMeta) => void;
  onSessionActiveChange?: (active: boolean) => void;
  tabs?: BridgeTabSummary[];
  activeTabId?: string | null;
  onBridgeSnapshotChange?: (snapshot: ExternalBridgeSnapshot) => void;
}

const route = "/api/agent/sessions";
const pairSchema = z.object({
  key: z.string().min(1),
  editor: z.string().min(1),
  endpointBase: z.string().optional(),
  approvalMode: bridgeApprovalModeSchema.optional(),
  writeEnabled: z.boolean().optional(),
});
type Pair = z.infer<typeof pairSchema> & { initialCanvas: string };

function canvasIdentity({
  document,
  activeTabId,
}: Pick<SessionProps, "document" | "activeTabId">) {
  return JSON.stringify([activeTabId, document.id, document.activePage]);
}

const syncSchema = z.object({
  approvalMode: bridgeApprovalModeSchema.optional(),
  writeEnabled: z.boolean().optional(),
  connectedClients: bridgeConnectedClientSchema.array().optional(),
  tasks: bridgeInboxTaskSchema.array().optional(),
  proposal: z
    .object({
      id: z.string().min(1),
      transaction: z.unknown(),
      source: z.enum(["mcp", "a2a"]).default("mcp"),
      taskId: z.string().optional(),
      summary: z.string().optional(),
      autoApply: z.boolean().default(false),
    })
    .nullish(),
});

const clientTargets = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  codex: "Codex",
  a2a: "A2A",
} satisfies Record<BridgeClientTarget, string>;
const clientOrder: BridgeClientTarget[] = [
  "claude-code",
  "cursor",
  "codex",
  "a2a",
];

function auth(pair: Pair) {
  return { Authorization: "Bearer " + pair.key, "X-Forma-Editor": pair.editor };
}

async function responseError(response: Response) {
  const payload = z
    .object({ error: z.string() })
    .safeParse(await response.json().catch(() => null));
  return payload.success
    ? payload.data.error
    : `本机服务请求失败（${response.status}）`;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function closeSession(pair: Pair) {
  return fetch(route, {
    method: "DELETE",
    headers: auth(pair),
    keepalive: true,
  });
}

const disconnectedAction = async () => {
  throw new Error("外部 Agent 会话已断开");
};
const disconnected: ExternalBridgeSnapshot = {
  connected: false,
  key: "",
  editor: "",
  endpoints: null,
  approvalMode: "review",
  writeEnabled: true,
  connectedClients: [],
  tasks: [],
  ackProposal: disconnectedAction,
  completeTask: disconnectedAction,
  rejectTask: disconnectedAction,
};

export function ExternalAgentSession({
  document,
  selection,
  receive,
  onSessionActiveChange,
  tabs,
  activeTabId,
  onBridgeSnapshotChange,
}: SessionProps) {
  const [pair, setPair] = useState<Pair | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [invalidProposal, setInvalidProposal] =
    useState<ExternalProposalMeta | null>(null);
  const [legacy, setLegacy] = useState(false);
  const [approvalMode, setApprovalMode] =
    useState<BridgeApprovalMode>("review");
  const [writeEnabled, setWriteEnabled] = useState(true);
  const [connectedClients, setClients] = useState<BridgeConnectedClient[]>([]);
  const [tasks, setTasks] = useState<BridgeInboxTask[]>([]);

  const current = {
    document,
    selection,
    tabs: tabs ?? [],
    activeTabId:
      activeTabId === undefined
        ? (tabs?.find((tab) => tab.active)?.id ?? null)
        : activeTabId,
    approvalMode,
    writeEnabled,
  };
  const workspace = useRef(current);
  workspace.current = current;
  const callbacks = useRef({
    receive,
    onSessionActiveChange,
    onBridgeSnapshotChange,
  });
  callbacks.current = {
    receive,
    onSessionActiveChange,
    onBridgeSnapshotChange,
  };
  const mounted = useRef(false);
  const livePair = useRef<Pair | null>(null);
  const deliveredProposalIdRef = useRef(new Set<string>());
  const refresh = useRef<(() => void) | null>(null);
  const endpoints = useMemo(
    () =>
      pair &&
      resolveBridgeEndpoints({
        ...pair,
        currentOrigin: window.location?.origin,
      }),
    [pair],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      callbacks.current.onSessionActiveChange?.(false);
      callbacks.current.onBridgeSnapshotChange?.(disconnected);
    };
  }, []);

  useEffect(() => {
    callbacks.current.onSessionActiveChange?.(Boolean(pair));
  }, [pair]);

  useEffect(() => {
    if (!pair) return;
    const controller = new AbortController();
    let polling = false;
    let queued = false;
    let legacyServer = false;
    let serverCanvas = pair.initialCanvas;
    let lastDocument: DesignDocument | undefined;
    let pending: { id: string; canvas: string } | undefined;
    const active = () =>
      !controller.signal.aborted && livePair.current === pair;
    async function sync(session: Pair) {
      if (!active()) return;
      if (polling) {
        queued = true;
        return;
      }
      polling = true;
      const sent = workspace.current;
      try {
        const options = { headers: auth(session), signal: controller.signal };
        let response: Response;
        if (legacyServer) {
          response = await fetch(route + "/proposal", options);
        } else {
          response = await fetch(route + "/sync", {
            ...options,
            method: "PUT",
            headers: { ...options.headers, "Content-Type": "application/json" },
            // An idle poll needs only the small workspace fields. The service
            // retains the last accepted document until its identity changes.
            body: JSON.stringify({
              ...sent,
              document:
                sent.document === lastDocument ? undefined : sent.document,
            }),
          });
          if (response.status === 400 && active()) {
            const detail = await responseError(response.clone());
            // Older services have no policy fields and reject the sync route.
            if (
              detail === "会话操作无效" ||
              (!session.approvalMode && session.writeEnabled === undefined)
            ) {
              response = await fetch(route + "/proposal", options);
              if (response.ok && active()) {
                legacyServer = true;
                setLegacy(true);
              }
            }
          }
        }
        if (!active()) return;
        if (!response.ok) {
          const detail = await responseError(response);
          if (
            active() &&
            (response.status === 401 || detail.includes("会话已结束"))
          ) {
            livePair.current = null;
            setPair(null);
            setError(detail);
          }
          throw new Error(detail);
        }
        const data = syncSchema.parse(await response.json());
        if (!active()) return;
        // A proposal already queued when PUT switches canvases belongs to the
        // previous server snapshot. Node IDs and revisions may match in copies.
        if (data.proposal && pending?.id !== data.proposal.id)
          pending = { id: data.proposal.id, canvas: serverCanvas };
        if (!legacyServer) {
          serverCanvas = canvasIdentity(sent);
          lastDocument = sent.document;
        }
        if (data.connectedClients) {
          const clients = data.connectedClients;
          setClients((prev) =>
            JSON.stringify(prev) === JSON.stringify(clients) ? prev : clients,
          );
        }
        if (data.tasks) {
          const inbox = data.tasks;
          setTasks((prev) =>
            JSON.stringify(prev) === JSON.stringify(inbox) ? prev : inbox,
          );
        }
        const latest = workspace.current;
        if (sent.approvalMode === latest.approvalMode && data.approvalMode)
          setApprovalMode(data.approvalMode);
        if (
          sent.writeEnabled === latest.writeEnabled &&
          data.writeEnabled !== undefined
        )
          setWriteEnabled(data.writeEnabled);
        const proposal = data.proposal;
        if (
          proposal &&
          latest.writeEnabled &&
          data.writeEnabled !== false &&
          pending?.canvas === canvasIdentity(latest) &&
          !deliveredProposalIdRef.current.has(proposal.id)
        ) {
          let tx: Transaction;
          try {
            tx = validateProposal(
              {
                document: latest.document,
                selection: latest.selection,
                prompt: "",
              },
              proposal.transaction,
            );
          } catch (err) {
            if (!legacyServer)
              setInvalidProposal({
                proposalId: proposal.id,
                taskId: proposal.taskId,
              });
            throw err;
          }
          deliveredProposalIdRef.current.add(proposal.id);
          try {
            await callbacks.current.receive(tx, {
              proposalId: proposal.id,
              taskId: proposal.taskId,
              source: proposal.source,
              summary: proposal.summary,
              autoApply: Boolean(proposal.autoApply),
            });
          } catch (err) {
            if (active()) setError(message(err));
          }
        }
        if (active()) {
          setInvalidProposal(null);
          setSyncError("");
        }
      } catch (err) {
        if (active()) setSyncError(message(err));
      } finally {
        polling = false;
        if (queued && active()) {
          queued = false;
          void sync(session);
        }
      }
    }
    const poll = () => void sync(pair);
    refresh.current = poll;
    poll();
    const interval = setInterval(poll, 1000);
    const leave = () => {
      if (livePair.current !== pair) return;
      livePair.current = null;
      void closeSession(pair).catch(() => {});
    };
    const pagehide = (event: PageTransitionEvent) => {
      leave();
      if (event.persisted) setPair(null);
    };
    window.addEventListener("pagehide", pagehide);
    return () => {
      controller.abort();
      clearInterval(interval);
      refresh.current = null;
      window.removeEventListener("pagehide", pagehide);
      leave();
    };
  }, [pair]);

  // Parents can recreate the tab array when a new inbox snapshot arrives.
  const tabVersion = JSON.stringify(tabs);
  useEffect(() => {
    if (!livePair.current) return;
    const timer = setTimeout(() => refresh.current?.(), 250);
    return () => clearTimeout(timer);
  }, [
    document,
    selection,
    tabVersion,
    activeTabId,
    approvalMode,
    writeEnabled,
  ]);

  const post = useCallback(
    async (path: string, body: object) => {
      if (!mounted.current || !pair || livePair.current !== pair)
        throw new Error("外部 Agent 会话已断开");
      const response = await fetch(route + path, {
        method: "POST",
        headers: { ...auth(pair), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await responseError(response));
      if (livePair.current === pair) refresh.current?.();
    },
    [pair],
  );

  const actions = useMemo(
    () => ({
      ackProposal: (proposalId: string, status: "applied" | "discarded") =>
        post("/proposal/ack", { proposalId, status }),
      completeTask: (
        taskId: string,
        note?: string,
        documentOverride?: DesignDocument,
      ) =>
        post(`/tasks/${encodeURIComponent(taskId)}/complete`, {
          document: documentOverride ?? workspace.current.document,
          note,
        }),
      rejectTask: (taskId: string, reason?: string) =>
        post(`/tasks/${encodeURIComponent(taskId)}/reject`, { reason }),
    }),
    [post],
  );
  useEffect(() => {
    callbacks.current.onBridgeSnapshotChange?.(
      pair
        ? {
            connected: true,
            key: pair.key,
            editor: pair.editor,
            endpoints,
            approvalMode,
            writeEnabled,
            connectedClients,
            tasks,
            ...actions,
          }
        : disconnected,
    );
  }, [
    pair,
    endpoints,
    approvalMode,
    writeEnabled,
    connectedClients,
    tasks,
    actions,
  ]);

  async function connect() {
    setBusy(true);
    setError("");
    try {
      const initial = workspace.current;
      const response = await fetch(route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...initial,
          approvalMode: "review",
          writeEnabled: true,
          persistent: true,
        }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const session: Pair = {
        ...pairSchema.parse(await response.json()),
        initialCanvas: canvasIdentity(initial),
      };
      if (!mounted.current) {
        await closeSession(session);
        return;
      }
      deliveredProposalIdRef.current.clear();
      setInvalidProposal(null);
      setLegacy(false);
      setSyncError("");
      setClients([]);
      setTasks([]);
      setApprovalMode(session.approvalMode ?? "review");
      setWriteEnabled(session.writeEnabled ?? true);
      livePair.current = session;
      setPair(session);
    } catch (err) {
      if (mounted.current) setError(message(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function disconnect(session: Pair) {
    setBusy(true);
    try {
      const response = await closeSession(session);
      if (!response.ok && response.status !== 401)
        throw new Error(await responseError(response));
      if (livePair.current === session) {
        livePair.current = null;
        setPair(null);
        setError("");
      }
    } catch (err) {
      if (mounted.current) setError(message(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const policyGroup = useId();
  return (
    <div className="bridge-session">
      {pair && endpoints ? (
        <>
          <div className="bridge-row bridge-status">
            <div>
              <strong className="bridge-live">
                <i aria-hidden="true" />
                {legacy
                  ? "已连接旧版 stdio 服务"
                  : "本机服务已开启 · 跨标签自动同步"}
              </strong>
              <div className="bridge-clients">
                {connectedClients.length
                  ? connectedClients.map((client) => (
                      <span key={client.id}>
                        {client.name} · {client.protocol}
                      </span>
                    ))
                  : "等待外部客户端接入"}
              </div>
            </div>
            <button
              type="button"
              className="agent-btn-secondary"
              aria-label="关闭会话"
              data-tip="断开连接"
              disabled={busy}
              onClick={() => void disconnect(pair)}
            >
              <Unplug size={14} />
              断开连接
            </button>
          </div>
          {!legacy && (
            <section className="bridge-section">
              <div className="bridge-row">
                <h3>画布权限</h3>
                <label className="bridge-write">
                  <input
                    type="checkbox"
                    checked={writeEnabled}
                    onChange={(ev) => setWriteEnabled(ev.target.checked)}
                  />
                  允许写入画布
                </label>
              </div>
              {writeEnabled ? (
                <fieldset className="bridge-policy">
                  <legend>写入审批</legend>
                  <label>
                    <input
                      type="radio"
                      name={policyGroup}
                      value="review"
                      checked={approvalMode === "review"}
                      onChange={() => setApprovalMode("review")}
                    />
                    画布提案待我确认（推荐）
                  </label>
                  <label>
                    <input
                      type="radio"
                      name={policyGroup}
                      value="auto-apply"
                      checked={approvalMode === "auto-apply"}
                      onChange={() => setApprovalMode("auto-apply")}
                    />
                    信任自动落画布（支持 ⌘Z 撤销）
                  </label>
                </fieldset>
              ) : (
                <p>仅只读，可检查画布、获取预览和导出代码。</p>
              )}
            </section>
          )}
          <ClientConfiguration
            endpoints={endpoints}
            pair={pair}
            legacy={legacy}
          />
        </>
      ) : (
        <section className="bridge-hero">
          <h3>连接本机画布</h3>
          <p>
            通过 MCP HTTP 读取当前设计，或通过 A2A
            委派任务。点击连接即可开启本机服务。
          </p>
          <button
            type="button"
            className="agent-btn-primary"
            aria-label="连接外部 Agent"
            data-tip="连接外部 Agent"
            disabled={busy}
            onClick={() => void connect()}
          >
            <Cable size={14} />
            连接外部 Agent
          </button>
        </section>
      )}
      {(error || (pair && syncError)) && (
        <p className="agent-config-error" role="alert">
          {error || syncError}
        </p>
      )}
      {pair && invalidProposal?.proposalId && (
        <button
          type="button"
          className="agent-btn-secondary"
          onClick={async () => {
            try {
              if (invalidProposal.taskId)
                await actions.rejectTask(
                  invalidProposal.taskId,
                  "提案与当前画布不兼容",
                );
              else if (invalidProposal.proposalId)
                await actions.ackProposal(
                  invalidProposal.proposalId,
                  "discarded",
                );
            } catch (err) {
              setError(message(err));
            }
          }}
        >
          拒绝失效提案
        </button>
      )}
    </div>
  );
}

function ClientConfiguration({
  endpoints,
  pair,
  legacy,
}: {
  endpoints: BridgeEndpoints;
  pair: Pair;
  legacy: boolean;
}) {
  const [target, setTarget] = useState<BridgeClientTarget>("claude-code");
  const [feedback, setFeedback] = useState("");
  const id = useId();
  const snippet = buildClientConfigSnippet(target, endpoints, pair.key);
  async function copy(value: string, success: string) {
    try {
      await navigator.clipboard.writeText(value);
      setFeedback(success);
    } catch {
      setFeedback("请选择文本，使用系统复制快捷键。");
    }
  }
  return (
    <>
      {!legacy && (
        <section className="bridge-section">
          <div className="bridge-row">
            <h3>客户端配置</h3>
            <button
              type="button"
              className="agent-btn-secondary"
              aria-label="复制配置"
              data-tip="复制配置"
              onClick={() => void copy(snippet.code, "已复制配置")}
            >
              <Copy size={13} />
              复制配置
            </button>
          </div>
          <div
            className="bridge-config-tabs"
            role="tablist"
            aria-label="客户端配置"
          >
            {clientOrder.map((client, index) => (
              <button
                key={client}
                type="button"
                role="tab"
                id={`${id}-${client}`}
                aria-selected={target === client}
                aria-controls={id}
                tabIndex={target === client ? 0 : -1}
                onClick={() => {
                  setTarget(client);
                  setFeedback("");
                }}
                onKeyDown={(ev) => {
                  const next = {
                    ArrowLeft:
                      (index + clientOrder.length - 1) % clientOrder.length,
                    ArrowRight: (index + 1) % clientOrder.length,
                    Home: 0,
                    End: clientOrder.length - 1,
                  }[ev.key];
                  if (next === undefined) return;
                  ev.preventDefault();
                  setTarget(clientOrder[next]);
                  setFeedback("");
                  ev.currentTarget.parentElement
                    ?.querySelectorAll("button")
                    [next]?.focus();
                }}
              >
                {clientTargets[client]}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={id} aria-labelledby={`${id}-${target}`}>
            <p>{snippet.description}</p>
            <pre className="bridge-code" tabIndex={0}>
              <code>{snippet.code}</code>
            </pre>
          </div>
        </section>
      )}
      <section className="bridge-section">
        <div className="bridge-row bridge-key-row">
          <label htmlFor={id + "-key"}>
            stdio 会话密钥 <code>FORMA_SESSION</code>
          </label>
          <input
            id={id + "-key"}
            aria-label="MCP 会话密钥"
            readOnly
            value={pair.key}
            onFocus={(ev) => ev.target.select()}
          />
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="复制会话密钥"
            data-tip="复制会话密钥"
            onClick={() => void copy(pair.key, "已复制会话密钥")}
          >
            <Copy size={14} />
          </button>
        </div>
        {feedback && (
          <span className="bridge-feedback" role="status">
            {feedback}
          </span>
        )}
      </section>
    </>
  );
}
