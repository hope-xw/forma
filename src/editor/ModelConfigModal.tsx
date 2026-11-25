import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  Cpu,
  ExternalLink,
  Eye,
  EyeOff,
  Lock,
  RefreshCw,
  X,
} from "lucide-react";
import {
  applyCapabilityOverrides,
  inferModelCapabilities,
} from "../agent/capabilities";
import { useModalDialog } from "./useModalDialog";
import {
  FALLBACK_PROVIDERS,
  deleteProviderProfile,
  detectProvider,
  fetchAgentStatus,
  fetchProviders,
  formatCapabilitySourceLabel,
  formatContextWindow,
  formatProtocolLabel,
  formatStructuredOutputLabel,
  guessProviderFromKey,
  providerBadgeStyle,
  refreshProviderProfile,
  saveProviderProfile,
  updateProviderProfile,
  type AgentStatusResponse,
  type DetectProviderResponse,
  type DiscoveredModel,
  type MaskedProviderProfile,
  type ModelCapabilities,
  type ModelCapabilityOverrides,
  type ProviderPresetPublic,
} from "./agent-client";
import "./agent-ui.css";

export interface ModelConfigModalProps {
  open: boolean;
  onClose(): void;
  status: AgentStatusResponse | null;
  onStatusChange(status: AgentStatusResponse): void;
}

function ProviderBadge({ id }: { id: string }) {
  const { accent, monogram } = providerBadgeStyle(id);
  return (
    <span
      className="agent-vendor-badge"
      aria-hidden="true"
      style={{ background: accent }}
    >
      {monogram}
    </span>
  );
}

const sourceDescriptions = {
  "provider-api": "供应商的模型列表返回了能力信息",
  "builtin-catalog": "根据 Forma 内置模型目录识别",
  "user-override": "此模型使用了你保存或选定的能力设置",
  heuristic: "模型缺少完整声明，按模型家族估算",
};

export function CapabilityPills({
  capabilities: c,
  compact = false,
}: {
  capabilities: ModelCapabilities;
  compact?: boolean;
}) {
  const vision = c.supportsVision
    ? compact
      ? "视觉"
      : "视觉识图"
    : c.visionKnown === false
      ? "视觉未声明"
      : "仅文本";
  const source = c.capabilitySource ?? "heuristic";
  return (
    <div className="agent-cap-pills" aria-label="模型能力">
      <span
        className={"agent-cap-pill " + (c.supportsVision ? "is-purple" : "")}
      >
        {vision}
      </span>
      {c.supportsTools !== false && (
        <span className="agent-cap-pill is-blue">
          {compact ? "工具" : "工具调用"}
        </span>
      )}
      {c.isReasoning && (
        <span className="agent-cap-pill is-purple">
          {compact ? "推理" : "深度推理"}
        </span>
      )}
      {!compact && c.supportsStreaming && (
        <span className="agent-cap-pill">流式生成</span>
      )}
      {(!compact || c.structuredOutput !== "prompt_json") && (
        <span className="agent-cap-pill">
          {compact
            ? "结构化"
            : "结构化输出 · " + formatStructuredOutputLabel(c.structuredOutput)}
        </span>
      )}
      <span className="agent-cap-pill">
        上下文 {c.contextKnown === false ? "~" : ""}
        {formatContextWindow(c.maxContextTokens)}
      </span>
      <span
        className="agent-cap-pill agent-cap-source"
        title={sourceDescriptions[source]}
        data-tip={formatCapabilitySourceLabel(source)}
        data-tip-desc={sourceDescriptions[source]}
        data-tip-side="top"
      >
        {formatCapabilitySourceLabel(source)}
      </span>
    </div>
  );
}

function CapabilityFields({
  capabilities,
  overrides,
  onChange,
}: {
  capabilities: ModelCapabilities;
  overrides: ModelCapabilityOverrides;
  onChange(next: ModelCapabilityOverrides): void;
}) {
  const context = overrides.maxContextTokens ?? capabilities.maxContextTokens;
  const windows = Array.from(
    new Set([32000, 64000, 128000, 256000, 1000000, context]),
  ).sort((a, b) => a - b);
  return (
    <div className="agent-cap-fields">
      {(
        [
          ["supportsVision", "支持视觉识图"],
          ["supportsTools", "支持工具调用"],
          ["isReasoning", "深度推理"],
        ] as const
      ).map(([field, label]) => (
        <label key={field}>
          <input
            type="checkbox"
            checked={
              overrides[field] ??
              (field === "supportsTools"
                ? capabilities.supportsTools !== false
                : capabilities[field])
            }
            onChange={(e) =>
              onChange({ ...overrides, [field]: e.target.checked })
            }
          />
          {label}
        </label>
      ))}
      <label>
        上下文窗口
        <select
          aria-label="上下文窗口"
          value={context}
          onChange={(e) =>
            onChange({ ...overrides, maxContextTokens: Number(e.target.value) })
          }
        >
          {windows.map((tokens) => (
            <option key={tokens} value={tokens}>
              {formatContextWindow(tokens)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function ModelOptions({
  models,
  selected,
}: {
  models: DiscoveredModel[];
  selected: string;
}) {
  return (
    <>
      {!models.some((model) => model.id === selected) && (
        <option value={selected}>{selected}</option>
      )}
      {models.map((model) => (
        <option key={model.id} value={model.id}>
          {model.label || model.id}
          {model.recommended ? " ★" : ""}
        </option>
      ))}
    </>
  );
}

type RunAction = (action: (signal: AbortSignal) => Promise<void>) => void;

function ConnectProvider({
  providers,
  selectedId,
  select,
  busy,
  run,
  saved,
}: {
  providers: ProviderPresetPublic[];
  selectedId: string;
  select(id: string): void;
  busy: boolean;
  run: RunAction;
  saved(status: AgentStatusResponse): void;
}) {
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [label, setLabel] = useState("");
  const [preferred, setPreferred] = useState("");
  const [result, setResult] = useState<DetectProviderResponse | null>(null);
  const [model, setModel] = useState("");
  const [manual, setManual] = useState(false);
  const [overrides, setOverrides] = useState<ModelCapabilityOverrides>({});
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    resultRef.current?.scrollIntoView({ block: "nearest" });
  }, [result]);
  const provider = providers.find((p) => p.id === selectedId);
  const guess = guessProviderFromKey(key);
  const conflict =
    selectedId &&
    selectedId !== "custom" &&
    guess.providerId !== selectedId &&
    providers.find((p) => p.id === guess.providerId);
  const custom = selectedId === "custom";
  const valid =
    provider &&
    (!provider.requiresKey || !!key.trim()) &&
    (!custom || !!baseUrl.trim());
  const caps =
    result && model.trim()
      ? (result.models.find((m) => m.id === model.trim())?.capabilities ??
        (result.selectedModel === model.trim()
          ? result.capabilities
          : inferModelCapabilities(selectedId, result.protocol, model.trim())))
      : null;

  function choose(id: string, carryKey = false) {
    if (id === selectedId) return;
    select(id);
    if (!carryKey) setKey("");
    setShowKey(false);
    setBaseUrl("");
    setLabel("");
    setPreferred("");
    setResult(null);
    setOverrides({});
  }
  function changeModel(value: string) {
    setModel(value);
    setOverrides({});
  }
  function detect() {
    if (!valid) return;
    run(async (signal) => {
      setResult(null);
      const next = await detectProvider(
        {
          providerId: selectedId,
          apiKey: key.trim() || undefined,
          baseUrl: baseUrl.trim() || undefined,
          preferredModel: preferred.trim() || undefined,
        },
        signal,
      );
      if (signal.aborted) return;
      changeModel(next.selectedModel);
      setManual(false);
      setResult(next);
    });
  }
  function save() {
    if (!result || !model.trim()) return;
    run(async (signal) => {
      const { status } = await saveProviderProfile(
        {
          providerId: selectedId,
          apiKey: key.trim() || undefined,
          baseUrl: result.baseUrl,
          selectedModel: model.trim(),
          label: label.trim() || undefined,
          capabilityOverrides: Object.keys(overrides).length
            ? overrides
            : undefined,
        },
        signal,
      );
      if (!signal.aborted) saved(status);
    });
  }

  const urlField = (
    <label className="agent-field-label">
      {custom ? "自定义 Base URL" : "自定义 Base URL（可选）"}
      <input
        aria-label="自定义 Base URL"
        type="url"
        placeholder={
          provider?.defaultBaseUrl || "https://gateway.example.com/v1"
        }
        value={baseUrl}
        onChange={(e) => {
          setBaseUrl(e.target.value);
          setResult(null);
        }}
      />
    </label>
  );

  return (
    <>
      <div className="agent-config-body">
        <fieldset className="agent-step" disabled={busy}>
          <legend>第一步 · 选择模型供应商</legend>
          <div className="agent-provider-grid">
            {providers.map((p) => (
              <button
                type="button"
                key={p.id}
                aria-label={p.name}
                aria-pressed={selectedId === p.id}
                title={p.description}
                data-tip={p.name}
                data-tip-desc={p.description}
                data-tip-side="bottom"
                className={
                  "agent-provider-card" +
                  (selectedId === p.id ? " is-selected" : "")
                }
                onClick={() => choose(p.id)}
              >
                <ProviderBadge id={p.id} />
                <span className="agent-provider-card-name">{p.shortName}</span>
              </button>
            ))}
          </div>
        </fieldset>
        {provider ? (
          <fieldset
            key={selectedId}
            className="agent-step agent-credentials"
            disabled={busy}
          >
            <legend>第二步 · 填写连接凭证</legend>
            <div className="agent-key-box">
              <div className="agent-section-label">
                <span className="agent-provider-heading">
                  <ProviderBadge id={selectedId} />
                  {provider.name}
                </span>
                {provider.docsUrl && (
                  <a
                    className="agent-docs-link"
                    href={provider.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {selectedId === "ollama" ? "Ollama 官网" : "获取密钥"}
                    <ExternalLink size={11} />
                  </a>
                )}
              </div>
              {selectedId === "ollama" ? (
                <span>Ollama 本地模型无需 API Key</span>
              ) : (
                <>
                  <label className="agent-field-label" htmlFor="agent-api-key">
                    API Key{custom && "（可选）"}
                  </label>
                  <div className="agent-key-input-wrap">
                    <input
                      id="agent-api-key"
                      aria-label="API Key"
                      type={showKey ? "text" : "password"}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={provider.keyHint}
                      value={key}
                      onChange={(e) => {
                        setKey(e.target.value);
                        setResult(null);
                      }}
                    />
                    <button
                      type="button"
                      className="icon-btn icon-btn-sm agent-key-eye-btn"
                      aria-label={showKey ? "隐藏密钥" : "显示密钥"}
                      title={showKey ? "隐藏密钥" : "显示密钥"}
                      data-tip={showKey ? "隐藏密钥" : "显示密钥"}
                      data-tip-side="top"
                      onClick={() => setShowKey(!showKey)}
                    >
                      {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                  </div>
                  {conflict && (
                    <div role="status" className="agent-key-conflict">
                      <span>该密钥前缀通常用于 {conflict.name}</span>
                      <button
                        type="button"
                        onClick={() => choose(conflict.id, true)}
                      >
                        切换到 {conflict.shortName}
                      </button>
                    </div>
                  )}
                  <span className="agent-trust-note">
                    <Lock size={11} />
                    密钥仅保存在本机模型配置中
                  </span>
                </>
              )}
              {custom && urlField}
            </div>
            <details className="agent-advanced-details">
              <summary>
                <ChevronRight size={13} />
                高级选项
              </summary>
              <div className="agent-advanced-grid">
                {!custom && urlField}
                <label className="agent-field-label">
                  自定义模型 ID（可选）
                  <input
                    placeholder="模型名或接入点 ID"
                    maxLength={200}
                    value={preferred}
                    onChange={(e) => {
                      setPreferred(e.target.value);
                      setResult(null);
                    }}
                  />
                </label>
                <label className="agent-field-label">
                  连接备注名称（可选）
                  <input
                    aria-label="连接备注名称"
                    maxLength={120}
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                  />
                </label>
              </div>
            </details>
          </fieldset>
        ) : (
          <p className="agent-empty-hint">请先在上方选择你的模型供应商</p>
        )}
        {result && (
          <div className="agent-detect-card" ref={resultRef}>
            <div className="agent-detect-head">
              <strong>第三步 · 确认模型与能力</strong>
              <span className="agent-cap-pill is-green">
                已连接 · {formatProtocolLabel(result.protocol)}
              </span>
            </div>
            <div className="agent-detect-meta">
              <code>{result.baseUrl}</code>
              {result.probeNote}
            </div>
            <fieldset className="agent-step" disabled={busy}>
              <label className="agent-checkbox">
                <input
                  type="checkbox"
                  checked={manual}
                  onChange={(e) => {
                    setManual(e.target.checked);
                    if (!e.target.checked) changeModel(result.selectedModel);
                  }}
                />
                手动输入模型 ID
              </label>
              {manual ? (
                <label className="agent-field-label">
                  模型 ID
                  <input
                    value={model}
                    maxLength={200}
                    onChange={(e) => changeModel(e.target.value)}
                  />
                </label>
              ) : (
                <label className="agent-detect-model-row">
                  选用模型
                  <select
                    aria-label="选用模型"
                    value={model}
                    onChange={(e) => changeModel(e.target.value)}
                  >
                    <ModelOptions
                      models={result.models}
                      selected={result.selectedModel}
                    />
                  </select>
                </label>
              )}
              {caps && (
                <>
                  <CapabilityPills
                    capabilities={applyCapabilityOverrides(caps, overrides)}
                  />
                  <details className="agent-advanced-details">
                    <summary>
                      <ChevronRight size={13} />
                      微调模型能力（高级）
                    </summary>
                    <CapabilityFields
                      capabilities={caps}
                      overrides={overrides}
                      onChange={setOverrides}
                    />
                    {Object.keys(overrides).length > 0 && (
                      <button type="button" onClick={() => setOverrides({})}>
                        恢复自动检测
                      </button>
                    )}
                  </details>
                </>
              )}
            </fieldset>
          </div>
        )}
      </div>
      <div className="agent-config-footer agent-connect-footer">
        {result && (
          <button
            type="button"
            className="agent-btn-secondary"
            disabled={busy}
            onClick={detect}
          >
            重新检测
          </button>
        )}
        <button
          type="button"
          className="agent-btn-primary"
          disabled={busy || !valid || (!!result && !model.trim())}
          onClick={result ? save : detect}
        >
          {busy
            ? result
              ? "正在保存…"
              : "正在连接…"
            : result
              ? "保存并启用"
              : "连接并获取模型"}
        </button>
      </div>
    </>
  );
}

function ProfileCard({
  profile,
  active,
  busy,
  run,
  updated,
}: {
  profile: MaskedProviderProfile;
  active: boolean;
  busy: boolean;
  run: RunAction;
  updated(status: AgentStatusResponse, note?: string): void;
}) {
  const { id, providerId, selectedModel, capabilities } = profile;
  const editable = profile.source === "saved";
  const serverOverrides =
    profile.activeModelOverrides ??
    profile.modelOverrides?.[selectedModel] ??
    {};
  const [optimisticOverrides, setOptimisticOverrides] =
    useState<ModelCapabilityOverrides | null>(null);
  useEffect(() => {
    setOptimisticOverrides(null);
  }, [profile.updatedAt, selectedModel]);
  const overrides = optimisticOverrides ?? serverOverrides;
  function patch(
    changes: Parameters<typeof updateProviderProfile>[1],
    nextOptimistic?: ModelCapabilityOverrides | null,
  ) {
    if (nextOptimistic !== undefined) setOptimisticOverrides(nextOptimistic);
    run(async (signal) => {
      try {
        const res = await updateProviderProfile(id, changes, signal);
        if (!signal.aborted) {
          setOptimisticOverrides(null);
          updated(res.status);
        }
      } catch (err) {
        if (!signal.aborted) setOptimisticOverrides(null);
        throw err;
      }
    });
  }
  return (
    <fieldset
      disabled={busy}
      className={"agent-profile-card" + (active ? " is-active" : "")}
    >
      <div className="agent-profile-top">
        <ProviderBadge id={providerId} />
        <div className="agent-profile-name-col">
          <div className="agent-profile-title-line">
            <strong>{profile.label || profile.providerName}</strong>
            {active && (
              <span className="agent-cap-pill is-green">
                <Check size={10} />
                当前使用
              </span>
            )}
            <span className="agent-cap-pill">
              {editable
                ? formatProtocolLabel(profile.protocol)
                : "环境变量 · 只读"}
            </span>
          </div>
          <div className="agent-profile-sub">
            <code>{profile.maskedKey}</code>
            <span>{profile.baseUrl}</span>
          </div>
        </div>
      </div>
      <div className="agent-profile-controls">
        <select
          aria-label={
            "切换 " + (profile.label || profile.providerName) + " 的模型"
          }
          disabled={!editable}
          value={selectedModel}
          onChange={(e) => patch({ selectedModel: e.target.value })}
        >
          <ModelOptions models={profile.models} selected={selectedModel} />
        </select>
        {!active && (
          <button
            type="button"
            className="agent-btn-secondary"
            onClick={() => patch({ activate: true })}
          >
            设为当前
          </button>
        )}
        {editable && (
          <>
            <button
              type="button"
              className="agent-btn-secondary"
              aria-label="刷新模型"
              title="刷新模型"
              data-tip="刷新模型"
              data-tip-desc="重新获取模型列表，保留已保存的能力覆写"
              data-tip-side="top"
              onClick={() =>
                run(async (signal) => {
                  const res = await refreshProviderProfile(id, signal);
                  if (!signal.aborted)
                    updated(res.status, res.probeNote || "模型列表已刷新");
                })
              }
            >
              <RefreshCw size={12} />
              刷新模型
            </button>
            <button
              type="button"
              className="agent-btn-danger"
              aria-label={"删除连接 " + (profile.label || profile.providerName)}
              onClick={() =>
                run(async (signal) => {
                  const res = await deleteProviderProfile(id, signal);
                  if (!signal.aborted) updated(res.status, "已删除连接");
                })
              }
            >
              删除
            </button>
          </>
        )}
      </div>
      <CapabilityPills capabilities={capabilities} />
      {editable && (
        <details className="agent-advanced-details">
          <summary>
            <ChevronRight size={13} />
            调整能力
          </summary>
          <CapabilityFields
            capabilities={capabilities}
            overrides={overrides}
            onChange={(next) =>
              patch({ selectedModel, capabilityOverrides: next }, next)
            }
          />
          <button
            type="button"
            className="agent-reset-caps"
            disabled={!Object.keys(overrides).length}
            onClick={() =>
              patch({ selectedModel, capabilityOverrides: null }, {})
            }
          >
            恢复自动检测
          </button>
        </details>
      )}
    </fieldset>
  );
}

export function ModelConfigModal({ open, ...props }: ModelConfigModalProps) {
  return open ? <ModelDialog {...props} /> : null;
}

function ModelDialog({
  status,
  onClose,
  onStatusChange,
}: Omit<ModelConfigModalProps, "open">) {
  const dialog = useModalDialog(true, onClose);
  const [tab, setTab] = useState<"connect" | "profiles">("connect");
  const [providers, setProviders] = useState(FALLBACK_PROVIDERS);
  const [selectedId, setSelectedId] = useState(
    status?.activeProfile?.providerId ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef<AbortController | null>(null);
  const initialRead = useRef<AbortController | null>(null);
  const notify = useRef(onStatusChange);
  notify.current = onStatusChange;

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void fetchProviders(signal)
      .then((list) => {
        if (!signal.aborted) setProviders(list);
      })
      .catch(() => {});
    const statusRequest = new AbortController();
    initialRead.current = statusRequest;
    void fetchAgentStatus(statusRequest.signal)
      .then((next) => {
        if (statusRequest.signal.aborted) return;
        notify.current(next);
        setSelectedId(
          (current) => current || next.activeProfile?.providerId || "",
        );
      })
      .catch((err) => {
        if (!statusRequest.signal.aborted) setError(err.message);
      });
    return () => {
      controller.abort();
      statusRequest.abort();
      pending.current?.abort();
    };
  }, []);

  const run: RunAction = async (action) => {
    if (pending.current) return;
    initialRead.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action(controller.signal);
    } catch (err) {
      if (!controller.signal.aborted)
        setError(err instanceof Error ? err.message : "请求失败，请重试");
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const profiles = status?.profiles ?? [];
  return (
    <div
      className="agent-config-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-config-title"
        tabIndex={-1}
        className="agent-config-modal"
      >
        <div className="agent-config-head">
          <div className="agent-config-title-wrap">
            <span className="agent-config-icon-ring">
              <Cpu size={15} />
            </span>
            <h2 id="model-config-title">配置 AI 模型服务</h2>
          </div>
          <div
            className="agent-config-tabs"
            role="tablist"
            aria-label="模型配置视图"
          >
            {(["connect", "profiles"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                disabled={busy}
                className={tab === t ? "active" : ""}
                onClick={() => {
                  setTab(t);
                  setError("");
                  setNotice("");
                }}
              >
                {t === "connect" ? "连接供应商" : "已保存连接"}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="关闭模型配置"
            title="关闭模型配置"
            data-tip="关闭模型配置"
            data-tip-side="bottom"
            data-tip-kbd="Esc"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>
        {error && (
          <p className="agent-config-error agent-dialog-feedback" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="agent-dialog-feedback" role="status">
            {notice}
          </p>
        )}
        {tab === "connect" ? (
          <ConnectProvider
            providers={providers}
            selectedId={selectedId}
            select={(id) => {
              setSelectedId(id);
              setError("");
            }}
            busy={busy}
            run={run}
            saved={(next) => {
              onStatusChange(next);
              onClose();
            }}
          />
        ) : (
          <div className="agent-config-body">
            <div className="agent-section-label">
              <span>本机模型连接 · {profiles.length}</span>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                disabled={busy}
                aria-label="刷新模型连接状态"
                title="刷新模型连接状态"
                data-tip="刷新连接列表"
                data-tip-side="left"
                onClick={() =>
                  run(async (signal) => {
                    const next = await fetchAgentStatus(signal);
                    if (!signal.aborted) onStatusChange(next);
                  })
                }
              >
                <RefreshCw size={13} />
              </button>
            </div>
            {!profiles.length && (
              <div className="agent-profiles-empty">
                尚未保存任何模型连接
                <button
                  className="agent-btn-secondary"
                  type="button"
                  onClick={() => setTab("connect")}
                >
                  连接供应商
                </button>
              </div>
            )}
            {profiles.map((profile) => (
              <ProfileCard
                key={profile.id}
                profile={profile}
                active={status?.activeProfileId === profile.id}
                busy={busy}
                run={run}
                updated={(next, note) => {
                  onStatusChange(next);
                  setNotice(note ?? "");
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
