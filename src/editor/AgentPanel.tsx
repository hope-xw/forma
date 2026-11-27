import {
  ArrowUp,
  AtSign,
  BookOpen,
  Check,
  CheckCircle2,
  FolderOpen,
  History,
  ImagePlus,
  Loader2,
  Package,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  X,
} from "lucide-react";

import { AgentMentionPopover, MentionKindIcon } from "./CanvasAgentBar";
import { ModelConfigModal } from "./ModelConfigModal";
import { SkillsModal } from "./SkillsModal";
import { compactModelLabel, mentionIdentity } from "./agent/agent-copy";
import { EpisodeDrawer } from "./agent/EpisodeDrawer";
import { ChatMessageItem, ProposalPreviewCard } from "./agent/ChatMessageItem";
import { useAgentSession, type AgentPanelProps } from "./agent/useAgentSession";
import "./agent-ui.css";

export type { AgentPanelProps } from "./agent/useAgentSession";
export type {
  AppliedProposalEvent,
  ExternalChatRequest,
} from "./agent/agent-copy";
export {
  archiveAppliedProposal,
  projectMemoryReadErrorMessage,
  projectMemoryUnavailableNotice,
  readFileProjectEpisodes,
  useEpisodeArchive,
} from "./agent/EpisodeDrawer";
export {
  staleProposalMessage,
  scopeProblem,
  chatGeneration,
  composeConfirmedScope,
  capturePickerMention,
} from "../application/agent-session";

type AgentSession = ReturnType<typeof useAgentSession>;

export function AgentPanel(props: AgentPanelProps) {
  const { header, drawer, conversation, composer, skillsModal, modelConfig } =
    useAgentSession(props);
  return (
    <div className="panel-body agent-panel-root">
      <PanelHeader {...header} />
      {drawer && <EpisodeDrawer key={drawer.scopeProjectId} {...drawer} />}
      <Conversation {...conversation} />
      <Composer {...composer} />
      {skillsModal && <SkillsModal {...skillsModal} />}
      {modelConfig && <ModelConfigModal {...modelConfig} />}
    </div>
  );
}

function PanelHeader(view: AgentSession["header"]) {
  return (
    <>
      <div className="agent-panel-header">
        <div className="agent-header-brand">
          <Sparkles
            size={14}
            style={{ color: "var(--figma-blue)", flexShrink: 0 }}
          />
          <strong>Forma AI</strong>
          <span
            className="agent-scope-badge"
            title={
              view.selectedNode
                ? `当前选区：${view.selectedNode.name}`
                : view.selectionCount > 1
                  ? `已选 ${view.selectionCount} 层`
                  : "作用于当前页面"
            }
          >
            {view.scopeBadgeLabel}
          </span>
        </div>

        <div className="agent-header-actions">
          <button
            ref={view.drawerToggleRef}
            type="button"
            className={`icon-btn icon-btn-sm agent-header-memory-btn ${view.memoryDrawerOpen ? "active" : ""}`}
            aria-label="历史需求档案"
            data-tip="设计记忆"
            data-tip-desc={
              view.episodes.length > 0
                ? `${view.memoryScope.scopeLabel} · ${view.episodes.length} 条历史记录`
                : "查看或归档当前画板，供后续 @引用"
            }
            data-tip-side="bottom"
            aria-expanded={view.memoryDrawerOpen}
            onClick={view.toggleMemory}
          >
            <History size={14} />
            {view.episodes.length > 0 && (
              <span className="agent-header-badge" aria-hidden="true">
                {view.episodes.length > 99 ? "99+" : view.episodes.length}
              </span>
            )}
          </button>

          <button
            type="button"
            className="icon-btn icon-btn-sm agent-header-skills-btn"
            aria-label="管理设计技能（Skills）"
            data-tip="设计技能"
            data-tip-desc="管理或导入 SKILL.md 设计规范与风格技能"
            data-tip-side="bottom"
            aria-haspopup="dialog"
            onClick={view.openSkillsManager}
          >
            <BookOpen size={14} />
          </button>

          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="配置模型供应商"
            data-tip="模型连接设置"
            data-tip-desc={
              view.activeModelSummary ||
              "配置 OpenAI、Claude、Gemini、DeepSeek 等模型"
            }
            data-tip-side="bottom"
            onClick={view.openModelConfig}
          >
            <Settings2 size={14} />
          </button>

          {view.hasMessages && (
            <button
              type="button"
              className="icon-btn icon-btn-sm"
              aria-label="清空对话历史"
              data-tip="开启新对话"
              data-tip-desc="清空当前对话记录，开始新的设计主题"
              data-tip-side="bottom"
              disabled={view.busy}
              onClick={view.clearHistory}
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>

      {/* Optional subtle Project Space bar — only visible when assigned to a project or missing project library */}
      {view.showProjectContextStrip && (
        <div className="agent-project-strip">
          <button
            type="button"
            className="agent-project-strip-label"
            data-tip={view.memoryScope.scopeLabel}
            data-tip-desc="点击管理项目空间与归属文件"
            data-tip-side="bottom"
            disabled={!view.onOpenFileBrowser}
            onClick={view.onOpenFileBrowser}
          >
            <FolderOpen size={12} />
            <span>
              {view.activeProject === undefined
                ? "正在确认项目…"
                : view.activeProject
                  ? `项目记忆 · ${view.activeProject.name}`
                  : "当前文件"}
            </span>
          </button>
          {view.installDefaultLibrary && (
            <button
              type="button"
              className="agent-memory-install"
              aria-label="载入项目默认库"
              data-tip="将此项目绑定的默认组件库载入当前文件"
              data-tip-side="bottom"
              disabled={view.installingLibrary}
              onClick={view.installDefaultLibrary}
            >
              载入项目默认库
            </button>
          )}
        </div>
      )}

      {view.lifetimeInvalid && (
        <p role="status" className="agent-lifetime-banner">
          当前文件已在其他窗口更新或删除，请重新打开文件以恢复项目记忆
        </p>
      )}
    </>
  );
}

function Conversation(view: AgentSession["conversation"]) {
  return (
    <div className="agent-workspace-scroll">
      {view.isEmptyConversation ? (
        <div className="agent-welcome">
          <div className="agent-welcome-hero">
            <span className="agent-welcome-mark" aria-hidden="true">
              <Sparkles size={16} />
            </span>
            <h3>
              {view.selectedNode
                ? `要如何优化「${view.selectedNode.name}」？`
                : view.selectionCount > 1
                  ? `要如何调整已选的 ${view.selectionCount} 个图层？`
                  : "想设计什么界面？"}
            </h3>
            <p>
              {view.hasSelection
                ? "可以直接调整排版、配色、文案，或整理为自动布局。"
                : "描述页面目标与视觉方向，基于设计系统生成可编辑画板。"}
            </p>
          </div>

          {view.connection !== "ready" && (
            <div className="agent-connect-card">
              <div className="agent-connect-status" role="status">
                <i
                  aria-hidden="true"
                  className={`agent-status-dot ${
                    view.connection === "unavailable"
                      ? "is-unavailable"
                      : view.connection === "checking"
                        ? "is-checking"
                        : ""
                  }`}
                />
                <span>
                  {view.connection === "checking"
                    ? "正在检测本地服务…"
                    : view.connection === "unavailable"
                      ? "模型服务暂不可用"
                      : "未连接模型"}
                </span>
              </div>
              {view.connection !== "checking" && (
                <>
                  <p>
                    {view.statusNote ||
                      "连接 AI 模型即可对话创作，手动编辑与导出不受影响。"}
                  </p>
                  <div className="agent-connect-actions">
                    <button
                      type="button"
                      className="primary"
                      onClick={view.openModelConfig}
                    >
                      配置模型
                    </button>
                    <button
                      type="button"
                      className="agent-connect-probe"
                      aria-label="连接模型服务"
                      data-tip="检测本机已保存的模型配置"
                      data-tip-side="bottom"
                      onClick={() => void view.connect()}
                    >
                      检测本地连接
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          <div className="agent-starters-block">
            <span className="agent-starters-label">试试这样说</span>
            <div className="agent-quick-chips" aria-label="快捷设计需求">
              {view.quickPrompts.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  className="agent-quick-chip"
                  onClick={() => view.choosePrompt(chip)}
                >
                  {chip}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="agent-chat-thread" role="log" aria-label="AI 对话记录">
          {view.messages.map((msg) => (
            <ChatMessageItem key={msg.id} {...view.messageProps(msg)} />
          ))}

          {/* Live Streaming Progress Timeline */}
          {view.busy && view.progressSteps.length > 0 && (
            <div
              className="agent-progress-timeline"
              role="status"
              aria-live="polite"
            >
              {view.progressSteps.map((step, idx) => {
                const isLatest = idx === view.progressSteps.length - 1;
                return (
                  <div
                    key={`${step.stage}:${idx}`}
                    className={`agent-progress-step ${isLatest ? "is-latest" : ""}`}
                  >
                    {isLatest ? (
                      <Loader2
                        size={12}
                        className="agent-spin"
                        style={{
                          color: "var(--figma-blue)",
                          flexShrink: 0,
                          marginTop: 2,
                        }}
                      />
                    ) : (
                      <CheckCircle2
                        size={12}
                        style={{
                          color: "var(--figma-green)",
                          flexShrink: 0,
                          marginTop: 2,
                        }}
                      />
                    )}
                    <span>
                      {step.message}
                      {step.detail ? `（${step.detail}）` : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Pending Proposal Preview */}
          {view.preview && <ProposalPreviewCard {...view.preview} />}

          {/* Post-Apply Confirmation & Quick Actions */}
          {view.showApplied && (
            <div className="agent-undo-bar" role="status">
              <span className="agent-undo-msg">
                <Check size={13} />
                {view.episodeSavedNote || "已应用到画布"}
              </span>
              <div className="agent-undo-actions">
                {view.onPromote && (
                  <button
                    type="button"
                    aria-label="沉淀选中模块"
                    data-tip="将选中模块沉淀至组件库，方便后续复用"
                    data-tip-side="top"
                    onClick={view.onPromote}
                  >
                    沉淀为组件
                  </button>
                )}
                {view.onUndo ? (
                  <button type="button" onClick={view.onUndo}>
                    <Undo2 size={12} />
                    撤回
                  </button>
                ) : (
                  <span className="agent-undo-hint">⌘Z 可撤回</span>
                )}
              </div>
            </div>
          )}

          <div ref={view.threadEndRef} />
        </div>
      )}

      {view.error && (
        <p role="alert" className="inline-error">
          {view.error}
        </p>
      )}

      {/* Compact reconnect strip only when mid-chat and disconnected */}
      {!view.isEmptyConversation && view.connection !== "ready" && (
        <div className="agent-reconnect-bar" role="status">
          <span className="agent-reconnect-label">
            <i aria-hidden="true" className="agent-status-dot" />
            {view.connection === "checking"
              ? "正在检测本地服务…"
              : view.connection === "unavailable"
                ? "模型服务暂不可用"
                : "未连接模型"}
          </span>
          {view.connection !== "checking" && (
            <>
              <button type="button" onClick={view.openModelConfig}>
                配置模型
              </button>
              <button
                type="button"
                aria-label="连接模型服务"
                onClick={() => void view.connect()}
              >
                检测连接
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Composer(view: AgentSession["composer"]) {
  return (
    <div className="agent-composer">
      {view.picker && <AgentMentionPopover {...view.picker} />}
      {view.skills && view.skills.length > 0 && (
        <details className="agent-turn-skills">
          <summary>
            本轮技能
            {view.activeSkills.length > 0 && ` · ${view.activeSkills.length}`}
          </summary>
          <div
            className="agent-skill-picker"
            role="group"
            aria-label="选择本轮技能"
          >
            {view.skills.map((skill) => (
              <label
                key={skill.id}
                data-tip={skill.name}
                data-tip-desc={skill.description}
              >
                <input
                  type="checkbox"
                  checked={view.activeSkills.includes(skill.id)}
                  disabled={
                    view.busy ||
                    (view.activeSkills.length >= 16 &&
                      !view.activeSkills.includes(skill.id))
                  }
                  onChange={() => view.toggleSkill(skill.id)}
                />
                {skill.name}
              </label>
            ))}
          </div>
        </details>
      )}
      {view.skillError && (
        <p className="agent-config-error" role="status">
          无法载入本轮技能，可在「设计技能」中重试。
        </p>
      )}

      <div className="agent-composer-box">
        {/* Active context tags — only shown when user set constraints or attached refs */}
        {view.hasContext && (
          <div className="agent-chips-row agent-composer-context">
            {view.mentions.map((m) => (
              <span key={mentionIdentity(m)} className="agent-mention-chip">
                <MentionKindIcon kind={m.kind} />
                <span className="agent-chip-label">@{m.label}</span>
                <button
                  type="button"
                  className="agent-chip-remove"
                  aria-label={`移除引用 ${m.label}`}
                  data-tip="移除引用"
                  data-tip-side="top"
                  onClick={() => view.removeMention(m)}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
            {view.attachments.map((att, idx) => (
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
                  onClick={() => view.removeAttachment(idx)}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
            {view.activeSkills.length > 0 && (
              <div className="agent-chips-inline" aria-label="本轮已选技能">
                {view.activeSkills.map((id) => (
                  <button
                    type="button"
                    key={id}
                    className="agent-skill-badge"
                    aria-label={"移除本轮技能 " + id}
                    data-tip="移除本轮技能"
                    data-tip-side="top"
                    onClick={() => view.toggleSkill(id)}
                  >
                    <BookOpen size={10} />
                    {view.skills?.find((skill) => skill.id === id)?.name ?? id}
                    <X size={10} />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <textarea
          ref={view.composerRef}
          rows={2}
          aria-label="设计需求"
          placeholder={
            view.hasSelection
              ? "告诉 Forma AI 如何调整选中内容…"
              : "描述想设计的页面或交互…"
          }
          value={view.prompt}
          disabled={view.busy}
          onChange={(e) => view.setPrompt(e.target.value)}
          onKeyDown={view.onComposerKeyDown}
        />

        <div className="agent-composer-footer agent-composer-actions">
          <div className="agent-composer-tools">
            <button
              type="button"
              className={`icon-btn icon-btn-sm ${view.mentionOpen ? "active" : ""}`}
              aria-label="引用组件、变量、样式、画板或历史需求"
              aria-expanded={view.mentionOpen}
              data-tip="引用设计元素"
              data-tip-kbd="@"
              data-tip-desc="引用画布中的组件、样式变量或历史设计"
              data-tip-side="top"
              disabled={view.busy}
              onClick={view.toggleMentions}
            >
              <AtSign size={13} />
            </button>

            <button
              type="button"
              className="icon-btn icon-btn-sm"
              aria-label="上传参考图"
              data-tip="添加参考图"
              data-tip-desc={
                view.connection !== "ready"
                  ? "连接支持识图的模型后可上传参考图"
                  : view.supportsVision
                    ? "上传界面截图或草图供 AI 参考（最多 3 张）"
                    : "当前模型未开启识图，可在模型设置中调整"
              }
              data-tip-side="top"
              disabled={
                view.busy ||
                view.connection !== "ready" ||
                !view.supportsVision ||
                view.attachments.length >= 3
              }
              onClick={() => view.fileInputRef.current?.click()}
            >
              <ImagePlus size={13} />
            </button>

            <label
              className="agent-composer-lib-pill"
              data-tip="目标组件库"
              data-tip-side="top"
            >
              <Package size={12} aria-hidden="true" />
              <select
                aria-label="目标组件库"
                value={view.selectedLibraryId}
                disabled={view.busy}
                onChange={(event) => view.chooseLibrary(event.target.value)}
              >
                <option value="">自动匹配</option>
                {view.libraries.map((lib) => (
                  <option key={lib.id} value={lib.id}>
                    {lib.name}
                  </option>
                ))}
              </select>
            </label>

            <input
              ref={view.fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              multiple
              hidden
              onChange={(ev) => {
                void view.handleAddImages(ev.currentTarget.files);
                ev.currentTarget.value = "";
              }}
            />
          </div>

          <div className="agent-composer-submit-group">
            {view.connection === "ready" && view.activeProfile && (
              <div
                className="agent-model-pill"
                data-tip={view.activeModelSummary}
                data-tip-side="top"
              >
                <span
                  className="agent-status-dot is-ready"
                  aria-hidden="true"
                  style={
                    view.profileBadge
                      ? { background: view.profileBadge.accent }
                      : undefined
                  }
                />
                <select
                  aria-label="切换当前模型"
                  value={view.activeProfile.selectedModel}
                  disabled={
                    view.busy ||
                    view.switchingModel ||
                    view.activeProfile.source === "env"
                  }
                  onChange={(ev) =>
                    void view.handleModelSwitch(ev.target.value)
                  }
                >
                  {view.activeModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {compactModelLabel(m.id, m.label)}
                      {m.recommended ? " ★" : ""}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {view.busy ? (
              <button
                type="button"
                className="agent-stop-circle"
                aria-label="停止生成"
                data-tip="停止生成"
                data-tip-side="top"
                onClick={() => view.cancelChat(true)}
              >
                <Square size={10} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                className="agent-send-circle"
                aria-label="生成设计"
                data-tip={
                  view.connection !== "ready"
                    ? "请先连接模型"
                    : view.prompt.trim()
                      ? "发送"
                      : "请输入设计需求"
                }
                data-tip-kbd={view.connection === "ready" ? "↵" : undefined}
                data-tip-side="top"
                disabled={
                  view.lifetimeInvalid ||
                  !view.prompt.trim() ||
                  view.connection !== "ready"
                }
                onClick={view.submit}
              >
                <ArrowUp size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
