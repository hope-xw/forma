import {
  AlertTriangle,
  BookOpen,
  Check,
  History,
  Sparkles,
} from "lucide-react";
import type { DesignDocument } from "../../domain/document";
import type { AgentChatResult, ScopeProposal } from "../agent-client";
import { MentionKindIcon, type PendingAgentProposal } from "../CanvasAgentBar";
import {
  formatOperationType,
  formatToolName,
  mentionIdentity,
  SCREEN_ROLE_LABELS,
  type ChatMessage,
} from "./agent-copy";

export function StatsPills({ stats }: { stats: AgentChatResult["stats"] }) {
  const items: { label: string; cls: string }[] = [];
  if (stats.created > 0)
    items.push({ label: `+${stats.created} 图层`, cls: "is-green" });
  if (stats.updated > 0)
    items.push({ label: `~${stats.updated} 调整`, cls: "is-blue" });
  if (stats.removed > 0)
    items.push({ label: `-${stats.removed} 移除`, cls: "" });
  if (stats.componentsInserted > 0)
    items.push({
      label: `${stats.componentsInserted} 组件`,
      cls: "is-purple",
    });
  if (stats.tokensBound > 0)
    items.push({ label: `${stats.tokensBound} 变量`, cls: "is-blue" });
  if (!items.length) return null;
  return (
    <div className="agent-cap-pills">
      {items.map((item, idx) => (
        <span key={idx} className={`agent-cap-pill ${item.cls}`}>
          {item.label}
        </span>
      ))}
    </div>
  );
}

export function ScopeProposalCard({
  scope,
  confirmed,
  disabled,
  choices,
  invalidatedReason,
  onChoice,
  onConfirm,
}: {
  scope: ScopeProposal;
  confirmed: boolean;
  disabled: boolean;
  choices: string[];
  invalidatedReason?: string;
  onChoice: (index: number, choice: string) => void;
  onConfirm: () => void;
}) {
  const libraryLabel = scope.targetLibraryName ?? scope.targetLibraryId;
  return (
    <div className="agent-scope-card" role="group" aria-label="生成范围确认">
      <div className="agent-scope-heading">
        <strong>方案范围</strong>
        {libraryLabel && (
          <span className="agent-scope-library">{libraryLabel}</span>
        )}
      </div>
      <p>{scope.summary}</p>
      <ol className="agent-scope-screens">
        {scope.screens.map((screen) => (
          <li key={screen.refId}>
            <div>
              <strong>{screen.name}</strong>
              <span>{SCREEN_ROLE_LABELS[screen.role]}</span>
            </div>
            <small>
              {screen.width} × {screen.height}
            </small>
            <p>{screen.summary}</p>
          </li>
        ))}
      </ol>
      {!!scope.reusedAssets.length && (
        <p className="agent-scope-meta">
          <strong>复用组件</strong> · {scope.reusedAssets.join("、")}
        </p>
      )}
      {!!scope.customModules.length && (
        <p className="agent-scope-meta">
          <strong>新建模块</strong> · {scope.customModules.join("、")}
        </p>
      )}
      {scope.decisions?.map((decision, i) => (
        <fieldset
          key={i}
          disabled={disabled || confirmed || !!invalidatedReason}
        >
          <legend>{decision.question}</legend>
          <div>
            {[
              ...new Set([
                decision.defaultChoice,
                ...(decision.alternatives ?? []),
              ]),
            ].map((choice) => (
              <button
                type="button"
                key={choice}
                aria-pressed={choices[i] === choice}
                onClick={() => onChoice(i, choice)}
              >
                {choice}
              </button>
            ))}
          </div>
        </fieldset>
      ))}
      {invalidatedReason && (
        <p className="agent-scope-invalid" role="status">
          {invalidatedReason}
        </p>
      )}
      <button
        type="button"
        className="primary wide"
        disabled={disabled || confirmed || !!invalidatedReason}
        onClick={onConfirm}
      >
        {confirmed ? "范围已确认" : "确认并直接生成"}
      </button>
    </div>
  );
}

export function CallDetails({ message }: { message: ChatMessage }) {
  const {
    toolTrace = [],
    activatedSkills = [],
    diagnostics = [],
    critiqueNotes = [],
    recalledEpisodes = [],
  } = message;
  if (
    !toolTrace.length &&
    !activatedSkills.length &&
    !diagnostics.length &&
    !critiqueNotes.length &&
    !recalledEpisodes.length
  )
    return null;

  const summaryParts: string[] = [];
  if (toolTrace.length > 0) summaryParts.push(`${toolTrace.length} 步操作`);
  if (activatedSkills.length > 0)
    summaryParts.push(`${activatedSkills.length} 项技能`);
  if (critiqueNotes.length > 0) summaryParts.push("含视觉优化");
  if (diagnostics.length > 0) summaryParts.push(`${diagnostics.length} 条提醒`);

  return (
    <details className="agent-call-details">
      <summary>
        生成过程
        {summaryParts.length > 0 ? ` · ${summaryParts.join(" · ")}` : ""}
      </summary>
      {recalledEpisodes.length > 0 && (
        <div className="agent-detail-block">
          <strong>参考的历史设计</strong>
          <ul aria-label="参考的项目记忆">
            {recalledEpisodes.map((ep) => (
              <li key={ep.id}>
                <span>{ep.title}</span>
                <small> · {ep.sourceFileName}</small>
                {!!ep.matchReasons?.length && (
                  <div className="agent-skill-meta">
                    {ep.matchReasons.join(" · ")}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {critiqueNotes.length > 0 && (
        <div className="agent-critique-notes">
          <strong>画面细节优化</strong>
          <ul>
            {critiqueNotes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </div>
      )}
      {toolTrace.length > 0 && (
        <ol className="agent-trace-list">
          {toolTrace.map((item, i) => (
            <li key={i}>
              <div className="agent-tool-step">
                <span className="agent-tool-human">
                  {formatToolName(item.name)}
                </span>
                <span className="agent-cap-pill" data-status={item.status}>
                  {{ ok: "完成", warning: "提醒", error: "失败" }[item.status]}
                </span>
              </div>
              <span className="agent-skill-meta">
                {item.summary}
                {" · "}
                <code className="agent-tool-raw">{item.name}</code>
              </span>
              {item.detail && <p>{item.detail}</p>}
            </li>
          ))}
        </ol>
      )}
      {activatedSkills.length > 0 && (
        <div className="agent-chips-row" aria-label="已激活技能">
          {activatedSkills.map((name) => (
            <span className="agent-skill-badge" key={name}>
              <BookOpen size={10} />
              {name}
            </span>
          ))}
        </div>
      )}
      {diagnostics.map((d, i) => (
        <p key={i} className="agent-diagnostic" data-severity={d.severity}>
          <strong>{d.severity === "error" ? "错误" : "提醒"}</strong> ·{" "}
          {d.message}
          {d.suggestion && <span>{d.suggestion}</span>}
        </p>
      ))}
    </details>
  );
}

export function ProposalPreviewCard({
  proposal,
  document,
  applying,
  focusNode,
  onApply,
  onDiscard,
}: {
  proposal: PendingAgentProposal;
  document: DesignDocument;
  applying: boolean;
  focusNode?(id: string): void;
  onApply(): void;
  onDiscard(): void;
}) {
  const isStale = proposal.transaction.baseRevision !== document.revision;
  const opCount = proposal.transaction.operations.length;

  return (
    <div className="proposal" role="region" aria-label="设计预览待确认">
      <div className="agent-proposal-head">
        <h3>
          <Sparkles size={13} className="agent-accent-purple" />
          设计预览已就绪
        </h3>
        <span className="agent-proposal-count">{opCount} 项变动</span>
      </div>
      {proposal.summary && (
        <p className="agent-proposal-summary">{proposal.summary}</p>
      )}
      {proposal.stats && <StatsPills stats={proposal.stats} />}
      {isStale && (
        <p className="agent-proposal-stale" role="status">
          <AlertTriangle size={12} />
          画布在生成后已有改动，请重新生成以应用
        </p>
      )}
      <details className="agent-proposal-ops">
        <summary>查看改动明细（{opCount} 项）</summary>
        <ul>
          {proposal.transaction.operations.map((op, i) => {
            const id =
              op.type === "create"
                ? op.node.parentId
                : op.type === "insertComponent"
                  ? op.parentId
                  : "id" in op &&
                      !["putToken", "putImage", "putFont"].includes(op.type)
                    ? op.id
                    : undefined;
            const target = document.nodes.find((n) => n.id === id);
            const targetName =
              op.type === "create"
                ? op.node.name
                : op.type === "insertComponent"
                  ? op.componentId
                  : op.type === "putLibrary" || op.type === "updateLibrary"
                    ? op.library.name
                    : (target?.name ?? ("id" in op ? op.id : "设计规范"));
            const verb = formatOperationType(op.type);
            return (
              <li key={i}>
                {target && focusNode ? (
                  <button
                    type="button"
                    className="agent-op-link"
                    data-tip={`在画布定位「${target.name}」`}
                    onClick={() => focusNode(target.id)}
                  >
                    <span className="agent-op-verb">{verb}</span>
                    <span className="agent-op-target">{targetName}</span>
                  </button>
                ) : (
                  <span className="agent-op-row">
                    <span className="agent-op-verb">{verb}</span>
                    <span className="agent-op-target">{targetName}</span>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </details>
      <div className="agent-proposal-actions">
        <button
          type="button"
          className="primary"
          disabled={applying || isStale}
          onClick={onApply}
        >
          <Check size={13} />
          应用到画布
        </button>
        <button type="button" onClick={onDiscard}>
          丢弃
        </button>
      </div>
    </div>
  );
}

export function ChatMessageItem({
  msg,
  isLatestAssistant,
  scopeDisabled,
  invalidatedReason,
  onScopeChoice,
  onScopeConfirm,
}: {
  msg: ChatMessage;
  isLatestAssistant: boolean;
  scopeDisabled: boolean;
  invalidatedReason?: string;
  onScopeChoice(index: number, choice: string): void;
  onScopeConfirm(): void;
}) {
  return (
    <div
      className={`agent-msg ${msg.role === "user" ? "agent-msg-user" : "agent-msg-assistant"}`}
    >
      <div className="agent-msg-head">
        <span className="agent-msg-role" title={msg.modelUsed || undefined}>
          {msg.role === "user" ? "我" : "Forma AI"}
        </span>
        {!!msg.recalledEpisodes?.length && (
          <span
            className="agent-memory-recall-pill"
            data-tip={msg.recalledEpisodes
              .map((ep) => [ep.title, ...(ep.matchReasons ?? [])].join(" · "))
              .join("\n")}
          >
            <History size={10} />
            参考 {msg.recalledEpisodes.length} 条记忆
          </span>
        )}
        {msg.applied && (
          <span className="agent-msg-badge">
            <Check size={10} />
            已应用
          </span>
        )}
        {msg.discarded && (
          <span className="agent-msg-badge is-discarded">已丢弃</span>
        )}
      </div>

      {msg.mentions && msg.mentions.length > 0 && (
        <div className="agent-chips-row">
          {msg.mentions.map((m) => (
            <span key={mentionIdentity(m)} className="agent-mention-chip">
              <MentionKindIcon kind={m.kind} />
              <span className="agent-chip-label">@{m.label}</span>
            </span>
          ))}
        </div>
      )}

      {msg.attachments && msg.attachments.length > 0 && (
        <div className="agent-chips-row">
          {msg.attachments.map((att, idx) => (
            <span key={`${att.name}:${idx}`} className="agent-attachment-chip">
              <img
                className="agent-attachment-thumb"
                src={att.dataUrl}
                alt={att.name}
              />
              <span className="agent-chip-label">{att.name}</span>
            </span>
          ))}
        </div>
      )}

      <div className="agent-msg-text">{msg.text}</div>

      {msg.scopeProposal && (
        <ScopeProposalCard
          scope={msg.scopeProposal}
          choices={
            msg.scopeChoices ??
            msg.scopeProposal.decisions?.map((d) => d.defaultChoice) ??
            []
          }
          invalidatedReason={invalidatedReason}
          onChoice={onScopeChoice}
          confirmed={!!msg.scopeConfirmed}
          disabled={scopeDisabled || !isLatestAssistant}
          onConfirm={onScopeConfirm}
        />
      )}
      {msg.stats && <StatsPills stats={msg.stats} />}
      {msg.role === "assistant" && <CallDetails message={msg} />}
    </div>
  );
}
