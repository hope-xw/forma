import { useState } from "react";
import { BookOpen, Download, ScanEye, Settings2, X } from "lucide-react";
import type { DesignDocument } from "../../domain/document";
import { validateProposal, type Transaction } from "../../agent/provider";
import { download } from "../../infrastructure/storage";
import { ExternalAgentSession } from "../ExternalAgentSession";
import type {
  GenerationMode,
  MaskedProviderProfile,
  SkillSummary,
} from "../agent-client";
import { formatTierSummary, GENERATION_MODE_META } from "./agent-copy";

export interface ComposerSettingsPopoverProps {
  open: boolean;
  onClose(): void;
  document: DesignDocument;
  selection: string | null;
  hasSelection: boolean;
  busy: boolean;
  selectedLibraryId: string;
  tiers?: { page: number; block: number; component: number };
  onChangeLibrary(id: string): void;
  generationMode: GenerationMode;
  onChangeGenerationMode(mode: GenerationMode): void;
  supportsVision: boolean;
  visualCritiqueEnabled: boolean;
  onToggleVisualCritique(): void;
  activeProfile: MaskedProviderProfile | null;
  skills: SkillSummary[] | null;
  activeSkills: string[];
  skillError: string;
  onToggleSkill(skillId: string, checked: boolean): void;
  onOpenSkillsManager(): void;
  onOpenModelConfig(): void;
  onReceiveExternalProposal(tx: Transaction): void;
  onImportManualTransaction(tx: Transaction): void;
  onManualImportError(message: string): void;
}

export function ComposerSettingsPopover({
  open,
  onClose,
  document,
  selection,
  hasSelection,
  busy,
  selectedLibraryId,
  tiers,
  onChangeLibrary,
  generationMode,
  onChangeGenerationMode,
  supportsVision,
  visualCritiqueEnabled,
  onToggleVisualCritique,
  activeProfile,
  skills,
  activeSkills,
  skillError,
  onToggleSkill,
  onOpenSkillsManager,
  onOpenModelConfig,
  onReceiveExternalProposal,
  onImportManualTransaction,
  onManualImportError,
}: ComposerSettingsPopoverProps) {
  const [manualInput, setManualInput] = useState("");
  const libraries = Object.values(document.libraries ?? {});

  const critiqueTip = supportsVision
    ? "生成初稿后自动检查排版与细节并精修"
    : "连接支持视觉识别的模型后可开启";

  // Keep mounted with `hidden` when closed so an active ExternalAgentSession
  // MCP pairing survives closing the preferences popover or switching tabs.
  return (
    <div
      className="agent-settings-popover"
      role="dialog"
      aria-label="创作设置"
      data-escape-local="true"
      hidden={!open}
      onKeyDown={(ev) => {
        ev.stopPropagation();
        if (ev.key === "Escape" && !ev.nativeEvent.isComposing) {
          ev.preventDefault();
          onClose();
        }
      }}
    >
      <div className="agent-settings-head">
        <strong>创作设置</strong>
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          aria-label="关闭创作设置"
          data-tip="关闭"
          data-tip-kbd="Esc"
          data-tip-side="top"
          onClick={onClose}
        >
          <X size={12} />
        </button>
      </div>

      <div className="agent-settings-body">
        {/* 1. Target Component Library */}
        <div className="agent-settings-section">
          <label className="agent-settings-field">
            <span className="agent-settings-label">优先使用的组件库</span>
            <select
              aria-label="目标组件库"
              value={selectedLibraryId}
              disabled={busy}
              onChange={(event) => onChangeLibrary(event.target.value)}
            >
              <option value="">自动匹配</option>
              {libraries.map((lib) => (
                <option key={lib.id} value={lib.id}>
                  {lib.name}（{lib.components.length} 组件）
                </option>
              ))}
            </select>
          </label>
          {tiers && (
            <small className="agent-settings-hint">
              {formatTierSummary(tiers)}
            </small>
          )}
        </div>

        {/* 2. Generation Mode */}
        <div className="agent-settings-section">
          <label className="agent-settings-field">
            <span className="agent-settings-label">生成方式</span>
            <select
              className="agent-generation-mode"
              aria-label="生成引擎模式"
              disabled={busy}
              value={generationMode}
              onChange={(ev) =>
                onChangeGenerationMode(ev.target.value as GenerationMode)
              }
            >
              <option value="auto">{GENERATION_MODE_META.auto.label}</option>
              <option value="html">{GENERATION_MODE_META.html.label}</option>
              <option value="blueprint">
                {GENERATION_MODE_META.blueprint.label}
              </option>
            </select>
          </label>
          <small className="agent-settings-hint">
            {hasSelection && generationMode === "html"
              ? "当前已选中图层，将自动对选区执行局部修改"
              : GENERATION_MODE_META[generationMode].description}
          </small>
        </div>

        {/* 3. Visual Polish Toggle */}
        <div className="agent-settings-section">
          <button
            type="button"
            className="agent-critique-row"
            aria-label="视觉自审精修"
            aria-pressed={supportsVision && visualCritiqueEnabled}
            disabled={!supportsVision || busy}
            onClick={onToggleVisualCritique}
          >
            <span className="agent-critique-row-text">
              <strong>
                <ScanEye size={13} aria-hidden="true" />
                生成后自动视觉优化
              </strong>
              <small>{critiqueTip}</small>
            </span>
            <span
              className={`agent-switch-track ${supportsVision && visualCritiqueEnabled ? "is-on" : ""}`}
              aria-hidden="true"
            >
              <span className="agent-switch-thumb" />
            </span>
          </button>
        </div>

        {/* 4. Design Skills */}
        <div className="agent-settings-section">
          <div className="agent-settings-row-head">
            <span className="agent-settings-label">本轮设计技能</span>
            <button
              type="button"
              className="agent-link-btn"
              aria-label="管理设计技能（Skills）"
              onClick={() => {
                onClose();
                onOpenSkillsManager();
              }}
            >
              <BookOpen size={11} />
              管理技能
            </button>
          </div>
          {activeProfile ? (
            <div
              className="agent-skill-picker"
              role="group"
              aria-label="选择本轮技能"
            >
              {skillError ? (
                <p role="alert" className="agent-settings-error">
                  {skillError}
                </p>
              ) : !skills ? (
                <span role="status" className="agent-settings-hint">
                  正在读取已启用技能…
                </span>
              ) : !skills.length ? (
                <span className="agent-settings-hint">
                  暂无启用技能，可点击右上角管理或导入
                </span>
              ) : (
                skills.map((skill) => (
                  <label key={skill.id} title={skill.description}>
                    <input
                      type="checkbox"
                      checked={activeSkills.includes(skill.id)}
                      onChange={(e) =>
                        onToggleSkill(skill.id, e.target.checked)
                      }
                    />
                    <span>{skill.name}</span>
                  </label>
                ))
              )}
            </div>
          ) : (
            <div className="agent-settings-inline-note">
              <span>连接模型后可选用技能</span>
              <button
                type="button"
                className="agent-link-btn"
                onClick={() => {
                  onClose();
                  onOpenModelConfig();
                }}
              >
                <Settings2 size={11} />
                配置模型
              </button>
            </div>
          )}
        </div>

        {/* 5. Developer & External MCP Integration (quietly collapsed) */}
        <details className="agent-external-details">
          <summary>开发者接入（MCP / JSON）</summary>
          <div className="agent-external-body">
            <ExternalAgentSession
              key={document.id}
              document={document}
              selection={selection}
              receive={onReceiveExternalProposal}
            />
            <button
              type="button"
              className="wide"
              onClick={() =>
                download(
                  "agent-context.json",
                  JSON.stringify({ document, selection }, null, 2),
                )
              }
            >
              <Download size={13} />
              导出画布上下文 JSON
            </button>
            <textarea
              aria-label="Agent 事务 JSON"
              value={manualInput}
              onChange={(e) => setManualInput(e.target.value)}
              placeholder={`粘贴设计变更 JSON（当前修订 ${document.revision}）`}
            />
            <button
              type="button"
              className="wide"
              disabled={!manualInput.trim()}
              onClick={() => {
                try {
                  const validated = validateProposal(
                    { prompt: "", document, selection },
                    JSON.parse(manualInput),
                  );
                  onImportManualTransaction(validated);
                  setManualInput("");
                  onClose();
                } catch (e) {
                  onManualImportError(String(e));
                }
              }}
            >
              校验并预览
            </button>
          </div>
        </details>
      </div>
    </div>
  );
}
