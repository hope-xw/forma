import type { AgentProgressStage } from "../../agent/design-engine";
import type { DesignDocument } from "../../domain/document";
import type { PendingAgentProposal } from "../CanvasAgentBar";
import type {
  AgentAttachment,
  AgentChatResult,
  AgentMention,
  GenerationMode,
  RecalledEpisodePayload,
  ScopeProposal,
} from "../agent-client";

export type ComposerMention = AgentMention & { identityKey?: string };

export interface SessionIdentity {
  expectedLifetimeToken?: string;
  expectedDocumentEpoch?: number;
}

export interface ExternalChatRequest {
  id: number;
  pageId: string | undefined;
  scopeProjectId: string;
  prompt: string;
  mentions: ComposerMention[];
  attachments?: { name: string; mimeType: string; dataUrl: string }[];
}

export type ComposerInput = Pick<
  ExternalChatRequest,
  "prompt" | "mentions" | "attachments"
>;

export interface ChatMessage extends Pick<
  AgentChatResult,
  "toolTrace" | "activatedSkills" | "diagnostics" | "critiqueNotes"
> {
  id: string;
  role: "user" | "assistant";
  text: string;
  mentions?: ComposerMention[];
  attachments?: AgentAttachment[];
  summary?: string;
  mode?: AgentChatResult["mode"];
  stats?: AgentChatResult["stats"];
  modelUsed?: string;
  providerName?: string;
  proposalId?: string;
  applied?: boolean;
  discarded?: boolean;
  scopeProposal?: ScopeProposal;
  scopeConfirmed?: boolean;
  scopeChoices?: string[];
  invalidatedReason?: string;
  scopeAttemptId?: string;
  scopeRetryInput?: ComposerInput;
  sourcePrompt?: string;
  sourceMessageId?: string;
  sourceSkills?: string[];
  recalledEpisodes?: RecalledEpisodePayload[];
  recalledEpisodeIds?: string[];
}

export interface AppliedProposalEvent {
  id: number;
  proposal: PendingAgentProposal;
  beforeDoc: DesignDocument;
  afterDoc: DesignDocument;
  scopeProjectId: string;
  fileKey: string;
  archiveNote: Promise<string>;
}

export function mentionIdentity(mention: ComposerMention): string {
  return mention.kind === "episode"
    ? `episode:${mention.identityKey ?? mention.id}`
    : `${mention.kind}:${mention.id}`;
}

export const FIXED_PROGRESS_LABELS: Record<AgentProgressStage, string> = {
  analyzing: "正在理解当前画布与设计规范…",
  planning: "正在构思界面结构与方案…",
  generating: "正在绘制可编辑界面…",
  validating: "正在整理图层与组件结构…",
  repairing: "正在优化视觉排版与细节…",
  done: "即将展示预览…",
};

export const HTML_COMPILE_PROGRESS = "正在整理画板排版与可编辑图层…";
export const VISUAL_CRITIQUE_PROGRESS = "正在检查画面效果并做细节优化…";

export const SCREEN_ROLE_LABELS = {
  primary: "主流程",
  overlay: "浮层",
  exception: "异常态",
  detail: "详情页",
} as const;

export const GENERATION_MODE_META: Record<
  GenerationMode,
  { label: string; shortLabel: string; description: string }
> = {
  auto: {
    label: "自动选择（推荐）",
    shortLabel: "自动",
    description: "新建画板走精细排版，选中图层时自动局部微调",
  },
  html: {
    label: "新建精细画板",
    shortLabel: "精细画板",
    description: "适合从零生成高完成度页面与多屏方案",
  },
  blueprint: {
    label: "结构化局部编辑",
    shortLabel: "局部编辑",
    description: "适合精准调整现有图层、文案与组件属性",
  },
};

export const SELECTION_PROMPTS = [
  "优化留白与视觉层次",
  "整理为自动布局",
  "切换为深色主题风格",
  "补充交互状态与按钮",
];

export const PAGE_PROMPTS = [
  "生成 H5 登录页",
  "生成 SaaS 数据看板",
  "设计电商商品详情卡",
  "生成移动端个人中心",
];

const OPERATION_LABELS: Record<string, string> = {
  create: "新增",
  update: "调整",
  remove: "移除",
  move: "移动",
  reorder: "调整顺序",
  group: "编组",
  ungroup: "解组",
  insertComponent: "插入组件",
  detachInstance: "分离组件实例",
  putLibrary: "更新组件库",
  updateLibrary: "更新组件库",
  removeLibrary: "移除组件库",
  putToken: "更新样式变量",
  removeToken: "移除样式变量",
  putImage: "添加图片素材",
  putFont: "添加字体",
  setPageBackground: "调整页面背景",
  setComments: "更新评审评论",
};

export function formatOperationType(type: string): string {
  return OPERATION_LABELS[type] ?? "变更";
}

const TOOL_LABELS: Record<string, string> = {
  get_canvas_overview: "查看画布概览",
  inspect_node: "查看选中图层详情",
  list_components: "浏览可用组件库",
  list_design_tokens: "读取颜色与排版变量",
  get_library_playbook: "查阅组件库设计说明",
  search_icons: "查找矢量图标",
  search_stock_images: "匹配视觉配图",
  search_skill_resources: "查阅设计参考文档",
  activate_skill: "启用设计技能",
  search_project_episodes: "检索项目历史设计",
  get_episode_details: "读取历史设计详情",
  propose_scope_plan: "规划页面与方案范围",
  propose_html_design: "生成精细画板方案",
  propose_design_changes: "生成画布修改方案",
};

export function formatToolName(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

export function formatTierSummary(tiers: {
  page: number;
  block: number;
  component: number;
}): string {
  const parts: string[] = [];
  if (tiers.page > 0) parts.push(`${tiers.page} 个页面模板`);
  if (tiers.block > 0) parts.push(`${tiers.block} 个模块`);
  if (tiers.component > 0) parts.push(`${tiers.component} 个组件`);
  return parts.length
    ? `规范已就绪 · ${parts.join(" · ")}`
    : "组件库规范已就绪";
}

export function compactModelLabel(modelId: string, label?: string): string {
  const raw = (label || modelId).trim();
  const tail = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  return tail.length > 22 ? `${tail.slice(0, 21)}…` : tail;
}
