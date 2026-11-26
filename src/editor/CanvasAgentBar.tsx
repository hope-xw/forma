import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUp,
  AtSign,
  Box,
  Check,
  Component,
  History,
  ImagePlus,
  Loader2,
  MessageSquare,
  Palette,
  Search,
  Sparkles,
  Square,
  Variable,
  X,
} from "lucide-react";
import type { DesignDocument } from "../domain/document";
import {
  resolveProjectMemoryScope,
  type DesignEpisode,
} from "../agent/project-memory";
import {
  collectDocumentMentions,
  readImageFileAsAttachment,
  type AgentAttachment,
  type AgentMention,
  type AgentStatusResponse,
  type PendingAgentProposal as ClientProposal,
} from "./agent-client";
import { compactModelLabel } from "./agent/agent-copy";
import "./agent-ui.css";

export type PendingAgentProposal = ClientProposal & { scopeProjectId: string };
export const MAX_EPISODE_MENTIONS = 8;
export const episodeMentionLimitNote = "单轮最多引用 8 条历史需求";

export function episodeLimitReached(mentions: AgentMention[]) {
  return (
    mentions.filter((mention) => mention.kind === "episode").length >=
    MAX_EPISODE_MENTIONS
  );
}
export const canvasScopeReady = "forma:canvas-scope-ready";

export interface CanvasAgentBarProps {
  open: boolean;
  focusTick?: number;
  onClose(): void;
  document: DesignDocument;
  scopeProjectId?: string;
  projectEpisodes?: DesignEpisode[];
  selection: string | null;
  selectionCount: number;
  viewportCenter?: { x: number; y: number };
  status: AgentStatusResponse | null;
  pendingProposal: PendingAgentProposal | null;
  applyingProposal?: boolean;
  busy: boolean;
  progressText: string;
  error: string;
  onOpenConfig(): void;
  onSendPrompt(input: {
    pageId: string | undefined;
    scopeProjectId: string;
    prompt: string;
    mentions: AgentMention[];
    attachments?: { name: string; mimeType: string; dataUrl: string }[];
  }): void;
  onCancel(): void;
  onApplyProposal(): void;
  onDiscardProposal(): void;
  onOpenFullChat(): void;
}

const MENTION_KIND_LABELS: Record<AgentMention["kind"], string> = {
  component: "组件",
  variable: "变量",
  style: "样式",
  node: "画板",
  episode: "历史设计",
};

const noEpisodes: DesignEpisode[] = [];

function contextualStarters(
  selectedNode: DesignDocument["nodes"][number] | null | undefined,
  document: DesignDocument,
  selectionCount: number,
): string[] {
  if (selectionCount > 1) {
    return [
      "统一配色与圆角",
      "整理为等距卡片",
      "优化字体与视觉层次",
      "切换为深色主题",
    ];
  }
  if (!selectedNode) {
    return [
      "生成 H5 登录页",
      "生成 SaaS 数据看板",
      "生成电商商品详情页",
      "生成个人中心页",
    ];
  }
  if (selectedNode.type === "frame" || selectedNode.type === "section") {
    const hasChildren = document.nodes.some(
      (n) => n.parentId === selectedNode.id,
    );
    if (!hasChildren) {
      return [
        "生成完整移动端界面",
        "添加顶部导航与卡片列表",
        "生成登录与注册表单",
        "添加数据指标与底部导航",
      ];
    }
    return [
      "优化留白与视觉层次",
      "切换为深色主题",
      "整理为自动布局",
      "新增功能亮点卡片区",
    ];
  }
  if (selectedNode.type === "text") {
    return [
      "润色文案更简洁专业",
      "翻译为地道英文",
      "改写为高转化标题",
      "优化字号与对比度",
    ];
  }
  return [
    "优化圆角与阴影质感",
    "切换为主视觉高亮风",
    "绑定设计系统变量",
    "生成一组状态变体",
  ];
}

export function MentionKindIcon({ kind }: { kind: AgentMention["kind"] }) {
  switch (kind) {
    case "component":
      return (
        <Component size={12} style={{ color: "var(--figma-purple-soft)" }} />
      );
    case "variable":
      return <Variable size={12} style={{ color: "var(--figma-blue)" }} />;
    case "style":
      return <Palette size={12} style={{ color: "var(--figma-green)" }} />;
    case "node":
      return <Box size={12} style={{ color: "var(--text-secondary)" }} />;
    case "episode":
      return (
        <History size={12} style={{ color: "var(--figma-orange, #f59e0b)" }} />
      );
  }
}

export function AgentMentionPopover({
  document,
  episodes = noEpisodes,
  attached,
  initialQuery = "",
  placement = "top",
  onSelect,
  onClose,
}: {
  document: DesignDocument;
  episodes?: DesignEpisode[];
  attached: AgentMention[];
  initialQuery?: string;
  placement?: "top" | "inline";
  onSelect(item: AgentMention): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [kindFilter, setKindFilter] = useState<"all" | AgentMention["kind"]>(
    "all",
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const allItems = useMemo(
    () => collectDocumentMentions(document, episodes),
    [document, episodes],
  );
  const episodeById = useMemo(
    () => new Map(episodes.map((ep) => [ep.id, ep])),
    [episodes],
  );
  const attachedKeys = useMemo(
    () => new Set(attached.map((m) => `${m.kind}:${m.id}`)),
    [attached],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allItems
      .filter((item) => {
        if (attachedKeys.has(`${item.kind}:${item.id}`)) return false;
        if (kindFilter !== "all" && item.kind !== kindFilter) return false;
        if (!q) return true;
        const ep = item.kind === "episode" && episodeById.get(item.id);
        return (
          item.label.toLowerCase().includes(q) ||
          item.id.toLowerCase().includes(q) ||
          MENTION_KIND_LABELS[item.kind].includes(q) ||
          (ep &&
            [
              ep.sourceFileName,
              ep.libraryName ?? "",
              ep.summary,
              ...ep.tags,
            ].some((text) => text.toLowerCase().includes(q)))
        );
      })
      .slice(0, 40);
  }, [allItems, attachedKeys, episodeById, kindFilter, query]);

  const listboxId = useId();
  const activeItem = filtered[activeIndex];
  const optionId = (item: AgentMention) =>
    listboxId + "-" + item.kind + "-" + encodeURIComponent(item.id);
  const atLimit = episodeLimitReached(attached);
  const blocked = (item: AgentMention) => item.kind === "episode" && atLimit;

  useEffect(() => {
    setActiveIndex(0);
  }, [query, kindFilter]);

  return (
    <div
      className={`agent-mention-popover ${placement === "inline" ? "is-inline" : ""}`}
      role="dialog"
      aria-label="引用设计元素"
      data-escape-local="true"
      onKeyDown={(ev) => {
        ev.stopPropagation();
        if (ev.nativeEvent.isComposing) return;
        if (ev.key === "Escape") {
          ev.preventDefault();
          onClose();
        } else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
          ev.preventDefault();
          if (!filtered.length) return;
          const step = ev.key === "ArrowDown" ? 1 : -1;
          const index =
            (activeIndex + step + filtered.length) % filtered.length;
          setActiveIndex(index);
          inputRef.current?.focus({ preventScroll: true });
          listRef.current?.children[index]?.scrollIntoView({
            block: "nearest",
          });
        } else if (
          ev.key === "Enter" &&
          ev.target === inputRef.current &&
          filtered[activeIndex]
        ) {
          ev.preventDefault();
          if (!blocked(filtered[activeIndex])) onSelect(filtered[activeIndex]);
        }
      }}
    >
      <div className="agent-mention-search-row">
        <Search size={12} />
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeItem ? optionId(activeItem) : undefined}
          type="text"
          aria-label="搜索组件、变量、样式、画板或历史需求"
          placeholder="搜索组件、样式、画板或历史设计…"
          value={query}
          onChange={(ev) => setQuery(ev.target.value)}
        />
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          aria-label="关闭引用列表"
          title="关闭引用列表"
          data-tip="关闭引用列表"
          data-tip-kbd="Esc"
          data-tip-side="top"
          onClick={onClose}
        >
          <X size={12} />
        </button>
      </div>
      <div className="agent-mention-tabs" role="tablist" aria-label="引用类别">
        {(
          [
            ["all", "全部"],
            ["component", "组件"],
            ["variable", "变量"],
            ["style", "样式"],
            ["node", "画板"],
            ["episode", "历史需求"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={kindFilter === k}
            className={kindFilter === k ? "active" : ""}
            onClick={() => {
              setKindFilter(k);
              inputRef.current?.focus();
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {atLimit && (
        <div role="status" className="agent-memory-note">
          {episodeMentionLimitNote}
        </div>
      )}
      <div
        id={listboxId}
        ref={listRef}
        className="agent-mention-list"
        role="listbox"
        aria-label="可引用项"
      >
        {filtered.length === 0 ? (
          <div className="agent-mention-empty">
            {allItems.length === 0
              ? "当前文档暂无可引用的组件、变量或画板"
              : "没有匹配的引用项"}
          </div>
        ) : (
          filtered.map((item, idx) => {
            const ep = item.kind === "episode" && episodeById.get(item.id);
            return (
              <button
                key={`${item.kind}:${item.id}`}
                type="button"
                id={optionId(item)}
                role="option"
                aria-disabled={blocked(item)}
                aria-selected={idx === activeIndex}
                className={`agent-mention-item ${idx === activeIndex ? "is-active" : ""}`}
                onMouseEnter={() => setActiveIndex(idx)}
                onFocus={() => setActiveIndex(idx)}
                onClick={() => {
                  if (!blocked(item)) onSelect(item);
                }}
              >
                <MentionKindIcon kind={item.kind} />
                <span className="agent-mention-item-name">
                  {item.label}
                  {ep && (
                    <small className="agent-mention-item-sub">
                      {[ep.sourceFileName, ep.libraryName]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                  )}
                </span>
                <span className="agent-mention-item-kind">
                  {MENTION_KIND_LABELS[item.kind]}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function formatProposalHudSummary(proposal: PendingAgentProposal): string {
  const s = proposal.stats;
  if (s) {
    const parts: string[] = [];
    if (s.created > 0) parts.push(`新增 ${s.created} 层`);
    if (s.updated > 0) parts.push(`调整 ${s.updated} 层`);
    if (s.componentsInserted > 0) parts.push(`${s.componentsInserted} 个组件`);
    if (s.tokensBound > 0) parts.push(`${s.tokensBound} 处变量`);
    if (parts.length > 0) {
      return `预览中 · ${parts.join(" · ")}`;
    }
  }
  if (proposal.summary.trim()) {
    return `预览中 · ${proposal.summary.trim()}`;
  }
  return `预览中 · ${proposal.transaction.operations.length} 项改动`;
}

export function CanvasAgentBar({
  open,
  focusTick = 0,
  onClose,
  document,
  scopeProjectId,
  projectEpisodes,
  selection,
  selectionCount,
  status,
  pendingProposal,
  applyingProposal = false,
  busy,
  progressText,
  error,
  onOpenConfig,
  onSendPrompt,
  onCancel,
  onApplyProposal,
  onDiscardProposal,
  onOpenFullChat,
}: CanvasAgentBarProps) {
  const [prompt, setPrompt] = useState("");
  const [mentions, setMentions] = useState<AgentMention[]>([]);
  const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [localError, setLocalError] = useState("");

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selectedNode = useMemo(
    () => (selection ? document.nodes.find((n) => n.id === selection) : null),
    [document.nodes, selection],
  );
  const starters = useMemo(
    () => contextualStarters(selectedNode, document, selectionCount),
    [selectedNode, document, selectionCount],
  );

  useEffect(() => {
    if (!projectEpisodes) return;
    setMentions((previous) => {
      const scoped = previous.filter(
        (m) =>
          m.kind !== "episode" || projectEpisodes.some((ep) => ep.id === m.id),
      );
      return scoped.length === previous.length ? previous : scoped;
    });
  }, [projectEpisodes]);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    } else {
      setMentionOpen(false);
      setLocalError("");
    }
  }, [open, focusTick]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener(canvasScopeReady, onOpenFullChat);
    return () => window.removeEventListener(canvasScopeReady, onOpenFullChat);
  }, [open, onOpenFullChat]);

  // Auto-grow textarea cleanly up to 96px
  useEffect(() => {
    const el = textareaRef.current;
    if (!el || typeof el.scrollHeight !== "number") return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, [prompt, open]);

  if (!open && !pendingProposal) return null;

  const isConfigured = Boolean(status?.configured && status.activeProfile);
  const supportsVision = Boolean(
    status?.activeProfile?.capabilities.supportsVision,
  );
  const isProposalStale =
    pendingProposal != null &&
    pendingProposal.transaction.baseRevision !== document.revision;

  const scopeText = selectedNode
    ? `当前选区：${selectedNode.name}`
    : selectionCount > 1
      ? `已选 ${selectionCount} 个图层`
      : "新建画板 · 当前页面";

  function handleSubmit() {
    const trimmed = prompt.trim();
    if (!trimmed || busy) return;
    if (!isConfigured) {
      onOpenConfig();
      return;
    }
    setLocalError("");
    setMentionOpen(false);
    onSendPrompt({
      pageId: document.activePage,
      scopeProjectId:
        scopeProjectId ??
        resolveProjectMemoryScope({ fileKey: "forma.document.v1" })
          .scopeProjectId,
      prompt: trimmed,
      mentions,
      attachments:
        supportsVision && attachments.length ? attachments : undefined,
    });
    setPrompt("");
    setMentions([]);
    setAttachments([]);
  }

  function handleSelectMention(item: AgentMention) {
    if (item.kind === "episode" && episodeLimitReached(mentions)) {
      setLocalError(episodeMentionLimitNote);
      return;
    }
    setMentions((prev) =>
      prev.some((m) => m.kind === item.kind && m.id === item.id)
        ? prev
        : [...prev, item],
    );
    setPrompt((prev) =>
      prev.replace(/(?:^|\s)@[^\s@]*$/, (m) => (m.startsWith(" ") ? " " : "")),
    );
    setMentionOpen(false);
    setMentionQuery("");
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  async function handleAddImages(files: FileList | null) {
    if (!files || !files.length) return;
    setLocalError("");
    const next: AgentAttachment[] = [];
    for (const file of Array.from(files).slice(0, 3 - attachments.length)) {
      try {
        next.push(await readImageFileAsAttachment(file));
      } catch (err) {
        setLocalError(err instanceof Error ? err.message : "读取参考图失败");
      }
    }
    if (next.length) {
      setAttachments((prev) => [...prev, ...next].slice(0, 3));
    }
  }

  const displayError = error || localError;

  return (
    <div
      className="canvas-agent-stack"
      onPointerDown={(ev) => ev.stopPropagation()}
      onKeyDown={(ev) => {
        // Isolate keyboard input from canvas shortcuts (V, F, R, T, Space, Backspace)
        ev.stopPropagation();
        if (ev.key === "Escape" && !ev.nativeEvent.isComposing) {
          ev.preventDefault();
          if (mentionOpen) {
            setMentionOpen(false);
          } else if (open) {
            onClose();
          }
        }
      }}
    >
      {/* 1. Live Preview HUD */}
      {pendingProposal && (
        <div
          className="canvas-agent-hud"
          role="region"
          aria-label="AI 预览操作栏"
        >
          <span className="canvas-agent-hud-summary" role="status">
            {busy ? (
              <Loader2 size={14} className="agent-spin" aria-hidden="true" />
            ) : (
              <Sparkles
                size={14}
                style={{ color: "var(--figma-purple-soft)", flexShrink: 0 }}
              />
            )}
            <span title={formatProposalHudSummary(pendingProposal)}>
              {busy && !open && progressText
                ? progressText
                : formatProposalHudSummary(pendingProposal)}
            </span>
          </span>

          {isProposalStale && (
            <span className="canvas-agent-hud-stale" role="status">
              <AlertTriangle size={11} />
              画布已变更，请重新生成
            </span>
          )}

          <div className="canvas-agent-hud-actions">
            <button
              type="button"
              className="hud-accept"
              disabled={isProposalStale || applyingProposal}
              onClick={onApplyProposal}
            >
              <Check size={12} />
              采纳到画布
            </button>
            <button
              type="button"
              className="hud-refine"
              onClick={onOpenFullChat}
            >
              继续微调
            </button>
            <button
              type="button"
              className="hud-discard"
              onClick={onDiscardProposal}
            >
              丢弃
            </button>
          </div>
        </div>
      )}

      {/* 2. Canvas Inline Prompt Bar */}
      {open && (
        <div
          className="canvas-agent-bar"
          role="region"
          aria-label="画布 AI 快捷对话栏"
        >
          {mentionOpen && (
            <AgentMentionPopover
              document={document}
              episodes={projectEpisodes}
              attached={mentions}
              initialQuery={mentionQuery}
              onSelect={handleSelectMention}
              onClose={() => {
                setMentionOpen(false);
                requestAnimationFrame(() => textareaRef.current?.focus());
              }}
            />
          )}

          <div className="canvas-agent-bar-top">
            <span className="canvas-agent-scope-pill" title={scopeText}>
              <Sparkles size={11} style={{ flexShrink: 0 }} />
              {scopeText}
            </span>

            {/* Show active model chip ONLY when configured — eliminates duplicate unconnected nag */}
            {isConfigured && status?.activeProfile && (
              <button
                type="button"
                className="canvas-agent-model-chip"
                aria-label={`当前模型 ${status.activeProfile.providerName} ${status.activeProfile.selectedModel}，点击切换或配置`}
                data-tip="切换或管理 AI 模型"
                data-tip-side="top"
                onClick={onOpenConfig}
              >
                <span
                  className="agent-status-dot is-ready"
                  aria-hidden="true"
                />
                <span>
                  {compactModelLabel(status.activeProfile.selectedModel)}
                </span>
              </button>
            )}

            <div className="canvas-agent-top-right">
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label="展开完整 AI 对话面板"
                data-tip="打开侧栏完整对话"
                data-tip-desc="查看多轮对话、历史设计与更多创作偏好"
                data-tip-side="top"
                onClick={onOpenFullChat}
              >
                <MessageSquare size={13} />
              </button>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label="关闭画布 AI 对话栏"
                data-tip="关闭"
                data-tip-kbd="Esc"
                data-tip-side="top"
                onClick={onClose}
              >
                <X size={13} />
              </button>
            </div>
          </div>

          {(mentions.length > 0 || attachments.length > 0) && (
            <div className="agent-chips-row">
              {mentions.map((m) => (
                <span key={`${m.kind}:${m.id}`} className="agent-mention-chip">
                  <MentionKindIcon kind={m.kind} />
                  <span className="agent-chip-label">@{m.label}</span>
                  <button
                    type="button"
                    className="agent-chip-remove"
                    aria-label={`移除引用 ${m.label}`}
                    data-tip="移除引用"
                    data-tip-side="top"
                    onClick={() =>
                      setMentions((prev) =>
                        prev.filter(
                          (item) => !(item.kind === m.kind && item.id === m.id),
                        ),
                      )
                    }
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
              {attachments.map((att, idx) => (
                <span
                  key={`${att.name}:${idx}`}
                  className="agent-attachment-chip"
                >
                  <img
                    className="agent-attachment-thumb"
                    src={att.dataUrl}
                    alt={att.name}
                  />
                  <span className="agent-chip-label">{att.name}</span>
                  <button
                    type="button"
                    className="agent-chip-remove"
                    aria-label={`移除参考图 ${att.name}`}
                    data-tip="移除参考图"
                    data-tip-side="top"
                    onClick={() =>
                      setAttachments((prev) => prev.filter((_, i) => i !== idx))
                    }
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="canvas-agent-input-row">
            <button
              type="button"
              className={`icon-btn icon-btn-sm ${mentionOpen ? "active" : ""}`}
              aria-label="引用组件、变量、样式、画板或历史需求"
              aria-expanded={mentionOpen}
              data-tip="引用设计元素"
              data-tip-kbd="@"
              data-tip-desc="引用画布中的组件、样式变量或历史设计"
              data-tip-side="top"
              disabled={busy}
              onClick={() => {
                setMentionQuery("");
                setMentionOpen((v) => !v);
              }}
            >
              <AtSign size={14} />
            </button>

            <button
              type="button"
              className="icon-btn icon-btn-sm"
              aria-label="添加参考图"
              data-tip="添加参考图"
              data-tip-desc={
                !isConfigured
                  ? "连接支持识图的模型后可上传参考图"
                  : supportsVision
                    ? "上传截图或草图供 AI 参考（最多 3 张）"
                    : "当前模型未开启识图，可在模型设置中调整"
              }
              data-tip-side="top"
              disabled={
                busy ||
                !isConfigured ||
                !supportsVision ||
                attachments.length >= 3
              }
              onClick={() => fileInputRef.current?.click()}
            >
              <ImagePlus size={14} />
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              multiple
              hidden
              onChange={(ev) => {
                void handleAddImages(ev.currentTarget.files);
                ev.currentTarget.value = "";
              }}
            />

            <textarea
              ref={textareaRef}
              rows={1}
              aria-label="画布 AI 指令"
              placeholder={
                selectedNode
                  ? `描述想对「${selectedNode.name}」做的调整，输入 @ 可引用元素…`
                  : "描述想生成的页面或修改内容，输入 @ 可引用元素…"
              }
              value={prompt}
              disabled={busy}
              onChange={(ev) => {
                const val = ev.target.value;
                setPrompt(val);
                const inlineMatch = val.match(/(?:^|\s)@([^\s@]*)$/);
                if (inlineMatch) {
                  setMentionQuery(inlineMatch[1] ?? "");
                  setMentionOpen(true);
                } else if (mentionOpen && mentionQuery !== "") {
                  setMentionOpen(false);
                  setMentionQuery("");
                }
              }}
              onKeyDown={(ev) => {
                if (ev.nativeEvent.isComposing || ev.keyCode === 229) return;
                if (ev.key === "Enter" && !ev.shiftKey) {
                  ev.preventDefault();
                  handleSubmit();
                }
              }}
            />

            {busy ? (
              <button
                type="button"
                className="canvas-agent-stop-btn"
                aria-label="停止生成"
                data-tip="停止生成"
                data-tip-side="top"
                onClick={onCancel}
              >
                <Square size={10} fill="currentColor" />
                停止
              </button>
            ) : isConfigured ? (
              <button
                type="button"
                className="canvas-agent-send-btn"
                aria-label="发送 AI 指令"
                disabled={!prompt.trim()}
                onClick={handleSubmit}
              >
                <ArrowUp size={13} />
                生成
              </button>
            ) : (
              <button
                type="button"
                className="canvas-agent-send-btn"
                onClick={onOpenConfig}
              >
                连接模型
              </button>
            )}
          </div>

          {busy && (
            <div className="canvas-agent-progress" role="status">
              <Loader2 size={13} className="agent-spin" />
              <span>{progressText || "正在理解画布并构思设计方案…"}</span>
            </div>
          )}

          {displayError && (
            <p className="canvas-agent-error" role="alert">
              {displayError}
            </p>
          )}

          {!busy && !prompt.trim() && (
            <div className="canvas-agent-starters" aria-label="快捷设计提示">
              {starters.map((starter) => (
                <button
                  key={starter}
                  type="button"
                  className="canvas-agent-starter-chip"
                  onClick={() => {
                    setPrompt(starter);
                    requestAnimationFrame(() => textareaRef.current?.focus());
                  }}
                >
                  {starter}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
