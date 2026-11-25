import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BookOpen, ChevronRight, RefreshCw, X } from "lucide-react";
import {
  deleteSkill,
  fetchSkillDetail,
  fetchSkills,
  importSkill,
  rescanSkills,
  setSkillEnabled,
  updateSkillSettings,
  type ImportSkillPayload,
  type SkillCompatibilityLevel,
  type SkillDetail,
  type SkillsListResponse,
  type SkillSummary,
} from "./agent-client";
import { useModalDialog } from "./useModalDialog";
import "./agent-ui.css";

const example = `---
name: brand-layout-guide
description: 设计品牌页面时检查间距、字号和主按钮层级。
metadata:
  tags: [brand, layout]
---

# 品牌页面排版

优先复用文件中的文字样式和间距变量。
每个画板保留一个主行动按钮，并检查移动端触控区域。
`;

const sourceLabels = {
  builtin: "Forma 内置",
  user: "用户导入",
  workspace: "工作区",
  "external-standard": "外部标准目录",
};
const compatibilityBadges = {
  native: {
    label: "完全兼容",
    color: "is-green",
    description: "Forma 可直接使用技能指令和随附的本地资源。",
  },
  adapted: {
    label: "本地检索适配",
    color: "is-blue",
    description: "Forma 跳过脚本，可直接检索随附的数据表和主题文档。",
  },
  limited: {
    label: "外部依赖受限",
    color: "is-warn",
    description: "Forma 不会自动获取远程规则。请随技能导入本地规则文档。",
  },
} satisfies Record<
  SkillCompatibilityLevel,
  { label: string; color: string; description: string }
>;
const unassessedBadge = {
  label: "兼容性待评估",
  color: "",
  description: "当前服务尚未提供此技能的兼容报告。",
};
type Resource = { path: string; content: string };

function resourceSummary(skill: SkillSummary) {
  const counts = skill.compatibility?.resourceCounts;
  if (!counts || (!counts.markdown && !counts.data))
    return `${skill.resources.length} 份参考资源`;
  return [
    counts.markdown && `${counts.markdown} 份文档`,
    counts.data && `${counts.data} 份数据表`,
    counts.other && `${counts.other} 份其他资源`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function SkillInstructions({ id }: { id: string }) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void fetchSkillDetail(id, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setDetail(data);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message);
      });
    return () => controller.abort();
  }, [id]);
  if (error)
    return (
      <p className="agent-config-error" role="alert">
        {error}
      </p>
    );
  return detail ? (
    <pre className="agent-skill-instructions">{detail.instructions}</pre>
  ) : (
    <span role="status">正在读取指令…</span>
  );
}

function SkillCard({
  skill,
  revision,
  busy,
  toggle,
  remove,
}: {
  skill: SkillSummary;
  revision: number;
  busy: boolean;
  toggle(): void;
  remove(): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { compatibility } = skill;
  const badge =
    (compatibility && compatibilityBadges[compatibility.level]) ??
    unassessedBadge;
  const notes = compatibility?.notes ?? [];
  return (
    <article className="agent-skill-card" aria-label={skill.name}>
      <div className="agent-skill-title">
        <strong>{skill.name}</strong>
        <span className="agent-cap-pill">{sourceLabels[skill.source]}</span>
        <span
          className={`agent-cap-pill ${badge.color}`}
          title={badge.description}
          data-tip={badge.label}
          data-tip-desc={badge.description}
          data-tip-side="top"
          tabIndex={0}
        >
          {badge.label}
        </span>
        <label className="agent-checkbox">
          <input
            type="checkbox"
            role="switch"
            aria-label={"启用 " + skill.name}
            disabled={busy}
            checked={skill.enabled}
            onChange={toggle}
          />
          {skill.enabled ? "已启用" : "已停用"}
        </label>
      </div>
      <p>{skill.description}</p>
      <div className="agent-chips-row">
        {skill.tags.map((tag) => (
          <span className="agent-cap-pill" key={tag}>
            {tag}
          </span>
        ))}
        <span className="agent-skill-meta">{resourceSummary(skill)}</span>
        {skill.hasScripts &&
          !(compatibility?.level === "adapted" && notes.length) && (
            <span className="agent-skill-meta">含脚本，Forma 不执行脚本</span>
          )}
      </div>
      {notes.length > 0 && (
        <ul className="agent-skill-compat-note" aria-label="兼容性说明">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      <div className="agent-skill-actions">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "收起指令" : "查看完整指令"}
        </button>
        {skill.source === "user" && (
          <button
            type="button"
            className="agent-btn-danger"
            disabled={busy}
            onClick={remove}
            aria-label={"删除技能 " + skill.name}
          >
            删除
          </button>
        )}
      </div>
      {expanded && <SkillInstructions key={revision} id={skill.id} />}
    </article>
  );
}

function ImportSkillForm({
  busy,
  submit,
}: {
  busy: boolean;
  submit(payload: ImportSkillPayload): void;
}) {
  const [mode, setMode] = useState<"text" | "path">("text");
  const [markdown, setMarkdown] = useState("");
  const [resources, setResources] = useState<Resource[]>([]);
  const [directory, setDirectory] = useState("");
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  async function readFiles(files: File[], manifest: boolean) {
    if (!files.length) return;
    setReading(true);
    setError("");
    try {
      if (manifest) setMarkdown(await files[0].text());
      else {
        const existing = new Map(resources.map((r) => [r.path, r]));
        for (const file of files) {
          const path = "references/" + file.name;
          existing.set(path, { path, content: await file.text() });
        }
        setResources(Array.from(existing.values()));
      }
    } catch {
      setError("读取文件失败，请重新选择文件");
    } finally {
      setReading(false);
    }
  }
  return (
    <fieldset
      className="agent-step agent-skill-form"
      disabled={reading || busy}
    >
      <div className="agent-import-modes">
        <label>
          <input
            type="radio"
            name="agent-import-method"
            checked={mode === "text"}
            onChange={() => setMode("text")}
          />
          粘贴 / 上传 SKILL.md
        </label>
        <label>
          <input
            type="radio"
            name="agent-import-method"
            checked={mode === "path"}
            onChange={() => setMode("path")}
          />
          从本机文件夹导入
        </label>
      </div>
      {mode === "text" ? (
        <>
          <label className="agent-field-label">
            上传 SKILL.md
            <input
              type="file"
              accept=".md"
              onChange={(e) => {
                void readFiles(Array.from(e.target.files ?? []), true);
                e.target.value = "";
              }}
            />
          </label>
          <label className="agent-field-label">
            SKILL.md 内容
            <textarea
              rows={8}
              spellCheck={false}
              placeholder="粘贴包含 name 和 description 的 SKILL.md"
              value={markdown}
              onChange={(e) => setMarkdown(e.target.value)}
            />
          </label>
          <label className="agent-field-label">
            添加参考文档、数据表或 SVG
            <input
              type="file"
              multiple
              accept=".md,.txt,.json,.csv,.tsv,.svg"
              aria-describedby="agent-skill-upload-help"
              onChange={(e) => {
                void readFiles(Array.from(e.target.files ?? []), false);
                e.target.value = "";
              }}
            />
          </label>
          <p className="agent-skill-meta" id="agent-skill-upload-help">
            支持 MD、TXT、JSON、CSV、TSV 和 SVG。单独上传的附件存入
            references/。要保留原目录，请从本机文件夹导入。
          </p>
          <div className="agent-chips-row">
            {resources.map((resource) => (
              <span key={resource.path} className="agent-mention-chip">
                {resource.path}
                <button
                  type="button"
                  className="agent-chip-remove"
                  aria-label={"移除 " + resource.path}
                  title={"移除 " + resource.path}
                  data-tip="移除参考资源"
                  data-tip-side="top"
                  onClick={() =>
                    setResources(
                      resources.filter((r) => r.path !== resource.path),
                    )
                  }
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        </>
      ) : (
        <label className="agent-field-label">
          本机 Skill 文件夹路径
          <input
            value={directory}
            onChange={(e) => setDirectory(e.target.value)}
            placeholder="/Users/me/skills/brand-layout-guide"
          />
          <span>
            导入后保存在 Forma 用户技能目录（默认 ~/.forma/skills/）。
          </span>
        </label>
      )}
      <p className="agent-skill-meta">
        社区 Skill 文件夹以 SKILL.md 为入口，可附带同级 *.md 文档、references/
        参考资料、themes/ 主题和 data/*.csv 数据表。
      </p>
      {error && (
        <p className="agent-config-error" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        className="agent-btn-primary agent-import-submit"
        disabled={mode === "text" ? !markdown.trim() : !directory.trim()}
        onClick={() =>
          submit(
            mode === "text"
              ? { skillMd: markdown, resources }
              : { localDirPath: directory.trim() },
          )
        }
      >
        {busy ? "正在导入…" : "导入技能"}
      </button>
      <details className="agent-advanced-details">
        <summary>
          <ChevronRight size={13} />
          SKILL.md 格式示例
        </summary>
        <pre className="agent-skill-instructions">{example}</pre>
        <button
          type="button"
          className="agent-btn-secondary"
          onClick={() => {
            setMarkdown(example);
            setMode("text");
          }}
        >
          一键填入示例
        </button>
      </details>
    </fieldset>
  );
}

export function SkillsModal({
  onClose,
  onListChange,
}: {
  onClose(): void;
  onListChange(skills: SkillSummary[]): void;
}) {
  const dialog = useModalDialog(true, onClose);
  const [tab, setTab] = useState<"list" | "import">("list");
  const [data, setData] = useState<SkillsListResponse | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const request = useRef<AbortController | null>(null);
  const notify = useRef(onListChange);
  notify.current = onListChange;
  async function load(
    action: (signal: AbortSignal) => Promise<SkillsListResponse>,
    success?: string,
    optimistic?: (prev: SkillsListResponse) => SkillsListResponse,
  ) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const previous = data;
    if (optimistic && previous) setData(optimistic(previous));
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await action(controller.signal);
      if (controller.signal.aborted) return;
      setData(response);
      notify.current(response.skills);
      setRevision((prev) => prev + 1);
      if (success) {
        setNotice(success);
        setTab("list");
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        if (optimistic && previous) setData(previous);
        setError(err instanceof Error ? err.message : "技能请求失败");
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    void load(fetchSkills);
    return () => request.current?.abort();
  }, []);
  return createPortal(
    <div
      className="agent-config-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        className="agent-config-modal agent-skills-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-skills-title"
        tabIndex={-1}
      >
        <div className="agent-config-head">
          <div className="agent-config-title-wrap">
            <span className="agent-config-icon-ring">
              <BookOpen size={15} />
            </span>
            <h2 id="agent-skills-title">管理设计技能</h2>
          </div>
          <div
            role="tablist"
            aria-label="技能管理视图"
            className="agent-config-tabs"
          >
            {(["list", "import"] as const).map((t) => (
              <button
                type="button"
                key={t}
                role="tab"
                aria-selected={t === tab}
                className={t === tab ? "active" : ""}
                disabled={busy}
                onClick={() => {
                  setTab(t);
                  setError("");
                  setNotice("");
                }}
              >
                {t === "list" ? "已发现技能" : "导入第三方 Skill"}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="关闭技能管理"
            title="关闭技能管理"
            data-tip="关闭技能管理"
            data-tip-kbd="Esc"
            data-tip-side="bottom"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>
        <div className="agent-config-body">
          {error && (
            <p role="alert" className="agent-config-error">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="agent-skill-meta">
              {notice}
            </p>
          )}
          {tab === "list" ? (
            <>
              <div className="agent-skill-settings">
                <label className="agent-checkbox">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={data?.settings.scanExternalStandardDirs ?? false}
                    disabled={busy || !data}
                    onChange={(e) => {
                      const scanExternalStandardDirs = e.target.checked;
                      void load(
                        (signal) =>
                          updateSkillSettings(
                            { scanExternalStandardDirs },
                            signal,
                          ),
                        undefined,
                        (prev) => ({
                          ...prev,
                          settings: {
                            ...prev.settings,
                            scanExternalStandardDirs,
                          },
                        }),
                      );
                    }}
                  />
                  扫描本机通用目录
                </label>
                <button
                  type="button"
                  className="agent-btn-secondary"
                  disabled={busy}
                  onClick={() => void load(rescanSkills, "扫描完成")}
                >
                  <RefreshCw size={12} />
                  重新扫描
                </button>
              </div>
              {data?.settings.externalDirsDetected.length ? (
                <div className="agent-dir-list">
                  {data.settings.externalDirsDetected.map((d) => (
                    <span key={d.dir} className="agent-skill-meta">
                      {d.dir} · {d.exists ? "已找到" : "未找到"}
                    </span>
                  ))}
                </div>
              ) : (
                <span className="agent-skill-meta">
                  ~/.agents / ~/.claude / ~/.codex / ~/.cursor
                </span>
              )}
              {busy && !data && <span role="status">正在读取技能目录…</span>}
              {data && !data.skills.length && (
                <p className="agent-empty-hint">尚未发现技能</p>
              )}
              {data?.skills.map((skill) => (
                <SkillCard
                  key={skill.id}
                  revision={revision}
                  skill={skill}
                  busy={busy}
                  toggle={() => {
                    const nextEnabled = !skill.enabled;
                    void load(
                      (signal) =>
                        setSkillEnabled(skill.id, nextEnabled, signal),
                      undefined,
                      (prev) => ({
                        ...prev,
                        skills: prev.skills.map((item) =>
                          item.id === skill.id
                            ? { ...item, enabled: nextEnabled }
                            : item,
                        ),
                      }),
                    );
                  }}
                  remove={() =>
                    void load(
                      (signal) => deleteSkill(skill.id, signal),
                      "已删除 " + skill.name,
                    )
                  }
                />
              ))}
            </>
          ) : (
            <ImportSkillForm
              busy={busy}
              submit={(payload) =>
                void load(
                  (signal) => importSkill(payload, signal),
                  "技能已导入",
                )
              }
            />
          )}
        </div>
      </div>
    </div>,
    document.querySelector(".app[data-theme]") ?? document.body,
  );
}
