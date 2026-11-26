import type { DesignDocument } from "../domain/document";
import type { AdapterImageAttachment } from "../agent/adapters";
import type {
  AgentMention,
  DesignChatContext,
  ScopeProposal,
} from "../agent/context-builder";
import type { AgentChatResult } from "../agent/design-engine";
import type { HtmlArtboardSpec } from "../agent/html-to-forma";
import {
  episodeIdentityKey,
  type DesignEpisode,
} from "../agent/project-memory";
import type { Transaction } from "../agent/provider";

type GenerationMode = NonNullable<DesignChatContext["generationMode"]>;
type ComposerMention = AgentMention & { identityKey?: string };
interface ComposerInput {
  prompt: string;
  mentions: ComposerMention[];
  attachments?: Required<AdapterImageAttachment>[];
}

interface ScopeMessage {
  id: string;
  scopeProposal?: ScopeProposal;
  scopeConfirmed?: boolean;
  invalidatedReason?: string;
  scopeChoices?: string[];
  scopeRetryInput?: ComposerInput;
  sourcePrompt?: string;
}

export const selectionInvalidation =
  "已选中图层，整页范围规划已失效；请取消选区后重试，或直接发送选区局部修改";

export const staleProposalMessage = "所属项目空间已切换，已丢弃过期提案";
export const scopeVerificationFailed =
  "无法核验当前文件所属项目空间，已丢弃本次结果";
export const staleEpisodeMention =
  "所引用的历史需求档案已变更或删除，请重新选择后再发送";

export function hasAgentSelection(
  selection: string | null,
  selectionCount: number,
) {
  return Boolean(selection || selectionCount > 0);
}

export function findInstalledLibrary(
  libraries: DesignDocument["libraries"],
  id?: string | null,
) {
  return id && libraries && Object.hasOwn(libraries, id)
    ? libraries[id]
    : undefined;
}

export function scopeProblem(
  card: Pick<
    ScopeMessage,
    "scopeProposal" | "scopeConfirmed" | "invalidatedReason"
  >,
  selection: string | null,
  generationMode: GenerationMode,
  libraries: DesignDocument["libraries"],
  selectionCount = 0,
) {
  if (!card.scopeProposal || card.scopeConfirmed) return;
  if (card.invalidatedReason) return card.invalidatedReason;
  if (hasAgentSelection(selection, selectionCount))
    return selectionInvalidation;
  if (generationMode === "html" && card.scopeProposal.screens.length > 8)
    return "新建精细画板单次最多支持 8 张画板，请切换为局部编辑或重新规划范围";
  const target = card.scopeProposal.targetLibraryId;
  if (target && !findInstalledLibrary(libraries, target))
    return "目标组件库已移除，原范围规划已失效";
}

export function chatGeneration(
  hasSelection: boolean,
  generationMode: GenerationMode,
  confirmedScope?: ScopeProposal,
) {
  return hasSelection
    ? { generationMode: "blueprint" as const }
    : { generationMode, confirmedScope };
}

export function composeConfirmedScope(
  scope: ScopeProposal,
  card: Pick<ScopeMessage, "scopeRetryInput" | "sourcePrompt" | "scopeChoices">,
  input: ComposerInput,
  original?: Partial<Pick<ComposerInput, "mentions" | "attachments">>,
) {
  const supplement = input.prompt.trim();
  const previous = card.scopeRetryInput;
  const source = previous?.prompt ?? card.sourcePrompt;
  const instruction =
    supplement || (previous ? "" : "按已确认范围直接生成全部画板。");
  const combined = [source, instruction].filter(Boolean).join("\n\n");
  const seen = new Set<string>();
  const mentions = [
    ...input.mentions,
    ...(previous?.mentions ?? original?.mentions ?? []),
  ].filter((mention) => {
    const key =
      mention.kind === "episode"
        ? `episode:${mention.identityKey ?? mention.id}`
        : `${mention.kind}:${mention.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    prompt:
      combined.length <= 16000 ? combined : supplement || source || instruction,
    confirmedScope: {
      ...scope,
      decisions: scope.decisions?.map((decision, index) => {
        const choice = card.scopeChoices?.[index] ?? decision.defaultChoice;
        if (choice === decision.defaultChoice) return decision;
        return {
          ...decision,
          defaultChoice: choice,
          alternatives: [
            decision.defaultChoice,
            ...(decision.alternatives ?? []),
          ].filter((value) => value !== choice),
        };
      }),
    },
    mentions: mentions.slice(0, 40),
    attachments: [
      ...(input.attachments ?? []),
      ...((previous ?? original)?.attachments ?? []),
    ].slice(0, 4),
  };
}

export function extractCreatedRootIds(tx: Transaction): string[] {
  const ids: string[] = [];
  for (const op of tx.operations) {
    if (op.type === "create" && op.node.parentId === null) {
      ids.push(op.node.id);
    }
  }
  return ids;
}

// Both pickers use the archive identity as the option ID. Resolve the durable
// display ID only when constructing the wire request.
export function capturePickerMention(mention: AgentMention): ComposerMention {
  return mention.kind === "episode"
    ? { ...mention, identityKey: mention.id }
    : mention;
}

export function captureExternalMentions(
  mentions: ComposerMention[],
  displayed: DesignEpisode[],
) {
  const captured: ComposerMention[] = [];
  for (const mention of mentions) {
    if (mention.kind !== "episode" || mention.identityKey !== undefined) {
      captured.push(mention);
      continue;
    }
    const rows = displayed.filter(
      (ep) => episodeIdentityKey(ep) === mention.id,
    );
    if (rows.length !== 1) return null;
    captured.push({ ...mention, identityKey: episodeIdentityKey(rows[0]) });
  }
  return captured;
}

export function buildInvalidatedLibraryScopeMessages<T extends ScopeMessage>(
  messages: T[],
  libraryId: string,
  libraryName: string,
): T[] {
  return messages.map((message) =>
    message.scopeProposal &&
    !message.scopeConfirmed &&
    (message.scopeProposal.targetLibraryId ?? "") !== libraryId
      ? {
          ...message,
          invalidatedReason: `优先组件库已切换为「${libraryName}」，原范围规划已失效`,
        }
      : message,
  );
}

export function buildInvalidatedSelectionScopeMessages<T extends ScopeMessage>(
  messages: T[],
): T[] {
  const pending = (message: T) =>
    message.scopeProposal &&
    !message.scopeConfirmed &&
    !message.invalidatedReason;
  if (!messages.some(pending)) return messages;
  return messages.map((message) =>
    pending(message)
      ? { ...message, invalidatedReason: selectionInvalidation }
      : message,
  );
}

export function applyScopeChoiceToMessages<T extends ScopeMessage>(
  messages: T[],
  messageId: string,
  index: number,
  choice: string,
): T[] {
  return messages.map((message) =>
    message.id === messageId
      ? {
          ...message,
          scopeChoices: message.scopeProposal?.decisions?.map((decision, i) =>
            i === index
              ? choice
              : (message.scopeChoices?.[i] ?? decision.defaultChoice),
          ),
        }
      : message,
  );
}

interface EpisodeContext {
  prompt: string;
  mode: AgentChatResult["mode"];
  confirmedScope?: ScopeProposal;
  targetLibraryId?: string;
  recalledEpisodeIds: string[];
}

export function buildEpisodeMeta(
  {
    prompt,
    mode,
    confirmedScope,
    targetLibraryId,
    recalledEpisodeIds,
  }: EpisodeContext,
  proposal: {
    summary: string;
    createdRootIds: string[];
    transaction: Transaction;
  },
  draft?: { artboards?: Pick<HtmlArtboardSpec, "name" | "refId" | "role">[] },
) {
  const screenRoles: Record<string, NonNullable<HtmlArtboardSpec["role"]>> = {};
  for (const [index, rootId] of proposal.createdRootIds.entries()) {
    const board = draft?.artboards?.[index];
    const op = proposal.transaction.operations.find(
      (op) => op.type === "create" && op.node.id === rootId,
    );
    const name =
      board?.name ?? (op?.type === "create" ? op.node.name : undefined);
    const screen =
      confirmedScope?.screens.find(
        (s) => s.refId === board?.refId || s.name === name,
      ) ?? confirmedScope?.screens[index];
    const role = board?.role ?? screen?.role;
    if (role) screenRoles[rootId] = role;
  }
  return {
    prompt,
    summary: proposal.summary,
    mode: mode === "edit" ? ("edit" as const) : ("generate" as const),
    targetLibraryId,
    decisions: confirmedScope?.decisions?.map((d) => ({
      question: d.question,
      choice: d.defaultChoice,
    })),
    customModules: confirmedScope?.customModules,
    screenRoles,
    recalledEpisodeIds,
  };
}
