import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUp,
  AtSign,
  Box,
  Check,
  Component,
  ImagePlus,
  Loader2,
  MessageSquare,
  Palette,
  Search,
  Settings2,
  Sparkles,
  Square,
  Variable,
  X,
} from "lucide-react";
import type { DesignDocument } from "../domain/document";
import {
  collectDocumentMentions,
  readImageFileAsAttachment,
  type AgentAttachment,
  type AgentMention,
  type AgentStatusResponse,
  type PendingAgentProposal,
} from "./agent-client";
import "./agent-ui.css";

export type { PendingAgentProposal };
export const canvasScopeReady = "forma:canvas-scope-ready";

export interface CanvasAgentBarProps {
  open: boolean;
  focusTick?: number;
  onClose(): void;
  document: DesignDocument;
  selection: string | null;
  selectionCount: number;
  viewportCenter?: { x: number; y: number };
  status: AgentStatusResponse | null;
  pendingProposal: PendingAgentProposal | null;
  busy: boolean;
  progressText: string;
  error: string;
  onOpenConfig(): void;
  onSendPrompt(input: {
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
};

function contextualStarters(
  selectedNode: DesignDocument["nodes"][number] | null | undefined,
  document: DesignDocument,
  selectionCount: number,
): string[] {
  if (selectionCount > 1) {
    return [
      "统一选中图层的配色与圆角",
      "整理为等距卡片布局",
      "优化字体与视觉层级",
      "转为深色主题风格",
    ];
  }
  if (!selectedNode) {
    return [
      "生成 H5 登录页",
      "生成 SaaS 看板",
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
        "为此画板生成完整移动端界面",
        "添加顶部导航栏与内容卡片列表",
        "生成现代登录与注册表单",
        "添加数据指标卡片与底部导航",
      ];
    }
    return [
      "优化此画板的留白与视觉层次",
      "切换为深色主题风格",
      "整理内部元素为自动布局",
      "新增一个功能亮点卡片区",
    ];
  }
  if (selectedNode.type === "text") {
    return [
      "润色文案更简洁专业",
      "翻译为地道英文",
      "改写为高转化率产品标题",
      "优化字号与对比度",
    ];
  }
  return [
    "优化圆角、配色与阴影质感",
    "切换为高亮主视觉风格",
    "绑定到当前设计系统变量",
    "在旁边生成一组状态变体",
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
  }
}

export function AgentMentionPopover({
  document,
  attached,
  initialQuery = "",
  placement = "top",
  onSelect,
  onClose,
}: {
  document: DesignDocument;
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

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const allItems = useMemo(() => collectDocumentMentions(document), [document]);
  const attachedKeys = useMemo(
    () => new Set(attached.map((m) => `${m.kind}:${m.id}`)),
    [attached],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allItems.filter((item) => {
      if (attachedKeys.has(`${item.kind}:${item.id}`)) return false;
      if (kindFilter !== "all" && item.kind !== kindFilter) return false;
      if (!q) return true;
      return (
        item.label.toLowerCase().includes(q) ||
        item.id.toLowerCase().includes(q) ||
        MENTION_KIND_LABELS[item.kind].includes(q)
      );
    });
  }, [allItems, attachedKeys, kindFilter, query]);

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
        if (ev.key === "Escape") {
          ev.preventDefault();
          onClose();
        } else if (ev.key === "ArrowDown") {
          ev.preventDefault();
          setActiveIndex((i) =>
            filtered.length ? (i + 1) % filtered.length : 0,
          );
        } else if (ev.key === "ArrowUp") {
          ev.preventDefault();
          setActiveIndex((i) =>
            filtered.length ? (i - 1 + filtered.length) % filtered.length : 0,
          );
        } else if (ev.key === "Enter" && filtered[activeIndex]) {
          ev.preventDefault();
          onSelect(filtered[activeIndex]);
        }
      }}
    >
      <div className="agent-mention-search-row">
        <Search size={12} />
        <input
          ref={inputRef}
          type="text"
          aria-label="搜索组件、变量、样式或画板"
          placeholder="搜索组件、变量、样式或画板…"
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
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={kindFilter === k}
            className={kindFilter === k ? "active" : ""}
            onClick={() => setKindFilter(k)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="agent-mention-list" role="listbox" aria-label="可引用项">
        {filtered.length === 0 ? (
          <div className="agent-mention-empty">
            {allItems.length === 0
              ? "当前文档暂无可引用的组件、变量或画板"
              : "没有匹配的引用项"}
          </div>
        ) : (
          filtered.slice(0, 40).map((item, idx) => (
            <button
              key={`${item.kind}:${item.id}`}
              type="button"
              role="option"
              aria-selected={idx === activeIndex}
              className={`agent-mention-item ${idx === activeIndex ? "is-active" : ""}`}
              onMouseEnter={() => setActiveIndex(idx)}
              onClick={() => onSelect(item)}
            >
              <MentionKindIcon kind={item.kind} />
              <span className="agent-mention-item-name">{item.label}</span>
              <span className="agent-mention-item-kind">
                {MENTION_KIND_LABELS[item.kind]}
              </span>
            </button>
          ))
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
    if (s.updated > 0) parts.push(`修改 ${s.updated} 层`);
    if (s.componentsInserted > 0) parts.push(`${s.componentsInserted} 个组件`);
    if (s.tokensBound > 0) parts.push(`${s.tokensBound} 处变量`);
    if (parts.length > 0) {
      return `Forma AI 预览中 · ${parts.join(" / ")}`;
    }
  }
  if (proposal.summary.trim()) {
    return `Forma AI 预览中 · ${proposal.summary.trim()}`;
  }
  return `Forma AI 预览中 · ${proposal.transaction.operations.length} 项改动`;
}

export function CanvasAgentBar({
  open,
  focusTick = 0,
  onClose,
  document,
  selection,
  selectionCount,
  viewportCenter,
  status,
  pendingProposal,
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
    if (!el) return;
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
      ? `已选 ${selectionCount} 层 · 当前页面`
      : viewportCenter
        ? `在画布空白处生成 (${Math.round(viewportCenter.x)}, ${Math.round(viewportCenter.y)})`
        : "在画布空白处生成";

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
    setMentions((prev) =>
      prev.some((m) => m.kind === item.kind && m.id === item.id)
        ? prev
        : [...prev, item],
    );
    // Strip trailing inline @query if it opened the popover
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
      {/* 1. Live Preview HUD (visible whenever a pendingProposal exists) */}
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
              文件已变更，请重新生成
            </span>
          )}

          <div className="canvas-agent-hud-actions">
            <button
              type="button"
              className="hud-accept"
              disabled={isProposalStale}
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

            <button
              type="button"
              className="canvas-agent-model-chip"
              aria-label={
                isConfigured
                  ? `当前模型 ${status?.activeProfile?.providerName} ${status?.activeProfile?.selectedModel}，点击切换或配置`
                  : "配置 AI 模型供应商"
              }
              title="配置或切换 AI 模型"
              data-tip={
                isConfigured ? "切换或配置 AI 模型" : "配置 AI 模型供应商"
              }
              data-tip-side="top"
              onClick={onOpenConfig}
            >
              <span
                className={`agent-status-dot ${isConfigured ? "is-ready" : ""}`}
                aria-hidden="true"
              />
              <span>
                {isConfigured && status?.activeProfile
                  ? `${status.activeProfile.providerName} · ${status.activeProfile.selectedModel}`
                  : "未配置模型 · 点击连接"}
              </span>
            </button>

            <div className="canvas-agent-top-right">
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label="展开完整 AI 对话面板"
                title="展开完整 AI 对话面板"
                data-tip="打开 Forma AI"
                data-tip-desc="在左侧选择生成模式、视觉自审和本轮技能，查看对话详情"
                data-tip-side="top"
                onClick={onOpenFullChat}
              >
                <MessageSquare size={13} />
              </button>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label="关闭画布 AI 对话栏"
                title="关闭画布 AI 对话栏"
                data-tip="关闭画布 AI 栏"
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
                    title={`移除引用 ${m.label}`}
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
                    title={`移除参考图 ${att.name}`}
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
              aria-label="引用组件、变量、样式或画板"
              aria-expanded={mentionOpen}
              title="引用设计元素 @"
              data-tip="引用设计元素"
              data-tip-kbd="@"
              data-tip-desc="在提示中指定当前文档的组件、变量、样式或画板"
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
              title="添加参考图"
              data-tip="添加视觉参考图"
              data-tip-desc={
                !isConfigured
                  ? "请先配置支持视觉识图的模型"
                  : supportsVision
                    ? "上传截图或线框图，AI 将参考其布局与风格（最多 3 张）"
                    : "可在模型设置 → 已保存连接中刷新或手动开启视觉"
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
                isConfigured
                  ? "告诉 Forma AI 要生成或修改什么，输入 @ 引用组件…（Enter 发送，⇧Enter 换行）"
                  : "连接模型后，用 Forma AI 生成可编辑画板…"
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
                title="停止生成"
                data-tip="停止生成"
                data-tip-side="top"
                onClick={onCancel}
              >
                <Square size={11} />
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
                <Settings2 size={12} />
                配置模型
              </button>
            )}
          </div>

          {busy && (
            <div className="canvas-agent-progress" role="status">
              <Loader2 size={13} className="agent-spin" />
              <span>{progressText || "Forma AI 正在分析画布并构思设计…"}</span>
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
