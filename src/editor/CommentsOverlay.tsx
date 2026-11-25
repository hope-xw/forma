import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CheckCircle2,
  MessageSquare,
  RotateCcw,
  Search,
  Send,
  Trash2,
  X,
} from "lucide-react";
import type { CommentReply, DesignComment } from "../domain/document";
import type { Viewport } from "../domain/geometry";
import { useModalDialog } from "./useModalDialog";
import "./figma-panels.css";

export interface CommentsCanvasLayerProps {
  comments: DesignComment[];
  viewport: Viewport;
  activeCommentId: string | null;
  onSelectComment(id: string | null): void;
  onUpdateComments(comments: DesignComment[]): void;
}

export interface CommentsPanelProps {
  open: boolean;
  comments: DesignComment[];
  activeCommentId: string | null;
  onSelectComment(id: string | null): void;
  onUpdateComments(comments: DesignComment[]): void;
  onClose(): void;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso || "刚刚";
  const diffSec = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (diffSec < 60) return "刚刚";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${m}-${d} ${hh}:${mm}`;
}

function authorInitial(author: string): string {
  const trimmed = author.trim();
  return trimmed ? [...trimmed][0]!.toUpperCase() : "设";
}

export function CommentsCanvasLayer({
  comments,
  viewport,
  activeCommentId,
  onSelectComment,
  onUpdateComments,
}: CommentsCanvasLayerProps) {
  const [replyDraft, setReplyDraft] = useState("");
  const popoverRef = useRef<HTMLDivElement>(null);
  const replyInputRef = useRef<HTMLInputElement>(null);

  const activeIndex = useMemo(
    () => comments.findIndex((c) => c.id === activeCommentId),
    [comments, activeCommentId],
  );
  const activeComment = activeIndex >= 0 ? comments[activeIndex] : null;

  useEffect(() => {
    setReplyDraft("");
  }, [activeCommentId]);

  useEffect(() => {
    if (!activeComment) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onSelectComment(null);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [activeComment, onSelectComment]);

  const toggleResolve = (comment: DesignComment) => {
    onUpdateComments(
      comments.map((c) =>
        c.id === comment.id ? { ...c, resolved: !c.resolved } : c,
      ),
    );
  };

  const deleteComment = (id: string) => {
    onUpdateComments(comments.filter((c) => c.id !== id));
    if (activeCommentId === id) onSelectComment(null);
  };

  const deleteReply = (commentId: string, replyId: string) => {
    onUpdateComments(
      comments.map((c) =>
        c.id === commentId
          ? { ...c, replies: c.replies.filter((r) => r.id !== replyId) }
          : c,
      ),
    );
  };

  const submitReply = () => {
    if (!activeComment) return;
    const text = replyDraft.trim();
    if (!text) return;
    const reply: CommentReply = {
      id: crypto.randomUUID(),
      author: "设计师",
      text,
      createdAt: new Date().toISOString(),
    };
    onUpdateComments(
      comments.map((c) =>
        c.id === activeComment.id
          ? { ...c, replies: [...c.replies, reply] }
          : c,
      ),
    );
    setReplyDraft("");
    replyInputRef.current?.focus();
  };

  if (!comments.length) return null;

  const activeScreenX = activeComment
    ? activeComment.x * viewport.zoom + viewport.x
    : 0;
  const activeScreenY = activeComment
    ? activeComment.y * viewport.zoom + viewport.y
    : 0;

  return (
    <div className="fp-comments-layer" aria-label="画布评论图钉层">
      {comments.map((comment, idx) => {
        const left = comment.x * viewport.zoom + viewport.x;
        const top = comment.y * viewport.zoom + viewport.y;
        const isActive = comment.id === activeCommentId;
        return (
          <button
            key={comment.id}
            type="button"
            className={`fp-comment-pin ${isActive ? "is-active" : ""} ${comment.resolved ? "is-resolved" : ""}`}
            style={{ left, top }}
            aria-label={`评论 #${idx + 1}：${comment.author}${comment.resolved ? "（已解决）" : ""}`}
            aria-pressed={isActive}
            title={`#${idx + 1} ${comment.author}：${comment.text}`}
            data-tip={`评论 #${idx + 1} · ${comment.author}`}
            data-tip-desc={
              comment.text.length > 44
                ? `${comment.text.slice(0, 44)}…`
                : comment.text
            }
            data-tip-side="top"
            onPointerDown={(ev) => ev.stopPropagation()}
            onClick={(ev) => {
              ev.stopPropagation();
              onSelectComment(isActive ? null : comment.id);
            }}
          >
            {comment.resolved ? <Check size={12} strokeWidth={2.5} /> : idx + 1}
          </button>
        );
      })}

      {activeComment && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-modal="false"
          aria-label={`评论 #${activeIndex + 1} 讨论线程`}
          className="fp-comment-popover"
          style={{
            left: Math.max(12, activeScreenX + 20),
            top: Math.max(12, activeScreenY - 14),
          }}
          onPointerDown={(ev) => ev.stopPropagation()}
          onWheel={(ev) => ev.stopPropagation()}
          onClick={(ev) => ev.stopPropagation()}
        >
          <div className="fp-comment-popover-head">
            <span className="fp-comment-index">#{activeIndex + 1}</span>
            <span className="fp-comment-status-label">
              {activeComment.resolved ? "已解决" : "待处理"}
            </span>
            <div className="fp-comment-head-actions">
              <button
                type="button"
                className={`icon-btn icon-btn-sm ${activeComment.resolved ? "active" : ""}`}
                aria-label={
                  activeComment.resolved ? "重新打开评论" : "标记为已解决"
                }
                title={activeComment.resolved ? "重新打开评论" : "标记为已解决"}
                data-tip={activeComment.resolved ? "重新打开" : "标记已解决"}
                data-tip-desc={
                  activeComment.resolved
                    ? "将此评论重新置为待处理状态"
                    : "确认此评审意见已处理完成"
                }
                data-tip-side="top"
                onClick={() => toggleResolve(activeComment)}
              >
                {activeComment.resolved ? (
                  <RotateCcw size={13} />
                ) : (
                  <CheckCircle2 size={13} />
                )}
              </button>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label="删除评论"
                title="删除评论"
                data-tip="删除评论"
                data-tip-desc="永久删除这条画布评论及其所有回复"
                data-tip-side="top"
                onClick={() => deleteComment(activeComment.id)}
              >
                <Trash2 size={13} />
              </button>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label="关闭评论弹窗"
                title="关闭评论弹窗"
                data-tip="关闭"
                data-tip-kbd="Esc"
                data-tip-side="top"
                onClick={() => onSelectComment(null)}
              >
                <X size={13} />
              </button>
            </div>
          </div>

          <div className="fp-comment-thread">
            <div className="fp-comment-entry">
              <span className="fp-comment-avatar" aria-hidden="true">
                {authorInitial(activeComment.author)}
              </span>
              <div className="fp-comment-body">
                <div className="fp-comment-meta">
                  <strong>{activeComment.author}</strong>
                  <time>{formatTime(activeComment.createdAt)}</time>
                </div>
                <p className="fp-comment-text">{activeComment.text}</p>
              </div>
            </div>

            {activeComment.replies.map((reply) => (
              <div key={reply.id} className="fp-comment-entry is-reply">
                <span className="fp-comment-avatar is-reply" aria-hidden="true">
                  {authorInitial(reply.author)}
                </span>
                <div className="fp-comment-body">
                  <div className="fp-comment-meta">
                    <strong>{reply.author}</strong>
                    <time>{formatTime(reply.createdAt)}</time>
                    <button
                      type="button"
                      className="icon-btn icon-btn-sm fp-reply-delete"
                      aria-label="删除回复"
                      title="删除回复"
                      data-tip="删除回复"
                      data-tip-side="top"
                      onClick={() => deleteReply(activeComment.id, reply.id)}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                  <p className="fp-comment-text">{reply.text}</p>
                </div>
              </div>
            ))}
          </div>

          <form
            className="fp-comment-composer"
            onSubmit={(ev) => {
              ev.preventDefault();
              submitReply();
            }}
          >
            <input
              ref={replyInputRef}
              type="text"
              aria-label="回复评论"
              placeholder="输入回复… (Enter 发送)"
              value={replyDraft}
              onChange={(ev) => setReplyDraft(ev.target.value)}
            />
            <button
              type="submit"
              className="icon-btn icon-btn-sm fp-comment-send"
              disabled={!replyDraft.trim()}
              aria-label="发送回复"
              title="发送回复"
              data-tip="发送回复"
              data-tip-kbd="Enter"
              data-tip-side="top"
            >
              <Send size={13} />
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

export function CommentsPanel({
  open,
  comments,
  activeCommentId,
  onSelectComment,
  onUpdateComments,
  onClose,
}: CommentsPanelProps) {
  const [filter, setFilter] = useState<"open" | "resolved" | "all">("open");
  const [query, setQuery] = useState("");
  const dialogRef = useModalDialog(open, onClose, false);

  const counts = useMemo(() => {
    let resolved = 0;
    for (const c of comments) if (c.resolved) resolved++;
    return {
      open: comments.length - resolved,
      resolved,
      all: comments.length,
    };
  }, [comments]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return comments
      .map((comment, index) => ({ comment, number: index + 1 }))
      .filter(({ comment }) => {
        if (filter === "open" && comment.resolved) return false;
        if (filter === "resolved" && !comment.resolved) return false;
        if (!q) return true;
        return (
          comment.text.toLowerCase().includes(q) ||
          comment.author.toLowerCase().includes(q) ||
          comment.replies.some(
            (r) =>
              r.text.toLowerCase().includes(q) ||
              r.author.toLowerCase().includes(q),
          )
        );
      });
  }, [comments, filter, query]);

  if (!open) return null;

  const toggleResolve = (id: string) => {
    onUpdateComments(
      comments.map((c) => (c.id === id ? { ...c, resolved: !c.resolved } : c)),
    );
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="false"
      aria-label="画布评论列表"
      tabIndex={-1}
      className="fp-floating-panel fp-comments-panel"
    >
      <div className="fp-panel-header">
        <div className="fp-panel-title">
          <MessageSquare size={14} aria-hidden="true" />
          <strong>画布评论</strong>
          <span className="fp-count-pill">{counts.open}</span>
        </div>
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          aria-label="关闭评论面板"
          title="关闭评论面板"
          data-tip="关闭评论面板"
          data-tip-kbd="Esc"
          data-tip-side="left"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>

      <div className="fp-comments-controls">
        <div className="fp-segmented" role="tablist" aria-label="评论状态筛选">
          {(
            [
              ["open", "未解决", counts.open],
              ["resolved", "已解决", counts.resolved],
              ["all", "全部", counts.all],
            ] as const
          ).map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={filter === key}
              className={filter === key ? "is-active" : ""}
              onClick={() => setFilter(key)}
            >
              {label}
              <span>{count}</span>
            </button>
          ))}
        </div>

        {comments.length > 0 && (
          <label className="fp-search-box">
            <Search size={12} aria-hidden="true" />
            <input
              type="search"
              aria-label="搜索评论"
              placeholder="搜索评论或作者…"
              value={query}
              onChange={(ev) => setQuery(ev.target.value)}
            />
          </label>
        )}
      </div>

      <div className="fp-comments-list">
        {filtered.length === 0 ? (
          <div className="fp-empty-state">
            <MessageSquare size={22} className="fp-empty-state-icon" />
            <strong>
              {comments.length === 0 ? "尚无画布评论" : "没有匹配的评论"}
            </strong>
            <p>按 C 工具在画布任意位置添加评审评论</p>
          </div>
        ) : (
          filtered.map(({ comment, number }) => {
            const active = comment.id === activeCommentId;
            return (
              <div
                key={comment.id}
                className={`fp-comment-card ${active ? "is-active" : ""} ${comment.resolved ? "is-resolved" : ""}`}
              >
                <button
                  type="button"
                  className="fp-comment-card-main"
                  onClick={() => onSelectComment(comment.id)}
                >
                  <div className="fp-comment-card-head">
                    <span className="fp-comment-index">#{number}</span>
                    <strong>{comment.author}</strong>
                    <time>{formatTime(comment.createdAt)}</time>
                  </div>
                  <p className="fp-comment-card-text">{comment.text}</p>
                  <div className="fp-comment-card-foot">
                    <span>
                      {comment.replies.length > 0
                        ? `${comment.replies.length} 条回复`
                        : "点击定位并回复"}
                    </span>
                    {comment.resolved && (
                      <span className="fp-badge-green">已解决</span>
                    )}
                  </div>
                </button>
                <button
                  type="button"
                  className="icon-btn icon-btn-sm fp-comment-card-resolve"
                  aria-label={comment.resolved ? "重新打开评论" : "标记已解决"}
                  title={comment.resolved ? "重新打开评论" : "标记已解决"}
                  data-tip={comment.resolved ? "重新打开" : "标记已解决"}
                  data-tip-side="left"
                  onClick={() => toggleResolve(comment.id)}
                >
                  {comment.resolved ? (
                    <RotateCcw size={13} />
                  ) : (
                    <CheckCircle2 size={13} />
                  )}
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
