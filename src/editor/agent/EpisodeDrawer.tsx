import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FolderOpen, Pin, PinOff, Trash2, X } from "lucide-react";
import type { DesignDocument } from "../../domain/document";
import {
  buildEpisodeFromAppliedProposal,
  episodeIdentityKey,
  resolveProjectMemoryScope,
  type DesignEpisode,
  type ProjectSpace,
} from "../../agent/project-memory";
import {
  deleteDesignEpisode,
  FileLifetimeMismatchError,
  getFileProjectSpace,
  isFileLifetimeMismatchError,
  isProjectMemoryUnavailableError,
  listScopeEpisodes,
  saveDesignEpisodeWithReceipt,
  updateDesignEpisode,
  type EpisodeSaveReceipt,
} from "../../infrastructure/project-memory-store";
import {
  episodeMentionLimitNote,
  type PendingAgentProposal,
} from "../CanvasAgentBar";
import type { SessionIdentity } from "./agent-copy";

export const lifetimeMismatchMessage =
  "当前文件已在其他窗口删除或替换，请重新打开文件";
export const sessionArchiveNote =
  "本地持久存储暂不可用，本次记录仅暂存于当前会话";
export const projectMemoryUnavailableNotice =
  "本地设计记忆存储暂不可用，请在存储恢复后刷新。";

export function projectMemoryReadErrorMessage(error: unknown): string {
  if (
    isProjectMemoryUnavailableError(error) ||
    (error instanceof DOMException && error.name === "SecurityError")
  )
    return projectMemoryUnavailableNotice;
  return `读取设计记忆失败：${error instanceof Error ? error.message : String(error)}`;
}

export async function archiveAppliedProposal(
  proposal: PendingAgentProposal,
  beforeDoc: DesignDocument,
  afterDoc: DesignDocument,
  fileKey: string,
  sourceLifetimeToken?: string,
  sourceDocumentEpoch?: number,
  onReceipt?: (receipt: EpisodeSaveReceipt, lifetimeToken?: string) => void,
): Promise<string> {
  if (proposal.source !== "chat") return "";
  const meta = proposal.episodeMeta;
  try {
    const episode = buildEpisodeFromAppliedProposal({
      beforeDoc,
      afterDoc,
      createdRootIds: proposal.createdRootIds,
      prompt: meta?.prompt || proposal.summary || "Forma AI 设计生成",
      summary: proposal.summary,
      mode: meta?.mode,
      scopeProjectId: proposal.scopeProjectId,
      sourceFileKey: fileKey,
      sourceLifetimeToken,
      sourceDocumentEpoch,
      libraryId: meta?.targetLibraryId,
      decisions: meta?.decisions,
      customModules: meta?.customModules,
      screenRoles: meta?.screenRoles,
    });
    const receipt = await saveDesignEpisodeWithReceipt(episode);
    onReceipt?.(receipt, sourceLifetimeToken);
    return receipt.durable
      ? "已应用并存入设计记忆"
      : `已应用，${sessionArchiveNote}`;
  } catch (error) {
    return `已应用，记录保存失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

const emptyEpisodes: DesignEpisode[] = [];

// App owns this list across page changes. A standalone panel owns its own list.
export function useEpisodeArchive(
  fileKey: string,
  documentId: string,
  scopeId: string,
  lifetimeInvalid: boolean,
  onVerifiedRead?: () => void,
  documentEpoch?: number,
) {
  const [fetchedEpisodes, setFetchedEpisodes] = useState(emptyEpisodes);
  const [sessionArchivedEpisodes, setSessionArchivedEpisodes] = useState<
    {
      episode: DesignEpisode;
      fileKey: string;
      scopeId: string;
      sequence: number;
    }[]
  >([]);
  const session = useMemo(
    () => ({ active: false, reads: 0, lastAppliedRead: 0, receipts: 0 }),
    [fileKey, documentId, scopeId, lifetimeInvalid, documentEpoch],
  );
  useLayoutEffect(() => {
    session.active = !lifetimeInvalid;
    setSessionArchivedEpisodes([]);
    return () => {
      session.active = false;
    };
  }, [session, lifetimeInvalid]);
  useLayoutEffect(() => {
    setFetchedEpisodes(emptyEpisodes);
  }, [fileKey, documentId, lifetimeInvalid, documentEpoch]);

  const recordReceipt = useCallback(
    (receipt: EpisodeSaveReceipt, lifetimeToken?: string) => {
      const { episode } = receipt;
      if (
        receipt.durable ||
        !session.active ||
        episode.sourceFileKey !== fileKey ||
        episode.sourceDocId !== documentId ||
        episode.scopeProjectId !== scopeId ||
        episode.sourceLifetimeToken !== lifetimeToken
      )
        return;
      const row = {
        episode,
        fileKey,
        scopeId,
        sequence: ++session.receipts,
      };
      setSessionArchivedEpisodes((previous) => [
        row,
        ...previous.filter(
          (other) =>
            episodeIdentityKey(episode) !== episodeIdentityKey(other.episode),
        ),
      ]);
    },
    [session, fileKey, documentId, scopeId],
  );

  const beginRead = useCallback(() => {
    const request = ++session.reads;
    const acknowledgedBeforeRead = session.receipts;
    return (rows: DesignEpisode[]) => {
      if (!session.active || request < session.lastAppliedRead) return;
      session.lastAppliedRead = request;
      setFetchedEpisodes(rows);
      // A slow refresh cannot discard a receipt acknowledged after it started.
      setSessionArchivedEpisodes((previous) =>
        previous.filter((row) => row.sequence > acknowledgedBeforeRead),
      );
      onVerifiedRead?.();
    };
  }, [session, onVerifiedRead]);

  const episodes = useMemo(() => {
    if (lifetimeInvalid) return emptyEpisodes;
    const fetched = new Map<string, DesignEpisode | null>();
    for (const ep of fetchedEpisodes) {
      if (ep.scopeProjectId !== scopeId) continue;
      const key = episodeIdentityKey(ep);
      // Neither row is a safe drawer or picker target when its key is ambiguous.
      fetched.set(key, fetched.has(key) ? null : ep);
    }
    const pending = sessionArchivedEpisodes
      .filter(
        (row) =>
          row.fileKey === fileKey &&
          row.scopeId === scopeId &&
          row.episode.sourceDocId === documentId &&
          !fetched.has(episodeIdentityKey(row.episode)),
      )
      .map((row) => row.episode);
    return [
      ...pending,
      ...Array.from(fetched.values()).filter((ep) => ep !== null),
    ];
  }, [
    fetchedEpisodes,
    sessionArchivedEpisodes,
    fileKey,
    documentId,
    scopeId,
    lifetimeInvalid,
  ]);

  return useMemo(
    () => ({
      episodes,
      pickerEpisodes: episodes.map((ep) => ({
        ...ep,
        id: episodeIdentityKey(ep),
      })),
      recordReceipt,
      beginRead,
    }),
    [episodes, recordReceipt, beginRead],
  );
}

export async function readFileProjectEpisodes(
  fileKey: string,
  identity: SessionIdentity & { expectedDocId: string },
  isCurrent: () => boolean,
) {
  if (!isCurrent()) return;
  const options = {
    requireDurable: typeof indexedDB !== "undefined",
    ...identity,
    requireBoundLifetime: typeof indexedDB !== "undefined",
  };
  let project = await getFileProjectSpace(fileKey, options);
  while (isCurrent()) {
    const { scopeProjectId } = resolveProjectMemoryScope({ fileKey, project });
    const episodes = await listScopeEpisodes(scopeProjectId, {
      requireDurable: options.requireDurable,
    });
    if (!isCurrent()) return;
    // Listing archives and reading the assignment use separate transactions.
    const verified = await getFileProjectSpace(fileKey, options);
    if (!isCurrent()) return;
    if (verified?.id === project?.id)
      return { project: verified, scopeProjectId, episodes };
    project = verified;
  }
}

function EpisodeThumbnail({ svg }: { svg: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const src = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    setUrl(src);
    return () => URL.revokeObjectURL(src);
  }, [svg]);
  return url ? <img className="agent-episode-thumb" src={url} alt="" /> : null;
}

export interface EpisodeDrawerProps {
  episodes: DesignEpisode[];
  activeProject?: ProjectSpace | null;
  fileKey: string;
  expectedDocId: string;
  scopeProjectId: string;
  resolveSessionIdentity(): Promise<SessionIdentity>;
  fileLifetimeInvalid: boolean;
  onMutationError(error: unknown): Promise<void>;
  onArchive(): Promise<EpisodeSaveReceipt>;
  onReference(ep: DesignEpisode): boolean;
  onOpenFileBrowser?(): void;
  onClose(): void;
}

export function EpisodeDrawer({
  episodes,
  activeProject,
  fileKey,
  expectedDocId,
  scopeProjectId,
  resolveSessionIdentity,
  fileLifetimeInvalid,
  onMutationError,
  onArchive,
  onReference,
  onOpenFileBrowser,
  onClose,
}: EpisodeDrawerProps) {
  const [query, setQuery] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  async function mutationGuard(ep: DesignEpisode) {
    if (fileLifetimeInvalid)
      throw new FileLifetimeMismatchError(lifetimeMismatchMessage);
    return {
      expectedScopeId: scopeProjectId,
      sourceFileKey: fileKey,
      expectedDocId,
      expectedSnapshotKey: ep.snapshotKey,
      expectedIdentityKey: episodeIdentityKey(ep),
      ...(await resolveSessionIdentity()),
      requireBoundLifetime: typeof indexedDB !== "undefined",
    };
  }

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return episodes;
    return episodes.filter((ep) =>
      [
        ep.title,
        ep.summary,
        ep.prompt,
        ...ep.decisions.map((d) => d.question + " " + d.choice),
        ep.sourceFileName,
        ep.libraryName ?? "",
        ...ep.tags,
        ...ep.customModules,
        ...ep.componentsUsed.map((c) => c.componentName),
        ...ep.screens.map((s) => s.name),
      ].some((value) => value.toLowerCase().includes(q)),
    );
  }, [episodes, query]);

  async function refreshAfterError(error: unknown) {
    const message = isFileLifetimeMismatchError(error)
      ? lifetimeMismatchMessage
      : error instanceof Error
        ? error.message
        : "无法更新历史设计记录";
    setNote(message);
    try {
      await onMutationError(error);
    } catch (refreshError) {
      setNote(
        `${message}；刷新列表失败：${refreshError instanceof Error ? refreshError.message : String(refreshError)}`,
      );
    }
  }

  async function archive() {
    setSaving(true);
    try {
      const { episode: saved, durable } = await onArchive();
      setNote(
        durable ? `已归档「${saved.title}」到当前设计记忆` : sessionArchiveNote,
      );
    } catch (err) {
      await refreshAfterError(err);
    } finally {
      setSaving(false);
    }
  }

  const scopeTitle =
    activeProject === undefined
      ? "正在确认所属项目…"
      : activeProject
        ? `项目记忆 · ${activeProject.name}`
        : "当前文件记忆";

  return (
    <div
      className="agent-memory-drawer"
      role="region"
      aria-label="项目历史需求档案"
      data-escape-local="true"
      onKeyDown={(ev) => {
        ev.stopPropagation();
        if (ev.key === "Escape" && !ev.nativeEvent.isComposing) {
          ev.preventDefault();
          onClose();
        }
      }}
    >
      <div className="agent-memory-drawer-head">
        <span className="agent-memory-drawer-title" title={scopeTitle}>
          {scopeTitle}
        </span>
        <span className="agent-memory-drawer-count">{episodes.length}</span>
        {onOpenFileBrowser && (
          <button
            type="button"
            className="agent-memory-space-btn"
            aria-label="切换项目空间"
            data-tip="管理项目空间"
            data-tip-desc="归入同一项目后，多份设计稿可共享历史设计记忆"
            data-tip-side="bottom"
            onClick={onOpenFileBrowser}
          >
            <FolderOpen size={12} />
            <span>项目</span>
          </button>
        )}
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          aria-label="关闭设计记忆"
          data-tip="关闭"
          data-tip-kbd="Esc"
          data-tip-side="bottom"
          onClick={onClose}
        >
          <X size={12} />
        </button>
      </div>

      <div className="agent-memory-search">
        <input
          ref={searchRef}
          type="search"
          aria-label="搜索历史需求档案"
          placeholder="搜索历史记录…"
          value={query}
          onChange={(ev) => setQuery(ev.target.value)}
        />
        <button
          type="button"
          aria-label="归档当前画板"
          data-tip="记录当前画板"
          data-tip-desc="将当前选中的画板存入设计记忆，方便后续 @引用"
          data-tip-side="bottom"
          onClick={() => void archive()}
          disabled={saving || fileLifetimeInvalid}
        >
          归档当前画板
        </button>
      </div>

      {note && !fileLifetimeInvalid && (
        <div className="agent-memory-note" role="status">
          {note}
        </div>
      )}

      <div className="agent-memory-list">
        {!filtered.length && !fileLifetimeInvalid && (
          <div className="agent-memory-empty">
            {episodes.length
              ? "没有匹配的历史设计"
              : "采纳方案后会自动记录，也可手动归档画板供 @引用。"}
          </div>
        )}
        {filtered.map((ep) => (
          <article
            key={episodeIdentityKey(ep)}
            className="agent-episode-card"
            aria-label={ep.title}
          >
            <div className="agent-episode-heading">
              {ep.thumbnailSvg && <EpisodeThumbnail svg={ep.thumbnailSvg} />}
              <div>
                <strong>{ep.title}</strong>
                <div className="agent-episode-badges">
                  <span>
                    {ep.sourceFileKey === fileKey
                      ? "当前稿"
                      : `跨稿 · ${ep.sourceFileName}`}
                  </span>
                  {ep.libraryName && <span>{ep.libraryName}</span>}
                </div>
              </div>
            </div>
            {ep.componentsUsed.length > 0 && (
              <div className="agent-episode-badges">
                {ep.componentsUsed.slice(0, 3).map((c) => (
                  <span
                    key={JSON.stringify([
                      c.libraryId,
                      c.componentId,
                      c.variantId,
                    ])}
                  >
                    {c.componentName} ×{c.count}
                  </span>
                ))}
              </div>
            )}
            <details className="agent-episode-details">
              <summary>查看需求与决策</summary>
              <p>
                <strong>摘要</strong> {ep.summary}
              </p>
              <p>
                <strong>原始需求</strong> {ep.prompt}
              </p>
              {ep.decisions.length > 0 && (
                <ul>
                  {ep.decisions.map((decision, index) => (
                    <li key={index}>
                      {decision.question} → {decision.choice}
                    </li>
                  ))}
                </ul>
              )}
            </details>
            <div className="agent-episode-actions">
              <small>
                {ep.screens.length} 画板 · {ep.decisions.length} 项决策
              </small>
              <button
                type="button"
                aria-label="@引用"
                data-tip="@引用到对话"
                data-tip-desc={ep.title}
                data-tip-side="top"
                onClick={() => {
                  setNote(
                    onReference(ep)
                      ? `已引用「${ep.title}」`
                      : episodeMentionLimitNote,
                  );
                }}
              >
                @引用
              </button>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label={ep.pinned ? "取消置顶" : "置顶"}
                data-tip={ep.pinned ? "取消置顶" : "置顶保护"}
                data-tip-side="top"
                aria-pressed={!!ep.pinned}
                onClick={async () => {
                  try {
                    if (
                      !(await updateDesignEpisode(
                        ep.id,
                        { pinned: !ep.pinned },
                        await mutationGuard(ep),
                      ))
                    )
                      throw new Error("此记录已移除");
                    setNote("");
                  } catch (err) {
                    await refreshAfterError(err);
                  }
                }}
              >
                {ep.pinned ? <PinOff size={13} /> : <Pin size={13} />}
              </button>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label="删除档案"
                data-tip="删除记录"
                data-tip-side="top"
                data-tip-desc={ep.title}
                onClick={async () => {
                  try {
                    if (
                      !(await deleteDesignEpisode(
                        ep.id,
                        await mutationGuard(ep),
                      ))
                    )
                      throw new Error("此记录已移除");
                    setNote(`已删除「${ep.title}」`);
                    searchRef.current?.focus();
                  } catch (err) {
                    await refreshAfterError(err);
                  }
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
