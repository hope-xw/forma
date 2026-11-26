import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMention, ScopeProposal } from "../src/agent/context-builder";
import {
  episodeIdentityKey,
  type DesignEpisode,
} from "../src/agent/project-memory";
import type { Transaction } from "../src/agent/provider";
import {
  applyScopeChoiceToMessages,
  buildEpisodeMeta,
  buildInvalidatedLibraryScopeMessages,
  buildInvalidatedSelectionScopeMessages,
  captureExternalMentions,
  capturePickerMention,
  chatGeneration,
  composeConfirmedScope,
  extractCreatedRootIds,
  findInstalledLibrary,
  hasAgentSelection,
  scopeProblem,
  scopeVerificationFailed,
  selectionInvalidation,
  staleEpisodeMention,
  staleProposalMessage,
} from "../src/application/agent-session";
import { createNode } from "../src/domain/document";
import { createLibraryFromSelection } from "../src/domain/library";
import { createStarter } from "../src/domain/seed";

function screen(
  refId: string,
  role: ScopeProposal["screens"][number]["role"] = "primary",
) {
  return {
    refId,
    name: "画板 " + refId,
    role,
    width: 390,
    height: 640,
    summary: refId,
  };
}
const scope: ScopeProposal = {
  summary: "购物流程",
  screens: [
    screen("home"),
    screen("cart", "detail"),
    screen("empty", "exception"),
  ],
  reusedAssets: ["导航"],
  customModules: ["购物车"],
  decisions: [
    {
      question: "首屏？",
      defaultChoice: "活动",
      alternatives: ["推荐", "分类"],
    },
    { question: "导航？", defaultChoice: "底栏", alternatives: ["侧栏"] },
  ],
};
const noInput = { prompt: "", mentions: [] };
const image = (name: string) => ({
  name,
  mimeType: "image/png",
  dataUrl: "data:image/png;base64,YQ==",
});
const mention = (kind: AgentMention["kind"], id: string, label = id) => ({
  kind,
  id,
  label,
});

test("scope eligibility prioritizes explicit invalidation, selection, HTML capacity and target library", () => {
  const doc = createStarter();
  const lib = createLibraryFromSelection(
    doc,
    doc.nodes.find((n) => n.parentId === null)!.id,
    "购物库",
  );
  assert.equal(findInstalledLibrary({ [lib.id]: lib }, lib.id), lib);
  assert.equal(findInstalledLibrary({ [lib.id]: lib }, ""), undefined);
  assert.equal(findInstalledLibrary(undefined, lib.id), undefined);
  assert.equal(findInstalledLibrary({}, "constructor"), undefined);
  const screens = Array.from({ length: 9 }, (_, i) => screen(String(i)));
  const scopeProposal = { ...scope, screens, targetLibraryId: lib.id };
  const card = { scopeProposal };
  assert.equal(
    scopeProblem({ invalidatedReason: "expired" }, "one", "html", {}),
    undefined,
  );
  assert.equal(
    scopeProblem(
      { ...card, scopeConfirmed: true, invalidatedReason: "expired" },
      "one",
      "html",
      {},
    ),
    undefined,
  );
  assert.equal(
    scopeProblem({ ...card, invalidatedReason: "expired" }, "one", "html", {}),
    "expired",
  );
  for (const [selection, count] of [
    ["one", 0],
    [null, 1],
    [null, 2],
  ] as const)
    assert.equal(
      scopeProblem(card, selection, "html", undefined, count),
      selectionInvalidation,
    );
  assert.equal(
    scopeProblem(card, null, "html", undefined),
    "新建精细画板单次最多支持 8 张画板，请切换为局部编辑或重新规划范围",
  );
  for (const mode of ["blueprint", "auto"] as const)
    assert.equal(scopeProblem(card, null, mode, { [lib.id]: lib }), undefined);
  const eight = {
    scopeProposal: { ...scopeProposal, screens: screens.slice(1) },
  };
  assert.equal(scopeProblem(eight, null, "html", { [lib.id]: lib }), undefined);
  for (const libraries of [undefined, {}, Object.create({ [lib.id]: lib })])
    assert.equal(
      scopeProblem(eight, null, "html", libraries),
      "目标组件库已移除，原范围规划已失效",
    );
  assert.equal(
    scopeProblem(
      { scopeProposal: { ...scope, targetLibraryId: "toString" } },
      null,
      "auto",
      {},
    ),
    "目标组件库已移除，原范围规划已失效",
  );
  assert.equal(
    scopeProblem({ scopeProposal: scope }, null, "auto", undefined),
    undefined,
  );
});

test("single and multi-selection force local blueprint generation and omit whole-page confirmation", () => {
  for (const mode of ["auto", "html", "blueprint"] as const) {
    for (const [selection, selectionCount] of [
      ["single", 1],
      [null, 2],
    ] as const) {
      assert.deepEqual(
        chatGeneration(
          hasAgentSelection(selection, selectionCount),
          mode,
          scope,
        ),
        { generationMode: "blueprint" },
      );
    }
    assert.deepEqual(chatGeneration(hasAgentSelection(null, 0), mode, scope), {
      generationMode: mode,
      confirmedScope: scope,
    });
    assert.deepEqual(chatGeneration(false, mode), {
      generationMode: mode,
      confirmedScope: undefined,
    });
  }
});

test("library invalidation rewrites pending cards with a different target, including automatic matching", () => {
  const pending = {
    id: "pending",
    scopeProposal: scope,
    text: "keep",
    invalidatedReason: "earlier reason",
  };
  const target = {
    id: "target",
    scopeProposal: { ...scope, targetLibraryId: "lib" },
  };
  const confirmed = { ...pending, id: "confirmed", scopeConfirmed: true };
  const ordinary = { id: "user" };
  const changed = buildInvalidatedLibraryScopeMessages(
    [ordinary, pending, target, confirmed],
    "lib",
    "购物",
  );
  assert.deepEqual(changed, [
    ordinary,
    {
      ...pending,
      invalidatedReason: "优先组件库已切换为「购物」，原范围规划已失效",
    },
    target,
    confirmed,
  ]);
  assert.equal(changed[2], target);
  assert.equal(changed[3], confirmed);
  assert.equal(pending.invalidatedReason, "earlier reason");
  const auto = buildInvalidatedLibraryScopeMessages(
    [pending, target],
    "",
    "自动匹配",
  );
  assert.equal(auto[0], pending);
  assert.deepEqual(auto[1], {
    ...target,
    invalidatedReason: "优先组件库已切换为「自动匹配」，原范围规划已失效",
  });
});

test("selection invalidation is permanent for pending cards and leaves earlier reasons and confirmed cards intact", () => {
  const card = { id: "scope", scopeProposal: scope };
  const user = { id: "user", scopeProposal: undefined };
  const expired = { ...card, id: "expired", invalidatedReason: "库已移除" };
  const confirmed = { ...card, id: "confirmed", scopeConfirmed: true };
  const cards = [user, expired, card, confirmed];
  const next = buildInvalidatedSelectionScopeMessages(cards);
  assert.deepEqual(next, [
    user,
    expired,
    { ...card, invalidatedReason: selectionInvalidation },
    confirmed,
  ]);
  assert.equal(next[1], expired);
  assert.equal(next[3], confirmed);
  assert.equal(buildInvalidatedSelectionScopeMessages(next), next);
  assert.equal(
    scopeProblem(next[2], null, "auto", undefined),
    selectionInvalidation,
  );
  assert.ok(!Object.hasOwn(card, "invalidatedReason"));
});

test("scope choice updates just the addressed card, preserves earlier choices and fills defaults", () => {
  const card = { id: "scope", scopeProposal: scope, scopeChoices: ["分类"] };
  const other = { ...card, id: "other" };
  const next = applyScopeChoiceToMessages([card, other], "scope", 1, "侧栏");
  assert.deepEqual(next[0].scopeChoices, ["分类", "侧栏"]);
  assert.deepEqual(card.scopeChoices, ["分类"]);
  assert.equal(next[1], other);
  assert.deepEqual(
    applyScopeChoiceToMessages(
      [{ ...card, scopeChoices: [] }],
      "scope",
      0,
      "推荐",
    )[0].scopeChoices,
    ["推荐", "底栏"],
  );
  assert.equal(
    applyScopeChoiceToMessages([card], "absent", 0, "推荐")[0],
    card,
  );
});

test("confirmation promotes the chosen alternative, preserves ordering and leaves the original scope reusable", () => {
  const original = structuredClone(scope);
  const card = { sourcePrompt: "画购物页", scopeChoices: ["推荐"] };
  const result = composeConfirmedScope(scope, card, noInput);
  assert.equal(result.prompt, "画购物页\n\n按已确认范围直接生成全部画板。");
  assert.deepEqual(result.confirmedScope.decisions, [
    {
      question: "首屏？",
      defaultChoice: "推荐",
      alternatives: ["活动", "分类"],
    },
    scope.decisions![1],
  ]);
  assert.equal(result.confirmedScope.decisions?.[1], scope.decisions![1]);
  assert.deepEqual(scope, original);
  assert.equal(
    composeConfirmedScope(scope, card, { ...noInput, prompt: "  加留白  " })
      .prompt,
    "画购物页\n\n加留白",
  );
  assert.equal(
    composeConfirmedScope(scope, {}, { ...noInput, prompt: "只有补充" }).prompt,
    "只有补充",
  );
});

test("retry uses the previous request once, prioritizing newly attached items and supplement", () => {
  const first = composeConfirmedScope(
    scope,
    { sourcePrompt: "原需求" },
    {
      prompt: "第一次补充",
      mentions: [mention("node", "first")],
      attachments: [image("first")],
    },
  );
  const card = { scopeRetryInput: first, sourcePrompt: "旧需求" };
  const original = {
    mentions: [mention("node", "obsolete")],
    attachments: [image("obsolete")],
  };
  assert.deepEqual(
    composeConfirmedScope(scope, card, noInput, original),
    first,
  );
  const extra = composeConfirmedScope(
    scope,
    card,
    {
      prompt: "重试补充",
      mentions: [mention("node", "extra")],
      attachments: [image("extra")],
    },
    original,
  );
  assert.equal(extra.prompt, "原需求\n\n第一次补充\n\n重试补充");
  assert.deepEqual(extra.mentions, [
    mention("node", "extra"),
    mention("node", "first"),
  ]);
  assert.deepEqual(extra.attachments, [image("extra"), image("first")]);
  const exact = "x".repeat(15997);
  assert.equal(
    composeConfirmedScope(
      scope,
      { sourcePrompt: exact },
      { ...noInput, prompt: "a" },
    ).prompt.length,
    16000,
  );
  assert.equal(
    composeConfirmedScope(
      scope,
      { sourcePrompt: exact },
      { ...noInput, prompt: "ab" },
    ).prompt,
    "ab",
  );
  const long = "x".repeat(16000);
  assert.equal(
    composeConfirmedScope(scope, { sourcePrompt: long }, noInput).prompt,
    long,
  );
});

test("mention deduplication uses kind and captured identity, preserving new labels and request limits", () => {
  const current = {
    ...mention("episode", "new", "fresh label"),
    identityKey: "capture-a",
  };
  const another = { ...current, identityKey: "capture-b" };
  const node = mention("node", "new");
  const original = [
    { ...current, id: "old", label: "old label" },
    mention("episode", "capture-a"),
    { ...node, label: "old node" },
    mention("style", "new"),
    ...Array.from({ length: 50 }, (_, i) => mention("component", String(i))),
  ];
  const result = composeConfirmedScope(
    scope,
    {},
    {
      prompt: "go",
      mentions: [current, another, node],
      attachments: [image("new")],
    },
    { mentions: original, attachments: ["a", "b", "c", "d"].map(image) },
  );
  assert.deepEqual(result.mentions.slice(0, 4), [
    current,
    another,
    node,
    mention("style", "new"),
  ]);
  assert.equal(result.mentions.length, 40);
  assert.equal(result.mentions.at(-1)?.id, "35");
  assert.deepEqual(result.attachments, ["new", "a", "b", "c"].map(image));
});

function episode(id: string, captureId: string): DesignEpisode {
  return {
    id,
    captureId,
    snapshotKey: "v2:same-snapshot",
    scopeProjectId: "file:file",
    sourceFileKey: "file",
    sourceFileName: "购物",
    sourceDocId: "doc",
    sourceLifetimeToken: "life",
    userId: "local-default",
    createdAt: "2026-11-26T00:00:00Z",
    updatedAt: "2026-11-26T00:00:00Z",
    title: "需求",
    prompt: "画购物页",
    summary: "初稿",
    mode: "generate",
    screens: [],
    componentsUsed: [],
    customModules: [],
    decisions: [],
    tags: [],
  };
}

test("panel and external pickers capture durable episode identity independently of a renamed row ID", () => {
  const row = episode("display-id", "first");
  const identity = episodeIdentityKey(row);
  const option = mention("episode", identity, "需求");
  const captured = capturePickerMention(option);
  assert.deepEqual(captured, { ...option, identityKey: identity });
  assert.ok(!Object.hasOwn(option, "identityKey"));
  const ordinary = mention("node", row.id);
  assert.equal(capturePickerMention(ordinary), ordinary);
  const moved = { ...row, id: "renamed" };
  assert.deepEqual(captureExternalMentions([ordinary, option], [moved]), [
    ordinary,
    captured,
  ]);
  assert.deepEqual(captureExternalMentions([ordinary, captured], []), [
    ordinary,
    captured,
  ]);
  assert.deepEqual(captureExternalMentions([], []), []);
  assert.equal(
    captureExternalMentions(
      [ordinary, option],
      [episode(row.id, "new-capture")],
    ),
    null,
  );
  assert.equal(captureExternalMentions([option], [row, moved]), null);
  assert.equal(
    captureExternalMentions([mention("episode", row.id)], [row]),
    null,
  );
});

function create(id: string, name: string, parentId: string | null = null) {
  return {
    type: "create" as const,
    node: { ...createNode("frame", parentId), id, name },
  };
}

test("root extraction preserves transaction order while ignoring descendants and all other operation types", () => {
  const tx: Transaction = {
    baseRevision: 3,
    operations: [
      create("b", "第二页"),
      create("child", "子层", "b"),
      { type: "update", id: "existing", patch: { name: "新名字" } },
      {
        type: "insertComponent",
        libraryId: "lib",
        componentId: "button",
        variantId: "default",
        parentId: null,
        position: { x: 0, y: 0 },
      },
      create("a", "首页"),
      { type: "remove", id: "other" },
    ],
  };
  assert.deepEqual(extractCreatedRootIds(tx), ["b", "a"]);
  assert.deepEqual(extractCreatedRootIds({ ...tx, operations: [] }), []);
});

test("episode metadata resolves explicit draft roles, matched ref or name, created node name, then position", () => {
  const confirmedScope = {
    ...scope,
    screens: [
      screen("home"),
      screen("unrelated", "primary"),
      screen("cart", "detail"),
      screen("position", "overlay"),
      screen("empty", "exception"),
    ],
  };
  const roots = ["a", "b", "c", "d", "e", "f"];
  const transaction = {
    baseRevision: 1,
    operations: [
      create("c", "画板 empty"),
      create("b", "node-name"),
      create("a", "home"),
      create("d", "画板 cart"),
      create("e", "unknown"),
      create("f", "unknown"),
    ],
  };
  const context = {
    prompt: "原需求",
    mode: "edit" as const,
    confirmedScope,
    targetLibraryId: "lib",
    recalledEpisodeIds: ["r2", "r1"],
  };
  const proposal = {
    summary: "调整购物页",
    createdRootIds: roots,
    transaction,
  };
  const result = buildEpisodeMeta(context, proposal, {
    artboards: [
      { name: "画板 home", refId: "home", role: "overlay" }, // draft overrides confirmed primary
      { name: "renamed", refId: "cart" }, // ref rather than positional role
      { name: "画板 position" }, // draft name takes precedence over node name
    ],
  });
  assert.deepEqual(result, {
    prompt: "原需求",
    summary: proposal.summary,
    mode: "edit",
    targetLibraryId: "lib",
    decisions: [
      { question: "首屏？", choice: "活动" },
      { question: "导航？", choice: "底栏" },
    ],
    customModules: ["购物车"],
    screenRoles: {
      a: "overlay",
      b: "detail",
      c: "overlay",
      d: "detail",
      e: "exception",
    },
    recalledEpisodeIds: ["r2", "r1"],
  });
  for (const mode of ["generate", "answer", "clarify"] as const) {
    assert.deepEqual(
      buildEpisodeMeta(
        { prompt: "新需求", mode, recalledEpisodeIds: [] },
        proposal,
      ),
      {
        prompt: "新需求",
        summary: proposal.summary,
        mode: "generate",
        targetLibraryId: undefined,
        decisions: undefined,
        customModules: undefined,
        screenRoles: {},
        recalledEpisodeIds: [],
      },
    );
  }
});

test("scope and archive rejection messages retain the established designer-facing copy", () => {
  assert.equal(staleProposalMessage, "所属项目空间已切换，已丢弃过期提案");
  assert.equal(
    selectionInvalidation,
    "已选中图层，整页范围规划已失效；请取消选区后重试，或直接发送选区局部修改",
  );
  assert.equal(
    scopeVerificationFailed,
    "无法核验当前文件所属项目空间，已丢弃本次结果",
  );
  assert.equal(
    staleEpisodeMention,
    "所引用的历史需求档案已变更或删除，请重新选择后再发送",
  );
});
